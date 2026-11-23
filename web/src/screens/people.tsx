import { useState } from "preact/hooks";
import { del, patch, post, useAction } from "../api";
import { fmtDate } from "../format";
import { t } from "../i18n";
import { roleName } from "../people";
import type { Applicant, ItemWithFiles, RequestDetail, Role } from "../types";
import { Confirm, ErrorNote, Field } from "../ui";

const ROLES: Role[] = ["principal", "spouse", "child", "other"];

export type Draft = { role: Role; name: string; dob: string };

export const newDraft = (role: Role = "other", name = ""): Draft => ({ role, name, dob: "" });

export const toPeople = (drafts: Draft[]) => drafts.filter((d) => d.name.trim()).map((d) => ({ role: d.role, name: d.name.trim(), ...(d.dob ? { dob: d.dob } : {}) }));

// the fields of one person; used to add, to change, and for the list a new request starts with
export function PersonFields({ value, onChange }: { value: Draft; onChange: (v: Draft) => void }) {
  return (
    <>
      <Field label={t("people.name")}>
        <input required maxLength={100} value={value.name} onInput={(e) => onChange({ ...value, name: e.currentTarget.value })} />
      </Field>
      <Field label={t("people.role")}>
        <select value={value.role} onChange={(e) => onChange({ ...value, role: e.currentTarget.value as Role })}>
          {ROLES.map((r) => (
            <option value={r}>{roleName(r)}</option>
          ))}
        </select>
      </Field>
      <Field label={t("people.dob")} hint={t("people.dob_hint")}>
        <input type="date" min="1900-01-01" max="2100-12-31" value={value.dob} onInput={(e) => onChange({ ...value, dob: e.currentTarget.value })} />
      </Field>
    </>
  );
}

// the people a new request is for, before it is made
export function PeopleDrafts({ drafts, onChange }: { drafts: Draft[]; onChange: (d: Draft[]) => void }) {
  return (
    <div>
      {drafts.map((d, at) => (
        <div class="editor-row" key={at}>
          <PersonFields value={d} onChange={(v) => onChange(drafts.map((x, i) => (i === at ? v : x)))} />
          <div class="row-actions">
            <button type="button" class="small quiet" onClick={() => onChange(drafts.filter((_, i) => i !== at))}>
              {t("people.remove")}
            </button>
          </div>
        </div>
      ))}
      {drafts.length < 12 && (
        <button type="button" onClick={() => onChange([...drafts, newDraft(drafts.length ? "other" : "principal")])}>
          {t("people.add")}
        </button>
      )}
    </div>
  );
}

const done = (i: ItemWithFiles) => i.status === "submitted" || i.status === "approved" || i.status === "waived";

function PersonForm({ requestId, person, onSaved, onCancel }: { requestId: string; person?: Applicant; onSaved: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(person ? { role: person.role, name: person.name, dob: person.dob ?? "" } : newDraft("spouse"));
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    const body = { role: draft.role, name: draft.name.trim(), dob: draft.dob || null };
    if (await run(() => (person ? patch(`/requests/${requestId}/people/${person.id}`, body) : post(`/requests/${requestId}/people`, body)))) onSaved();
  }

  return (
    <form class="editor-row" onSubmit={submit}>
      <PersonFields value={draft} onChange={setDraft} />
      {person && <p class="muted">{t("people.edit_note")}</p>}
      <ErrorNote error={error} />
      <div class="row-actions">
        <button class="primary small" disabled={busy}>
          {person ? t("save") : t("people.save")}
        </button>
        <button type="button" class="small" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

// who the request is about, how far each has got, and where they are added, changed and removed
export function PeopleSection({ req, editable, onChange }: { req: RequestDetail; editable: boolean; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Applicant | null>(null);
  const act = useAction();
  if (!editable && req.people.length === 0) return null;

  const mine = (p: Applicant) => req.items.filter((i) => i.person_pos === p.position);
  const held = removing ? mine(removing).filter((i) => i.status !== "empty" || i.files.length > 0).length : 0;
  const saved = () => {
    setAdding(false);
    setEditing(null);
    onChange();
  };

  async function remove(p: Applicant) {
    if (await act.run(() => del(`/requests/${req.id}/people/${p.id}?confirm=1`))) {
      setRemoving(null);
      onChange();
    }
  }

  return (
    <section>
      <h2>{t("people.title")}</h2>
      {req.people.length === 0 && <p class="muted">{t("people.none")}</p>}
      {req.people.length === 0 && req.per_person_items > 0 && <p class="muted">{t("people.waiting")}</p>}
      <ul class="items">
        {req.people.map((p) => {
          const shown = mine(p).filter((i) => !i.hidden);
          return (
            <li key={p.id}>
              <div class="main">
                {editing === p.id ? (
                  <PersonForm requestId={req.id} person={p} onSaved={saved} onCancel={() => setEditing(null)} />
                ) : (
                  <>
                    <div class="line">
                      <strong>{p.name}</strong>
                      <span class="muted">{roleName(p.role)}</span>
                    </div>
                    {p.dob && <div class="muted">{t("people.dob")}: {fmtDate(Date.parse(`${p.dob}T12:00:00Z`))}</div>}
                    <div class="muted">{t("people.progress", { role: roleName(p.role), done: shown.filter(done).length, total: shown.length })}</div>
                    {editable && (
                      <div class="row-actions">
                        <button class="small" onClick={() => setEditing(p.id)}>
                          {t("edit")}
                        </button>
                        <button class="small quiet" onClick={() => setRemoving(p)}>
                          {t("people.remove")}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {editable && (adding ? <PersonForm requestId={req.id} onSaved={saved} onCancel={() => setAdding(false)} /> : req.people.length < 12 && <button onClick={() => setAdding(true)}>{t("people.add")}</button>)}
      {removing && (
        <Confirm
          title={t("people.remove_title", { name: removing.name })}
          body={held ? `${t("people.remove_body")} ${t("people.remove_data", { n: held })}` : t("people.remove_body")}
          confirm={t("people.remove")}
          danger
          busy={act.busy}
          error={act.error}
          onConfirm={() => remove(removing)}
          onCancel={() => {
            setRemoving(null);
            act.reset();
          }}
        />
      )}
    </section>
  );
}
