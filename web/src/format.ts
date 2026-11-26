import { intl, t } from "./i18n";

// Dates mean the account's time zone, not the browser's: a deadline is 23:59 there.
let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function setZone(tz: string) {
  zone = tz;
}

const wall = (ms: number) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  );
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute };
};

// a calendar date such as a document's expiry has no time zone, so it is read as the same day everywhere
export const fmtDay = (day: string) => new Intl.DateTimeFormat(intl(), { dateStyle: "medium", timeZone: "UTC" }).format(Date.parse(`${day}T12:00:00Z`));

export const fmtDate = (ms: number) => new Intl.DateTimeFormat(intl(), { dateStyle: "medium", timeZone: zone }).format(ms);

export const fmtDateTime = (ms: number) => new Intl.DateTimeFormat(intl(), { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(ms);

const dayNumber = (ms: number) => {
  const w = wall(ms);
  return Date.UTC(w.y, w.m - 1, w.d) / 86_400_000;
};

export function relative(ms: number): string {
  const days = dayNumber(ms) - dayNumber(Date.now());
  if (days === 0) return t("rel.today");
  if (days === 1) return t("rel.tomorrow");
  if (days === -1) return t("rel.yesterday");
  return days > 0 ? t("rel.in_days", { n: days }) : t("rel.overdue_days", { n: -days });
}

export const isLate = (ms: number) => ms < Date.now();

export function toInput(ms: number): string {
  const w = wall(ms);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

// a date and time as a datetime-local input has it, in the account's zone
export function toLocalInput(ms: number): string {
  const w = wall(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${two(w.m)}-${two(w.d)}T${two(w.h)}:${two(w.min)}`;
}

// the whole deadline day counts, so it ends at 23:59 in the account's zone
export function fromInput(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, 23, 59);
  const offset = (t: number) => {
    const w = wall(t);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - t;
  };
  const first = target - offset(target);
  return target - offset(first);
}

export const inDays = (n: number) => Date.now() + n * 86_400_000;

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} ${t("size.b")}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${t("size.kb")}`;
  return `${new Intl.NumberFormat(intl(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 1024 / 1024)} ${t("size.mb")}`;
}
