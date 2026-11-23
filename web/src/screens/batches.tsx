import { useEffect, useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { get, post, useAction, useLoad } from "../api";
import { fmtDate, fmtDateTime } from "../format";
import { t } from "../i18n";
import { usePaged, useUrlParams } from "../paged";
import type { Batch, BatchRow, Me } from "../types";
import { Badge, Confirm, ErrorNote, Loading, statusLabel } from "../ui";

const BATCH_TONES = { scheduled: "amber", sending: "teal", done: "green", cancelled: "grey" };

const source = (b: Batch) => t(`batch.source.${b.source_kind}`, { name: b.source_name ?? "" });

function progress(b: Batch) {
  return b.limited_at && b.status === "sending" ? t("batch.limited", { sent: b.sent, total: b.total }) : t("batch.progress", { sent: b.sent, total: b.total });
}

export function Batches() {
  const list = usePaged<Batch>("/batches", "");
  return (
    <>
      <div class="head">
        <h1>{t("batch.list_title")}</h1>
        <Link href="/batches/new" class="button primary">
          {t("batch.new")}
        </Link>
      </div>
      <ErrorNote error={list.error} />
      {list.loading && list.rows.length === 0 ? (
        !list.error && <Loading />
      ) : list.rows.length === 0 ? (
        <div class="empty">
          <h2>{t("batch.list_empty_title")}</h2>
          <p class="muted">{t("batch.list_empty_body")}</p>
        </div>
      ) : (
        <>
          <table class="stack">
            <thead>
              <tr>
                <th>{t("batch.col.batch")}</th>
                <th class="wide">{t("batch.col.source")}</th>
                <th>{t("batch.col.progress")}</th>
                <th class="wide">{t("batch.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((b) => (
                <tr key={b.id}>
                  <td class="name">
                    <Link href={`/batches/${b.id}`}>{b.title}</Link>
                    <span class="sub">{fmtDate(b.created_at)}</span>
                  </td>
                  <td class="wide">{source(b)}</td>
                  <td>
                    <progress max={b.total || 1} value={b.sent + b.no_email + b.skipped + b.failed} aria-label={progress(b)} />
                    <span class="sub">{progress(b)}</span>
                  </td>
                  <td class="wide">
                    <Badge tone={BATCH_TONES[b.status]}>{t(`batch.status.${b.status}`)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.next !== null && (
            <button disabled={list.more.busy} onClick={list.loadMore}>
              {list.more.busy ? t("loading") : t("more")}
            </button>
          )}
        </>
      )}
    </>
  );
}

const FILTERS = ["all", "pending", "sent", "opened", "complete", "review", "no_email", "problem"] as const;

function stateText(r: BatchRow): string {
  if (r.state === "sent") return t("batch.state.sent", { when: fmtDateTime(r.sent_at!) });
  if (r.state === "skipped") return t(`batch.state.skipped.${r.reason}`);
  return t(`batch.state.${r.state}`);
}

const STATE_TONES = { pending: "grey", sent: "green", no_email: "amber", skipped: "grey", failed: "red", cancelled: "grey" };

export function BatchPage({ id }: { id: string }) {
  const { params, set } = useUrlParams();
  const filter = (FILTERS as readonly string[]).includes(params.get("show") ?? "") ? params.get("show")! : "all";
  const batch = useLoad(() => get<Batch>(`/batches/${id}`), [id]);
  const rows = usePaged<BatchRow>(`/batches/${id}/rows`, `filter=${filter}`);
  const me = useLoad(() => get<Me>("/me"));
  const [asking, setAsking] = useState(false);
  const stop = useAction();
  const b = batch.data;
  const live = b?.status === "scheduled" || b?.status === "sending";

  // a running batch changes under the page
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      batch.reload();
      rows.reload();
    }, 30_000);
    return () => clearInterval(timer);
  }, [live]);

  async function cancel() {
    if (await stop.run(() => post(`/batches/${id}/cancel`))) {
      setAsking(false);
      batch.reload();
      rows.reload();
    }
  }

  if (!b) return batch.error ? <ErrorNote error={batch.error} /> : <Loading />;

  const counts: [(typeof FILTERS)[number], number][] = [
    ["pending", b.pending],
    ["sent", b.sent],
    ["opened", b.opened],
    ["complete", b.complete],
    ["review", b.review],
    ["no_email", b.no_email],
  ];
  const problems = b.skipped + b.failed;
  const limited = b.status === "sending" && b.limited_at !== null && b.pending > 0;

  return (
    <>
      <p>
        <Link href="/batches">{t("batch.all_batches")}</Link>
      </p>
      <div class="head">
        <h1>{b.title}</h1>
        <Badge tone={BATCH_TONES[b.status]}>{t(`batch.status.${b.status}`)}</Badge>
      </div>
      <p class="muted">{source(b)}</p>
      <ErrorNote error={batch.error} />
      {b.status === "scheduled" && <p>{b.send_at > Date.now() ? t("batch.scheduled_for", { when: fmtDateTime(b.send_at) }) : t("batch.scheduled_now")}</p>}
      {live && <p class="muted">{t("batch.hours_note")}</p>}
      {limited && (
        <div class="callout notice" role="status">
          <p>{t("batch.limited", { sent: b.sent, total: b.total })}</p>
          {me.data && <p class="muted">{t(me.data.firm.subscribed ? "batch.limit_paid" : "batch.limit_trial")}</p>}
        </div>
      )}
      {b.status === "cancelled" && <p class="muted">{t("batch.cancelled_note", { n: b.cancelled })}</p>}

      <div class="chips" role="group" aria-label={t("batch.filter_label")}>
        <button class="chip" aria-pressed={filter === "all"} onClick={() => set({ show: "" })}>
          {t("batch.count.all")}
          <span class="count">{b.total}</span>
        </button>
        {counts.map(([f, n]) => (
          <button key={f} class="chip" aria-pressed={filter === f} onClick={() => set({ show: f })}>
            {t(`batch.count.${f}`)}
            <span class="count">{n}</span>
          </button>
        ))}
        {problems > 0 && (
          <button class="chip" aria-pressed={filter === "problem"} onClick={() => set({ show: "problem" })}>
            {t("batch.count.problem")}
            <span class="count">{problems}</span>
          </button>
        )}
      </div>

      <ErrorNote error={rows.error} />
      {rows.loading && rows.rows.length === 0 ? (
        !rows.error && <Loading />
      ) : rows.rows.length === 0 ? (
        <p class="muted">{t("batch.rows_none")}</p>
      ) : (
        <div aria-busy={rows.loading}>
          <table class={`stack${rows.loading ? " busy" : ""}`}>
            <thead>
              <tr>
                <th>{t("batch.row.client")}</th>
                <th>{t("batch.row.state")}</th>
                <th class="wide">{t("batch.row.request")}</th>
                <th class="wide">{t("batch.row.opened")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.rows.map((r) => (
                <tr key={r.request_id}>
                  <td class="name">
                    {r.client_name}
                    {r.email && <span class="sub">{r.email}</span>}
                  </td>
                  <td>
                    <Badge tone={STATE_TONES[r.state]}>{stateText(r)}</Badge>
                  </td>
                  <td class="wide">
                    <Link href={`/requests/${r.request_id}`}>{r.title}</Link>
                    <span class="sub">
                      {statusLabel(r.status)}
                      {r.to_review > 0 && ` · ${t("batch.review_n", { n: r.to_review })}`}
                    </span>
                  </td>
                  <td class="wide">
                    {r.first_opened_at ? <Badge tone="teal">{fmtDate(r.first_opened_at)}</Badge> : <span class="muted">{t("batch.not_opened")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.next !== null && (
            <>
              <ErrorNote error={rows.more.error} />
              <button disabled={rows.more.busy} onClick={rows.loadMore}>
                {rows.more.busy ? t("loading") : t("more")}
              </button>
            </>
          )}
        </div>
      )}

      {live && (
        <div class="actions">
          <button class="quiet" onClick={() => setAsking(true)}>
            {t("batch.cancel")}
          </button>
        </div>
      )}
      {asking && (
        <Confirm title={t("batch.cancel_title")} body={t("batch.cancel_body")} confirm={t("batch.cancel")} danger busy={stop.busy} error={stop.error} onConfirm={cancel} onCancel={() => setAsking(false)} />
      )}
    </>
  );
}
