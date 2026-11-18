import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { get, useLoad } from "../api";
import { fmtDate, isLate, relative } from "../format";
import { t } from "../i18n";
import type { RequestRow } from "../types";
import { Badge, ErrorNote, Field, Loading, statusLabel, statusTone } from "../ui";

const STATUSES = ["draft", "open", "complete", "expired", "closed"];

export function Requests() {
  const { data, error } = useLoad(() => get<RequestRow[]>("/requests"));
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  const shown = (data ?? []).filter((r) => (!status || r.status === status) && (!q || r.client_name.toLowerCase().includes(q)));

  return (
    <>
      <div class="head">
        <h1>{t("requests.title")}</h1>
        <Link href="/new" class="button primary">
          {t("requests.new")}
        </Link>
      </div>
      <ErrorNote error={error} />
      {!data ? (
        !error && <Loading />
      ) : data.length === 0 ? (
        <div class="empty">
          <h2>{t("requests.empty_title")}</h2>
          <p class="muted">{t("requests.empty_body")}</p>
          <Link href="/new" class="button primary">
            {t("requests.new")}
          </Link>
        </div>
      ) : (
        <>
          <div class="filters">
            <Field label={t("requests.search")}>
              <input type="search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
            </Field>
            <Field label={t("requests.status")}>
              <select value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
                <option value="">{t("requests.all")}</option>
                {STATUSES.map((s) => (
                  <option value={s}>{statusLabel(s)}</option>
                ))}
              </select>
            </Field>
          </div>
          {shown.length === 0 ? (
            <p class="muted">{t("requests.none_match")}</p>
          ) : (
            <table class="stack">
              <thead>
                <tr>
                  <th>{t("requests.client")}</th>
                  <th>{t("requests.request")}</th>
                  <th>{t("requests.deadline")}</th>
                  <th>{t("requests.status")}</th>
                  <th>{t("requests.progress")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <Row r={r} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function Row({ r }: { r: RequestRow }) {
  const total = r.empty + r.submitted + r.approved + r.rejected;
  const late = isLate(r.deadline) && (r.status === "draft" || r.status === "open");
  return (
    <tr>
      <td data-label={t("requests.client")}>{r.client_name}</td>
      <td data-label={t("requests.request")}>
        <Link href={`/requests/${r.id}`}>{r.title}</Link>
      </td>
      <td data-label={t("requests.deadline")}>
        <span class={late ? "late" : ""}>{relative(r.deadline)}</span>
        <span class="sub">{fmtDate(r.deadline)}</span>
      </td>
      <td data-label={t("requests.status")}>
        <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
      </td>
      <td data-label={t("requests.progress")}>{t("progress", { done: r.submitted + r.approved, total })}</td>
    </tr>
  );
}
