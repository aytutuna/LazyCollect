import { useEffect, useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { get, useAction } from "../api";
import { fmtDateTime } from "../format";
import { t } from "../i18n";
import type { ActivityRow } from "../types";
import { ErrorNote, Loading } from "../ui";

type Page = { rows: ActivityRow[]; next: string | null };

function what(action: string): string {
  const key = `activity.action.${action}`;
  const text = t(key);
  return text === key ? action : text;
}

function who(row: ActivityRow): string {
  if (row.actor_type === "client") return t("activity.client");
  if (row.actor_type === "system") return t("activity.system");
  return row.actor ?? t("activity.unknown");
}

export function ActivityList({ rows, links }: { rows: ActivityRow[]; links?: boolean }) {
  return (
    <table class="activity">
      <thead>
        <tr>
          <th>{t("activity.when")}</th>
          <th>{t("activity.who")}</th>
          <th>{t("activity.what")}</th>
          {links && <th />}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{fmtDateTime(r.at)}</td>
            <td>{who(r)}</td>
            <td>{what(r.action)}</td>
            {links && (
              <td class="end">
                {r.request_id ? <Link href={`/requests/${r.request_id}`}>{t("activity.open")}</Link> : r.client_id ? <Link href="/clients">{t("activity.open")}</Link> : null}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Activity() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  async function load(cursor: string | null) {
    await run(async () => {
      const page = await get<Page>(`/activity${cursor ? `?cursor=${cursor}` : ""}`);
      setRows((old) => [...(old ?? []), ...page.rows]);
      setNext(page.next);
    });
  }

  useEffect(() => {
    load(null);
  }, []);

  return (
    <>
      <h1>{t("activity.title")}</h1>
      <p class="muted">{t("activity.intro")}</p>
      <ErrorNote error={error} />
      {rows === null ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <p class="muted">{t("activity.none")}</p>
      ) : (
        <ActivityList rows={rows} links />
      )}
      {next && (
        <button disabled={busy} onClick={() => load(next)}>
          {t("activity.more")}
        </button>
      )}
    </>
  );
}
