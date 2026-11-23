import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { post, useAction } from "../api";
import { parseCsv } from "../csv";
import { t } from "../i18n";
import type { ImportResult } from "../types";
import { Badge, Check, ErrorNote, Field } from "../ui";

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 2000;
const CHUNK = 200;
const SHOWN = 100;

const FIELDS = ["name", "email", "phone", "reference"] as const;
type FieldName = (typeof FIELDS)[number];
type Mapping = Record<FieldName, number>;
type Rec = Record<FieldName, string> & { line: number };
type Verdict = { status: "new" | "update" | "skip"; reason?: string };

const GUESS: Record<FieldName, RegExp> = {
  email: /e-?mail|courriel/i,
  phone: /phone|tel|mobile|cell/i,
  reference: /ref|file|number|account|\bno\b|\bid\b/i,
  name: /name|client|nom/i,
};

function guess(header: string[]): Mapping {
  const taken = new Set<number>();
  const found: Mapping = { name: -1, email: -1, phone: -1, reference: -1 };
  for (const f of ["email", "phone", "reference", "name"] as const) {
    const at = header.findIndex((h, i) => !taken.has(i) && GUESS[f].test(h));
    if (at >= 0) {
      found[f] = at;
      taken.add(at);
    }
  }
  if (found.name < 0 && !taken.has(0)) found.name = 0;
  return found;
}

// the same key the server uses, so a repeat inside the file is caught before it is sent
const keyOf = (r: Rec) => (r.email.trim() ? `e:${r.email.trim().toLowerCase()}` : `n:${r.name.trim().toLowerCase()}|${r.reference.trim()}`);

export function ImportClients() {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [header, setHeader] = useState(true);
  const [map, setMap] = useState<Mapping>({ name: -1, email: -1, phone: -1, reference: -1 });
  const [problem, setProblem] = useState<string | null>(null);
  const [records, setRecords] = useState<Rec[]>([]);
  const [verdicts, setVerdicts] = useState<Verdict[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [show, setShow] = useState("all");
  const [done, setDone] = useState<{ added: number; updated: number; skipped: number } | null>(null);
  const check = useAction();
  const commit = useAction();

  async function pick(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    setProblem(null);
    setRows(null);
    setVerdicts(null);
    if (!file) return;
    if (file.size > MAX_BYTES) return setProblem(t("import.too_big"));
    let parsed: string[][];
    try {
      parsed = parseCsv(await file.text());
    } catch {
      return setProblem(t("import.unreadable"));
    }
    if (!parsed.length) return setProblem(t("import.empty"));
    if (parsed.length - 1 > MAX_ROWS) return setProblem(t("import.too_many"));
    setRows(parsed);
    setHeader(true);
    setMap(guess(parsed[0]));
  }

  const body = rows ? (header ? rows.slice(1) : rows) : [];
  const columns = rows ? Math.max(...rows.slice(0, 50).map((r) => r.length)) : 0;
  const label = (i: number) => (header && rows?.[0][i]?.trim() ? rows[0][i].trim() : t("import.column", { n: i + 1 }));

  function toggleHeader(on: boolean) {
    setHeader(on);
    if (rows) setMap(guess(on ? rows[0] : []));
  }

  async function preview() {
    const cell = (r: string[], f: FieldName) => (map[f] >= 0 ? (r[map[f]] ?? "").trim() : "");
    const recs: Rec[] = body.map((r, i) => ({ name: cell(r, "name"), email: cell(r, "email"), phone: cell(r, "phone"), reference: cell(r, "reference"), line: i + (header ? 2 : 1) }));
    const seen = new Set<string>();
    const out: Verdict[] = recs.map((r) => {
      if (!r.name) return { status: "skip", reason: "no_name" };
      const key = keyOf(r);
      if (seen.has(key)) return { status: "skip", reason: "duplicate_in_file" };
      seen.add(key);
      return { status: "new" };
    });
    const send = recs.map((_, i) => i).filter((i) => out[i].reason === undefined);
    const passed = await check.run(async () => {
      for (let at = 0; at < send.length; at += CHUNK) {
        setProgress(t("import.checking", { done: at, total: send.length }));
        const part = send.slice(at, at + CHUNK);
        const res = await post<ImportResult>("/clients/import", { rows: part.map((i) => sendable(recs[i])), dry_run: true });
        part.forEach((i, k) => (out[i] = res.rows[k]));
      }
    });
    setProgress(null);
    if (passed) {
      setRecords(recs);
      setVerdicts(out);
      setShow("all");
      setOk(false);
    }
  }

  async function go() {
    if (!verdicts) return;
    const importId = crypto.randomUUID().replaceAll("-", "");
    const todo = records.map((_, i) => i).filter((i) => verdicts[i].status !== "skip");
    const total = { added: 0, updated: 0, skipped: verdicts.length - todo.length };
    const finished = await commit.run(async () => {
      for (let at = 0; at < todo.length; at += CHUNK) {
        setProgress(t("import.running", { done: at, total: todo.length }));
        const part = todo.slice(at, at + CHUNK);
        const res = await post<ImportResult>("/clients/import", { rows: part.map((i) => sendable(records[i])), import_id: importId, contact_ok: true });
        total.added += res.counts.new;
        total.updated += res.counts.update;
        total.skipped += res.counts.skip;
      }
    });
    setProgress(null);
    if (finished) setDone(total);
  }

  function reset() {
    setRows(null);
    setVerdicts(null);
    setDone(null);
    setOk(false);
  }

  if (done) {
    return (
      <>
        <h1>{t("import.done_title")}</h1>
        <p role="status">{t("import.done", done)}</p>
        <div class="actions">
          <Link href="/clients" class="button primary">
            {t("import.to_clients")}
          </Link>
          <button onClick={reset}>{t("import.again")}</button>
        </div>
      </>
    );
  }

  const counts = verdicts && {
    new: verdicts.filter((v) => v.status === "new").length,
    update: verdicts.filter((v) => v.status === "update").length,
    skip: verdicts.filter((v) => v.status === "skip").length,
  };
  const listed = verdicts ? records.map((r, i) => ({ r, v: verdicts[i] })).filter((x) => show === "all" || x.v.status === show) : [];

  return (
    <>
      <div class="head">
        <h1>{t("import.title")}</h1>
        <Link href="/clients" class="button">
          {t("import.back")}
        </Link>
      </div>
      {!verdicts && (
        <section>
          <p class="muted">{t("import.intro")}</p>
          <Field label={t("import.file")}>
            <input type="file" accept=".csv,.txt,text/csv" onChange={pick} />
          </Field>
          {problem && (
            <p class="error" role="alert">
              {problem}
            </p>
          )}
        </section>
      )}

      {rows && !verdicts && (
        <section>
          <h2>{t("import.map_title")}</h2>
          <Check label={t("import.header")} checked={header} onChange={toggleHeader} />
          <div class="filters">
            {FIELDS.map((f) => (
              <Field label={t(`import.map_${f}`)}>
                <select value={String(map[f])} onChange={(e) => setMap({ ...map, [f]: Number(e.currentTarget.value) })}>
                  {f !== "name" && <option value="-1">{t("import.none")}</option>}
                  {f === "name" && map.name < 0 && <option value="-1">{t("batch.choose")}</option>}
                  {Array.from({ length: columns }, (_, i) => (
                    <option value={String(i)}>{label(i)}</option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <h3>{t("import.sample")}</h3>
          <table>
            <thead>
              <tr>
                {Array.from({ length: columns }, (_, i) => (
                  <th>{label(i)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.slice(0, 5).map((r) => (
                <tr>
                  {Array.from({ length: columns }, (_, i) => (
                    <td>{r[i]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <ErrorNote error={check.error} />
          <div class="actions">
            <button class="primary" disabled={check.busy || map.name < 0 || body.length === 0} onClick={preview}>
              {t("import.check")}
            </button>
            {progress && <span class="muted">{progress}</span>}
          </div>
        </section>
      )}

      {verdicts && counts && (
        <section>
          <div class="chips" role="group" aria-label={t("import.show")}>
            <button class="chip" aria-pressed={show === "all"} onClick={() => setShow("all")}>
              {t("import.show_all")}
              <span class="count">{verdicts.length}</span>
            </button>
            {(["new", "update", "skip"] as const).map((s) => (
              <button key={s} class="chip" aria-pressed={show === s} onClick={() => setShow(s)}>
                {t(`import.${s}_n`, { n: counts[s] })}
              </button>
            ))}
          </div>
          {counts.update > 0 && <p class="muted">{t("import.update_help")}</p>}
          <table class="stack">
            <thead>
              <tr>
                <th>{t("import.row")}</th>
                <th>{t("clients.name")}</th>
                <th class="wide">{t("clients.email")}</th>
                <th>{t("requests.status")}</th>
              </tr>
            </thead>
            <tbody>
              {listed.slice(0, SHOWN).map(({ r, v }) => (
                <tr key={r.line}>
                  <td>{r.line}</td>
                  <td class="name">{r.name || "-"}</td>
                  <td class="wide">{r.email || "-"}</td>
                  <td>
                    <Badge tone={v.status === "new" ? "green" : v.status === "update" ? "teal" : "grey"}>{t(`import.status.${v.status}`)}</Badge>
                    {v.reason && <span class="sub">{t(`import.reason.${v.reason}`)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listed.length > SHOWN && (
            <p class="muted tally">{t("import.showing", { shown: SHOWN, total: listed.length })}</p>
          )}
          {counts.new + counts.update === 0 ? (
            <p class="muted">{t("import.nothing")}</p>
          ) : (
            <>
              <Check label={t("import.permission")} checked={ok} onChange={setOk} />
              <ErrorNote error={commit.error} />
            </>
          )}
          <div class="actions">
            {counts.new + counts.update > 0 && (
              <button class="primary" disabled={!ok || commit.busy} onClick={go}>
                {t("import.go")}
              </button>
            )}
            <button disabled={commit.busy} onClick={() => setVerdicts(null)}>
              {t("import.back")}
            </button>
            {progress && <span class="muted">{progress}</span>}
          </div>
        </section>
      )}
    </>
  );
}

const sendable = ({ name, email, phone, reference }: Rec) => ({ name, email, phone, reference });
