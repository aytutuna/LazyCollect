import { render } from "preact";
import { useRef, useState } from "preact/hooks";
import { ApiError, del, get, useAction, useLoad } from "./api";
import { fmtDate, fmtSize, isLate, relative } from "./format";
import { t } from "./i18n";
import type { ClientItem, ClientView } from "./types";
import { Badge, ErrorNote, Loading } from "./ui";
import { MAX_SIZE, combineToPdf, prepareImage, sendFile, type Prepared } from "./upload";
import "./styles.css";

const TONES = { empty: "grey", submitted: "teal", approved: "green", rejected: "red" };

// one queue for the whole page keeps a phone's memory and the per-link rate limit comfortable
let queue: Promise<unknown> = Promise.resolve();

type Job = { key: string; file: Prepared; uploadId: string; progress: number; failed: boolean; error?: unknown };

function Uploads({ token, item, onChange }: { token: string; item: ClientItem; onChange: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [combined, setCombined] = useState(0);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const removal = useAction();
  const open = item.status !== "approved";

  const update = (key: string, patch: Partial<Job>) => setJobs((all) => all.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  function send(job: Job) {
    queue = queue.then(async () => {
      update(job.key, { failed: false, error: undefined, progress: 0 });
      try {
        if (job.file.blob.size > MAX_SIZE) throw new ApiError(413, "too_big");
        await sendFile(`/api/c/${encodeURIComponent(token)}/items/${item.id}/files`, job.file, job.uploadId, (progress) => update(job.key, { progress }));
        setJobs((all) => all.filter((j) => j.key !== job.key));
        onChange();
      } catch (error) {
        update(job.key, { failed: true, error });
      }
    });
  }

  async function pick(input: HTMLInputElement) {
    const picked = [...(input.files ?? [])];
    input.value = "";
    if (!picked.length) return;
    setPreparing(true);
    setCombined(0);
    let ready: Prepared[] = [];
    for (const file of picked) {
      ready.push(file.type.startsWith("image/") ? await prepareImage(file) : { blob: file, name: file.name, jpeg: false });
    }
    const photos = ready.filter((r) => r.jpeg);
    // a few kB per page covers the PDF structure; past the cap the photos go up separately
    const estimate = photos.reduce((sum, p) => sum + p.blob.size + 2048, 0);
    if (photos.length > 1 && estimate <= MAX_SIZE) {
      try {
        const pdf = await combineToPdf(photos.map((p) => p.blob), item.label);
        if (pdf.blob.size <= MAX_SIZE) {
          ready = [...ready.filter((r) => !r.jpeg), pdf];
          setCombined(photos.length);
        }
      } catch {
        // the photos go up one by one instead
      }
    }
    setPreparing(false);
    for (const file of ready) {
      const job = { key: crypto.randomUUID(), file, uploadId: crypto.randomUUID(), progress: 0, failed: false };
      setJobs((all) => [...all, job]);
      send(job);
    }
  }

  async function remove(id: string) {
    if (await removal.run(() => del(`/c/${encodeURIComponent(token)}/files/${id}`))) onChange();
  }

  return (
    <div class="uploads">
      {item.files.length > 0 && (
        <ul class="files">
          {item.files.map((f) => (
            <li key={f.id}>
              <span class="name">
                {f.name} <span class="muted">({fmtSize(f.size)})</span>
              </span>
              {open && (
                <button class="small quiet" disabled={removal.busy} onClick={() => remove(f.id)}>
                  {t("client.remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {jobs.map((job) => (
        <div class="job" key={job.key}>
          {job.failed ? (
            <>
              <p class="muted">{job.file.name}</p>
              <ErrorNote error={job.error} />
              <div class="row-actions">
                <button class="small" onClick={() => send(job)}>
                  {t("retry")}
                </button>
                <button class="small" onClick={() => setJobs((all) => all.filter((j) => j.key !== job.key))}>
                  {t("dismiss")}
                </button>
              </div>
            </>
          ) : (
            <label>
              <span class="muted">{t("client.uploading", { name: job.file.name })}</span>
              <progress max={1} value={job.progress} />
            </label>
          )}
        </div>
      ))}
      {preparing && <p class="muted">{t("client.preparing")}</p>}
      {combined > 0 && <p class="muted">{t("client.combined", { n: combined })}</p>}
      <ErrorNote error={removal.error} />
      {open && (
        <>
          <div class="row-actions">
            <button class="small" disabled={preparing} onClick={() => camera.current?.click()}>
              {t("client.take_photo")}
            </button>
            <button class="small" disabled={preparing} onClick={() => picker.current?.click()}>
              {t("client.choose_file")}
            </button>
          </div>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.currentTarget)} />
          <input ref={picker} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => pick(e.currentTarget)} />
        </>
      )}
    </div>
  );
}

function ItemList({ items, token, onChange }: { items: ClientItem[]; token: string; onChange: () => void }) {
  return (
    <ul class="items">
      {items.map((item) => (
        <li key={item.id}>
          <div class="main">
            <div class="line">
              <strong>{item.label}</strong>
              <Badge tone={TONES[item.status]}>{t(`client.${item.status}`)}</Badge>
            </div>
            {item.help && <div class="muted">{item.help}</div>}
            {item.status === "rejected" && item.reject_note && (
              <div class="callout" role="alert">
                <strong>{t("client.rejected_title")}</strong>
                <p>{item.reject_note}</p>
              </div>
            )}
            {item.status === "submitted" && item.reject_note && <p class="muted">{t("client.earlier_note", { note: item.reject_note })}</p>}
            <Uploads token={token} item={item} onChange={onChange} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Page() {
  const token = location.pathname.split("/")[2] ?? "";
  const { data, error, reload } = useLoad(() => get<ClientView>(`/c/${encodeURIComponent(token)}`));

  if (error && !data) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <main class="client-page">
        <h1>{gone ? t("client.gone_title") : t("client.error_title")}</h1>
        <p>{gone ? t("client.gone") : t(error instanceof ApiError && error.status === 429 ? "error.rate_limited" : "client.error")}</p>
      </main>
    );
  }
  if (!data) return <Loading />;

  const optional = data.items.filter((i) => !i.required);
  const received = data.items.filter((i) => i.status === "submitted" || i.status === "approved").length;
  return (
    <main class="client-page">
      <p class="firm">{data.firm_name}</p>
      <h1>{data.title}</h1>
      {data.note && <p>{data.note}</p>}
      <p>
        {t("client.due")}: <strong class={isLate(data.deadline) ? "late" : ""}>{fmtDate(data.deadline)}</strong> ({relative(data.deadline)})
      </p>
      {error && (
        <p class="error" role="alert">
          {t("client.refresh_failed")}{" "}
          <button class="link" onClick={reload}>
            {t("retry")}
          </button>
        </p>
      )}
      <p class="muted">{t("client.privacy", { firm: data.firm_name })}</p>
      <section>
        <h2>{t("client.checklist")}</h2>
        <p class="muted">{t("progress", { done: received, total: data.items.length })}</p>
        <ItemList items={data.items.filter((i) => i.required)} token={token} onChange={reload} />
        {optional.length > 0 && (
          <>
            <h3 class="optional">{t("client.optional")}</h3>
            <ItemList items={optional} token={token} onChange={reload} />
          </>
        )}
      </section>
    </main>
  );
}

render(<Page />, document.getElementById("app")!);
