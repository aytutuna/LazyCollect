import { render } from "preact";
import { ApiError, get, useLoad } from "./api";
import { fmtDate, isLate, relative } from "./format";
import { t } from "./i18n";
import type { ClientView } from "./types";
import { Badge, Loading } from "./ui";
import "./styles.css";

const TONES = { empty: "grey", submitted: "teal", approved: "green", rejected: "red" };

function Page() {
  const token = location.pathname.split("/")[2] ?? "";
  const { data, error } = useLoad(() => get<ClientView>(`/c/${encodeURIComponent(token)}`));

  if (error) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <main class="client-page">
        <h1>{gone ? t("client.gone_title") : t("client.error_title")}</h1>
        <p>{gone ? t("client.gone") : t(error instanceof ApiError && error.status === 429 ? "error.rate_limited" : "client.error")}</p>
      </main>
    );
  }
  if (!data) return <Loading />;

  const received = data.items.filter((i) => i.status === "submitted" || i.status === "approved").length;
  return (
    <main class="client-page">
      <p class="firm">{data.firm_name}</p>
      <h1>{data.title}</h1>
      {data.note && <p>{data.note}</p>}
      <p>
        {t("client.due")}: <strong class={isLate(data.deadline) ? "late" : ""}>{fmtDate(data.deadline)}</strong> ({relative(data.deadline)})
      </p>
      <section>
        <h2>{t("client.checklist")}</h2>
        <p class="muted">{t("progress", { done: received, total: data.items.length })}</p>
        <ul class="items">
          {data.items.map((item) => (
            <li key={item.id}>
              <div class="main">
                <strong>{item.label}</strong> {!item.required && <span class="muted">({t("items.optional")})</span>}
                {item.help && <div class="muted">{item.help}</div>}
                {item.status === "rejected" && item.reject_note && <p class="reject">{item.reject_note}</p>}
              </div>
              <div class="side">
                <Badge tone={TONES[item.status]}>{t(`client.${item.status}`)}</Badge>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

render(<Page />, document.getElementById("app")!);
