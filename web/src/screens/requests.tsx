import { Link } from "wouter-preact";
import { fmtDate, isLate, relative } from "../format";
import { t } from "../i18n";
import { usePaged, useSearchBox, useUrlParams } from "../paged";
import type { RequestCounts, RequestRow } from "../types";
import { Badge, ErrorNote, Field, Loading, statusLabel, statusTone } from "../ui";

const STATUSES = ["draft", "open", "complete", "expired", "closed"];
const VIEWS = ["to_review", "waiting", "overdue", "due_soon", "all"] as const;
type View = (typeof VIEWS)[number];
const SORTS = ["newest", "deadline", "activity"];

// the order that suits each tab until the person picks another
const SORT_FOR: Record<View, string> = { to_review: "activity", waiting: "deadline", overdue: "deadline", due_soon: "deadline", all: "newest" };

type Extra = { counts: RequestCounts | null; client: { id: string; name: string } | null };

export function Requests() {
  const { params, set } = useUrlParams();
  const view = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "to_review";
  const sort = SORTS.includes(params.get("sort") ?? "") ? params.get("sort")! : SORT_FOR[view];
  const status = STATUSES.includes(params.get("status") ?? "") ? params.get("status")! : "";
  const client = params.get("client") ?? "";
  const q = params.get("q") ?? "";
  const [typed, type] = useSearchBox(q, (v) => set({ q: v }, true));

  const query = new URLSearchParams({ view, sort, ...(status && { status }), ...(client && { client }), ...(q && { q }) }).toString();
  const list = usePaged<RequestRow, Extra>("/requests", query);
  const counts = list.extra?.counts;
  const filtered = Boolean(q || status || client);
  const firstRun = counts?.all === 0 && !filtered && !list.loading;

  return (
    <>
      <div class="head">
        <h1>{t("requests.title")}</h1>
        <Link href="/new" class="button primary">
          {t("requests.new")}
        </Link>
      </div>
      <ErrorNote error={list.error} />
      {firstRun ? (
        <div class="empty">
          <h2>{t("requests.empty_title")}</h2>
          <p class="muted">{t("requests.empty_body")}</p>
          <Link href="/new" class="button primary">
            {t("requests.new")}
          </Link>
        </div>
      ) : (
        <>
          <div class="chips" role="group" aria-label={t("requests.view_label")}>
            {VIEWS.map((v) => (
              <button key={v} class="chip" aria-pressed={v === view} onClick={() => set({ view: v, sort: "" })}>
                {t(`requests.view.${v}`)}
                {counts && <span class="count">{counts[v]}</span>}
              </button>
            ))}
          </div>
          <div class="filters">
            <Field label={t("requests.search")}>
              <input type="search" value={typed} maxLength={100} onInput={(e) => type(e.currentTarget.value)} />
            </Field>
            <Field label={t("requests.status")}>
              <select value={status} onChange={(e) => set({ status: e.currentTarget.value })}>
                <option value="">{t("requests.all")}</option>
                {STATUSES.map((s) => (
                  <option value={s}>{statusLabel(s)}</option>
                ))}
              </select>
            </Field>
            <Field label={t("requests.sort")}>
              <select value={sort} onChange={(e) => set({ sort: e.currentTarget.value })}>
                {SORTS.map((s) => (
                  <option value={s}>{t(`requests.sort.${s}`)}</option>
                ))}
              </select>
            </Field>
          </div>
          {client && (
            <p class="muted">
              {list.extra?.client ? t("requests.for_client", { name: list.extra.client.name }) : null}{" "}
              <button class="link" onClick={() => set({ client: "" })}>
                {t("requests.all_clients")}
              </button>
            </p>
          )}
          <div aria-busy={list.loading}>
            {list.loading && list.rows.length === 0 ? (
              !list.error && <Loading />
            ) : list.rows.length === 0 ? (
              <div class="empty">
                <p>{filtered || view === "all" ? t("requests.none_match") : t(`requests.none.${view}`)}</p>
                {view !== "all" && <button onClick={() => set({ view: "all", sort: "" })}>{t("requests.show_all")}</button>}
              </div>
            ) : (
              <>
                <table class={`stack${list.loading ? " busy" : ""}`}>
                  <thead>
                    <tr>
                      <th>{t("requests.client")}</th>
                      <th>{t("requests.request")}</th>
                      <th class="wide">{t("requests.deadline")}</th>
                      <th class="wide">{t("requests.status")}</th>
                      <th class="wide">{t("requests.progress")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((r) => (
                      <Row key={r.id} r={r} />
                    ))}
                  </tbody>
                </table>
                <p class="muted tally" role="status">
                  {t("requests.showing", { shown: list.rows.length, total: counts ? counts[view] : list.rows.length })}
                </p>
                {list.next !== null && (
                  <>
                    <ErrorNote error={list.more.error} />
                    <button disabled={list.more.busy} onClick={list.loadMore}>
                      {list.more.busy ? t("loading") : t("more")}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Progress({ r }: { r: RequestRow }) {
  const total = r.empty + r.submitted + r.approved + r.rejected;
  const done = r.submitted + r.approved;
  return (
    <>
      <progress max={total || 1} value={done} aria-label={t("progress", { done, total })} />
      <span class="sub">{t("progress", { done, total })}</span>
      {r.submitted > 0 && <Badge tone="teal">{t("requests.to_review_n", { n: r.submitted })}</Badge>}
    </>
  );
}

function Row({ r }: { r: RequestRow }) {
  const open = r.status === "draft" || r.status === "open";
  const late = isLate(r.deadline) && open;
  const when = late ? relative(r.deadline) : t("requests.due", { when: relative(r.deadline).toLowerCase() });
  return (
    <tr>
      <td class="name">{r.client_name}</td>
      <td>
        <Link href={`/requests/${r.id}`}>{r.title}</Link>
      </td>
      <td class="wide">
        <span class={late ? "late" : ""}>{relative(r.deadline)}</span>
        <span class="sub">{fmtDate(r.deadline)}</span>
      </td>
      <td class="wide">
        <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
      </td>
      <td class="wide progress">
        <Progress r={r} />
      </td>
      <td class="narrow muted">
        <span class={late ? "late" : ""}>{when}</span> · {statusLabel(r.status)}
        <div class="progress">
          <Progress r={r} />
        </div>
      </td>
    </tr>
  );
}
