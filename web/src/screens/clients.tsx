import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { del, patch, post, useAction } from "../api";
import { t } from "../i18n";
import { usePaged, useSearchBox, useUrlParams } from "../paged";
import type { Client, ClientRow } from "../types";
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
  const { params, set } = useUrlParams();
  const q = params.get("q") ?? "";
  const [typed, type] = useSearchBox(q, (v) => set({ q: v }, true));
  const list = usePaged<ClientRow>("/clients/search", q ? `q=${encodeURIComponent(q)}` : "");
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState<ClientRow | null>(null);
  const remove = useAction();

  const done = () => {
    setEditing(null);
    list.reload();
  };

  async function confirmDelete() {
    if (asking && (await remove.run(() => del(`/clients/${asking.id}`)))) {
      setAsking(null);
      list.reload();
    }
  }

  const count = (c: ClientRow) => (c.requests ? t("clients.requests", { n: c.requests }) : t("clients.no_requests"));
  const empty = !list.loading && list.rows.length === 0;

  return (
    <>
      <div class="head">
        <h1>{t("clients.title")}</h1>
        <button class="primary" onClick={() => setEditing("new")}>
          {t("clients.add")}
        </button>
      </div>
      <ErrorNote error={list.error} />
      {editing === "new" && <ClientForm onSaved={done} onCancel={() => setEditing(null)} />}
      {(q || list.rows.length > 0 || list.loading) && (
        <div class="filters">
          <Field label={t("clients.search")}>
            <input type="search" value={typed} maxLength={100} onInput={(e) => type(e.currentTarget.value)} />
          </Field>
        </div>
      )}
      {list.loading && list.rows.length === 0 ? (
        !list.error && <Loading />
      ) : empty && !q && editing !== "new" ? (
        <div class="empty">
          <h2>{t("clients.empty_title")}</h2>
          <p class="muted">{t("clients.empty_body")}</p>
        </div>
      ) : empty && q ? (
        <p class="muted">{t("clients.none_match")}</p>
      ) : (
        list.rows.length > 0 && (
          <div aria-busy={list.loading}>
            <table class={`stack${list.loading ? " busy" : ""}`}>
              <thead>
                <tr>
                  <th>{t("clients.name")}</th>
                  <th class="wide">{t("clients.email")}</th>
                  <th class="wide">{t("clients.phone")}</th>
                  <th class="wide">{t("nav.requests")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.rows.map((c) =>
                  editing === c.id ? (
                    <tr key={c.id}>
                      <td colSpan={5}>
                        <ClientForm client={c} onSaved={done} onCancel={() => setEditing(null)} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td class="name">
                        {c.name}
                        {c.email_stop_at && <div class="muted">{t("clients.unsubscribed")}</div>}
                      </td>
                      <td class="wide">{c.email ?? "-"}</td>
                      <td class="wide">{c.phone ?? "-"}</td>
                      <td class="wide">{c.requests ? <Link href={`/?view=all&client=${c.id}`}>{count(c)}</Link> : <span class="muted">{count(c)}</span>}</td>
                      <td class="narrow muted">
                        {[c.email, c.phone].filter(Boolean).join(" · ")}
                        {c.requests > 0 && (
                          <div>
                            <Link href={`/?view=all&client=${c.id}`}>{count(c)}</Link>
                          </div>
                        )}
                      </td>
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
            {list.next !== null && (
              <>
                <ErrorNote error={list.more.error} />
                <button disabled={list.more.busy} onClick={list.loadMore}>
                  {list.more.busy ? t("loading") : t("more")}
                </button>
              </>
            )}
          </div>
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
