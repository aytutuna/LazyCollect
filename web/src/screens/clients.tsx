import { useState } from "preact/hooks";
import { del, get, patch, post, useAction, useLoad } from "../api";
import { t } from "../i18n";
import type { Client } from "../types";
import { Check, Confirm, ErrorNote, Field, Loading } from "../ui";

export function ClientForm({ client, onSaved, onCancel }: { client?: Client; onSaved: (c: Client) => void; onCancel: () => void }) {
  const initialOk = !!(client && (client.email_ok_at || client.sms_ok_at));
  const [name, setName] = useState(client?.name ?? "");
  const [email, setEmail] = useState(client?.email ?? "");
  const [phone, setPhone] = useState(client?.phone ?? "");
  const [ok, setOk] = useState(initialOk);
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    await run(async () => {
      const body: Record<string, unknown> = { name, email, phone };
      if (!client) {
        body.contact_ok = ok;
        onSaved(await post<Client>("/clients", body));
        return;
      }
      // a changed address is cleared by the server unless it is attested again
      const changed = email.trim() !== (client.email ?? "") || phone.trim() !== (client.phone ?? "");
      if (ok !== initialOk || (ok && changed)) body.contact_ok = ok;
      onSaved(await patch<Client>(`/clients/${client.id}`, body));
    });
  }

  return (
    <form class="panel" onSubmit={submit}>
      <h2>{client ? t("clients.edit") : t("clients.add")}</h2>
      <Field label={t("clients.name")}>
        <input required maxLength={200} value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
      <Field label={t("clients.email")}>
        <input type="email" maxLength={254} autoComplete="off" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
      </Field>
      <Field label={t("clients.phone")}>
        <input type="tel" maxLength={40} autoComplete="off" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} />
      </Field>
      <Check label={t("clients.permission")} checked={ok} required={!client} onChange={setOk} />
      <ErrorNote error={error} />
      <div class="actions">
        <button class="primary" disabled={busy}>
          {t("save")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

export function Clients() {
  const { data, error, reload } = useLoad(() => get<Client[]>("/clients"));
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState<Client | null>(null);
  const remove = useAction();

  const done = () => {
    setEditing(null);
    reload();
  };

  async function confirmDelete() {
    if (asking && (await remove.run(() => del(`/clients/${asking.id}`)))) {
      setAsking(null);
      reload();
    }
  }

  return (
    <>
      <div class="head">
        <h1>{t("clients.title")}</h1>
        <button class="primary" onClick={() => setEditing("new")}>
          {t("clients.add")}
        </button>
      </div>
      <ErrorNote error={error} />
      {editing === "new" && <ClientForm onSaved={done} onCancel={() => setEditing(null)} />}
      {!data ? (
        !error && <Loading />
      ) : data.length === 0 && editing !== "new" ? (
        <div class="empty">
          <h2>{t("clients.empty_title")}</h2>
          <p class="muted">{t("clients.empty_body")}</p>
        </div>
      ) : (
        data.length > 0 && (
          <table class="stack">
            <thead>
              <tr>
                <th>{t("clients.name")}</th>
                <th class="wide">{t("clients.email")}</th>
                <th class="wide">{t("clients.phone")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((c) =>
                editing === c.id ? (
                  <tr>
                    <td colSpan={5}>
                      <ClientForm client={c} onSaved={done} onCancel={() => setEditing(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr>
                    <td class="name">{c.name}</td>
                    <td class="wide">{c.email ?? "-"}</td>
                    <td class="wide">{c.phone ?? "-"}</td>
                    <td class="narrow muted">{[c.email, c.phone].filter(Boolean).join(" · ")}</td>
                    <td class="end">
                      <div class="row-actions">
                        <button class="small" onClick={() => setEditing(c.id)}>
                          {t("edit")}
                        </button>
                        <button class="small quiet" onClick={() => setAsking(c)}>
                          {t("delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )
      )}
      {asking && (
        <Confirm
          title={t("clients.delete_title", { name: asking.name })}
          body={t("clients.delete_body")}
          confirm={t("clients.delete")}
          danger
          busy={remove.busy}
          error={remove.error}
          onConfirm={confirmDelete}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  );
}
