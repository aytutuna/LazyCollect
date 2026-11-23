import { useState } from "preact/hooks";
import { del, get, post, put, useAction, useLoad } from "../api";
import { fmtDate, fmtDateTime } from "../format";
import { t } from "../i18n";
import { createPasskey, passkeyFail, passkeysSupported } from "../passkey";
import type { Me, PasskeyRow, SessionRow } from "../types";
import { Badge, Check, Confirm, ErrorNote, Field, Loading } from "../ui";

type Policy = { require_passkeys: boolean; without: { id: string; email: string; name: string | null }[] };

type Keys = { required: boolean; passkeys: PasskeyRow[] };

function Passkeys({ data, error, onChange }: { data?: Keys; error?: unknown; onChange: () => void }) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const act = useAction();
  const supported = passkeysSupported();

  async function add(e: Event) {
    e.preventDefault();
    setFailed(null);
    setAdding(true);
    try {
      const options = await post<any>("/passkeys/options");
      const response = await createPasskey(options);
      await post("/passkeys", { response, name: name.trim() });
      setName("");
      onChange();
    } catch (err) {
      setFailed(passkeyFail(err));
    }
    setAdding(false);
  }

  async function remove() {
    if (await act.run(() => del(`/passkeys/${removing!.id}`))) {
      setRemoving(null);
      onChange();
    }
  }

  return (
    <section class="narrow-form">
      <h3>{t("security.passkeys")}</h3>
      {!data ? (
        error ? <ErrorNote error={error} /> : <Loading />
      ) : (
        <>
          {data.passkeys.length === 0 ? (
            <p class="muted">{t("security.passkeys_none")}</p>
          ) : (
            <ul class="files stack">
              {data.passkeys.map((p) => (
                <li key={p.id}>
                  <span>
                    <strong>{p.name}</strong>{" "}
                    <span class="muted">
                      {t("security.passkey_added", { date: fmtDate(p.created_at) })},{" "}
                      {p.last_used_at ? t("security.passkey_used", { date: fmtDate(p.last_used_at) }) : t("security.passkey_unused")}
                    </span>
                  </span>
                  <button class="small" onClick={() => setRemoving(p)}>
                    {t("security.passkey_remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data.required && data.passkeys.length === 1 && <p class="muted">{t("security.passkey_last")}</p>}
          {data.required && <p class="muted">{t("security.lost")}</p>}
          {!supported ? (
            <p class="error" role="alert">
              {t("passkey.unsupported")}
            </p>
          ) : (
            <form onSubmit={add}>
              <Field label={t("passkey.name")} hint={t("passkey.name_hint")}>
                <input maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} />
              </Field>
              {failed && (
                <p class="error" role="alert">
                  {failed}
                </p>
              )}
              <button class="primary" disabled={adding}>
                {t("security.passkey_add")}
              </button>
            </form>
          )}
        </>
      )}
      {removing && (
        <Confirm
          title={t("security.passkey_remove_title", { name: removing.name })}
          body={t("security.passkey_remove_body")}
          confirm={t("security.passkey_remove")}
          danger
          busy={act.busy}
          error={act.error}
          onConfirm={remove}
          onCancel={() => {
            setRemoving(null);
            act.reset();
          }}
        />
      )}
    </section>
  );
}

function Requirement({ mine, round, onChange }: { mine?: Keys; round: number; onChange: () => void }) {
  const { data, error } = useLoad(() => get<Policy>("/security/policy"), [round]);
  const act = useAction();

  async function toggle(on: boolean) {
    if (await act.run(() => put("/security/policy", { require_passkeys: on }))) onChange();
  }

  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  const needOwnKey = !data.require_passkeys && mine !== undefined && mine.passkeys.length === 0;
  return (
    <section class="narrow-form">
      <Check label={t("security.require")} checked={data.require_passkeys} disabled={act.busy || needOwnKey} onChange={toggle} />
      <p class="muted">{needOwnKey ? t("security.require_need") : t("security.require_hint")}</p>
      <p class="muted">
        {data.without.length ? t("security.without", { list: data.without.map((u) => u.name ?? u.email).join(", ") }) : t("security.without_none")}
      </p>
      <ErrorNote error={act.error} />
    </section>
  );
}

function Devices() {
  const { data, error, reload } = useLoad(() => get<SessionRow[]>("/sessions"));
  const act = useAction();

  async function end(id: string) {
    if (await act.run(() => del(`/sessions/${id}`))) reload();
  }

  async function endOthers() {
    if (await act.run(() => post("/sessions/end-others"))) reload();
  }

  return (
    <section class="narrow-form">
      <h3>{t("security.devices")}</h3>
      {!data ? (
        error ? <ErrorNote error={error} /> : <Loading />
      ) : (
        <>
          <ul class="files stack">
            {data.map((s, i) => (
              <li key={s.id ?? i}>
                <span>
                  <strong>{s.label ?? t("security.device_unknown")}</strong> {s.current && <Badge tone="teal">{t("security.this_device")}</Badge>}
                  <br />
                  <span class="muted">{t("security.device_times", { created: fmtDateTime(s.created_at), seen: fmtDateTime(s.last_seen_at) })}</span>
                </span>
                {!s.current && s.id && (
                  <button class="small" disabled={act.busy} onClick={() => end(s.id!)}>
                    {t("security.signout")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <ErrorNote error={act.error} />
          {data.length > 1 && (
            <button disabled={act.busy} onClick={endOthers}>
              {t("security.signout_others")}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function Security({ me }: { me: Me }) {
  const keys = useLoad(() => get<Keys>("/passkeys"));
  // the requirement box depends on the passkeys, so it loads again with them
  const [round, setRound] = useState(0);
  const changed = () => {
    keys.reload();
    setRound((n) => n + 1);
  };
  return (
    <section>
      <h2>{t("security.title")}</h2>
      <p class="muted">{t("security.intro")}</p>
      <Passkeys data={keys.data} error={keys.error} onChange={changed} />
      {me.user.role === "owner" && <Requirement mine={keys.data} round={round} onChange={changed} />}
      <Devices />
    </section>
  );
}
