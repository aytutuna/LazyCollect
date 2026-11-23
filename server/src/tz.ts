import { DAY, HOUR } from "./util";

const formats = new Map<string, Intl.DateTimeFormat>();

function local(ms: number, tz: string) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute };
}

export const validZone = (tz: string) => {
  try {
    local(0, tz);
    return true;
  } catch {
    return false;
  }
};

export const localHour = (ms: number, tz: string) => local(ms, tz).h;

export type Day = { y: number; m: number; d: number };

export function dayOf(ms: number, tz: string): Day {
  const { y, m, d } = local(ms, tz);
  return { y, m, d };
}

export function addDays(day: Day, n: number): Day {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// the same wall clock time a year later; 29 February falls back to the 28th
export function plusYear(ms: number, tz: string): number {
  const l = local(ms, tz);
  const day = { y: l.y + 1, m: l.m, d: l.m === 2 && l.d === 29 ? 28 : l.d };
  return atHour(day, l.h, tz) + l.min * 60_000;
}

export const sameDay = (a: Day, b: Day) => a.y === b.y && a.m === b.m && a.d === b.d;

// the instant a wall clock hour starts on a day; the second pass settles zones whose offset changes that day
export function atHour(day: Day, hour: number, tz: string): number {
  const wall = Date.UTC(day.y, day.m - 1, day.d, hour);
  const offset = (t: number) => {
    const l = local(t, tz);
    return Date.UTC(l.y, l.m - 1, l.d, l.h, l.min) - t;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

export const QUIET_START = 9;
export const QUIET_END = 19;

export const inHours = (ms: number, tz: string) => {
  const h = localHour(ms, tz);
  return h >= QUIET_START && h < QUIET_END;
};

// the first 9:00 after ms
export function nextOpening(ms: number, tz: string): number {
  const today = dayOf(ms, tz);
  const t = atHour(today, QUIET_START, tz);
  return t > ms ? t : atHour(addDays(today, 1), QUIET_START, tz);
}

const FIRST = 3 * DAY;
const EVERY = 7 * DAY;
export const SPACING = 36 * HOUR;
const COUNTDOWN = [2, 0];

// Three days after the link, then weekly, with one reminder two days before the deadline and one on its morning, and the note the day after it.
// `first` is true when `after` is the link going out rather than a reminder; a fixed reminder that would land within 36 hours of the last one is dropped.
export function nextReminder(after: number, deadline: number, tz: string, first: boolean): number {
  const last = dayOf(deadline, tz);
  const today = dayOf(after, tz);
  const candidates = [after + (first ? FIRST : EVERY)];
  for (const n of COUNTDOWN) {
    const day = addDays(last, -n);
    const t = atHour(day, QUIET_START, tz);
    if (t > after && !sameDay(day, today) && (first || t - after >= SPACING)) candidates.push(t);
  }
  const before = candidates.filter((t) => t < deadline);
  return before.length ? Math.min(...before) : atHour(addDays(last, 1), QUIET_START, tz);
}
