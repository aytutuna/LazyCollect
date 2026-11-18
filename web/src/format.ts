import { t } from "./i18n";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

export const fmtDate = (ms: number) => dateFmt.format(ms);

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function relative(ms: number): string {
  const days = Math.round((startOfDay(ms) - startOfDay(Date.now())) / 86_400_000);
  if (days === 0) return t("rel.today");
  if (days === 1) return t("rel.tomorrow");
  if (days === -1) return t("rel.yesterday");
  return days > 0 ? t("rel.in_days", { n: days }) : t("rel.overdue_days", { n: -days });
}

export const isLate = (ms: number) => ms < Date.now();

export function toInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// the whole deadline day counts, so it ends at 23:59 local time
export function fromInput(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 0).getTime();
}

export const inDays = (n: number) => Date.now() + n * 86_400_000;

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
