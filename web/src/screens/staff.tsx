import { useState } from "preact/hooks";
import { del, get, post, useAction, useLoad } from "../api";
import { fmtDate } from "../format";
import { t } from "../i18n";
import type { Me, PendingInvite, Person } from "../types";
import { Confirm, ErrorNote, Field, Loading } from "../ui";

export function Staff({ me }: { me: Me }) {
  const { data, error, reload } = useLoad(() => get<{ people: Person[]; invites: PendingInvite[] }>("/staff"));
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<Person | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();

  async function send(e: Event) {
    e.preventDefault();
    setNote(null);
    if (await act.run(() => post("/staff/invites", { email, name }))) {
      setNote(t("staff.sent", { email }));
      setEmail("");
      setName("");
    }
    // an invite the mail could not carry is still in the list
    reload();
  }

  async function resend(i: PendingInvite) {
    setNote(null);
    if (await act.run(() => post(`/staff/invites/${i.id}/resend`))) setNote(t("staff.sent", { email: i.email }));
    reload();
  }

  async function revoke(i: PendingInvite) {
    setNote(null);
    if (await act.run(() => del(`/staff/invites/${i.id}`))) reload();
  }

  async function remove() {
    if (await act.run(() => del(`/staff/${removing!.id}`))) {
      setRemoving(null);
      reload();
    }
  }

  return (
    <section class="narrow-form">
      <h2>{t("staff.title")}</h2>
      <p class="muted">{t("staff.hint")}</p>
      {!data ? (
        error ? <ErrorNote error={error} /> : <Loading />
      ) : (
        <>
          <ul class="files">
            {data.people.map((p) => (
              <li key={p.id}>
                <span>
                  <strong>{p.name ?? p.email}</strong>{" "}
                  <span class="muted">
                    {p.name ? `${p.email}, ` : ""}
                    {t(`staff.role_${p.role}`)}, {t("staff.joined", { date: fmtDate(p.created_at) })}
                  </span>
                </span>
                {p.id !== me.user.id && (
                  <button class="small" disabled={act.busy} onClick={() => setRemoving(p)}>
                    {t("staff.remove")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {data.invites.length > 0 && (
            <>
              <h3>{t("staff.pending")}</h3>
              <ul class="files">
                {data.invites.map((i) => (
                  <li key={i.id}>
                    <span>
                      <strong>{i.email}</strong>{" "}
                      <span class="muted">
                        {t("staff.sent_on", { date: fmtDate(i.created_at) })}, {i.expires_at < Date.now() ? t("staff.expired") : t("staff.expires", { date: fmtDate(i.expires_at) })}
                      </span>
                    </span>
                    <span class="actions">
                      <button class="small" disabled={act.busy} onClick={() => resend(i)}>
                        {t("staff.resend")}
                      </button>
                      <button class="small" disabled={act.busy} onClick={() => revoke(i)}>
                        {t("staff.revoke")}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <form onSubmit={send}>
            <h3>{t("staff.invite")}</h3>
            <Field label={t("staff.email")}>
              <input type="email" required maxLength={254} value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
            </Field>
            <Field label={t("staff.name")} hint={t("staff.name_hint")}>
              <input maxLength={120} value={name} onInput={(e) => setName(e.currentTarget.value)} />
            </Field>
            {!removing && <ErrorNote error={act.error} />}
            {note && <p class="ok">{note}</p>}
            <button class="primary" disabled={act.busy}>
              {t("staff.send")}
            </button>
          </form>
        </>
      )}
      {removing && (
        <Confirm
          title={t("staff.remove_title", { who: removing.name ?? removing.email })}
          body={t("staff.remove_body")}
          confirm={t("staff.remove")}
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
