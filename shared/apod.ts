import type { ApodWeekData } from "./contract";

/**
 * APOD calendar helpers shared by the Worker (archive weeks, cache keys) and the browser (date picker,
 * "Random day"). All dates are ISO calendar dates ("YYYY-MM-DD") of the APOD posting day.
 */

/** The first APOD (verified on science.nasa.gov, 16 Oct 2026). 17–19 June 1995 have no entry. */
export const APOD_FIRST = "1995-06-16";

/** Today's APOD date. APOD posts at about 00:05 US Eastern, so "today" is the New York calendar date. */
export function apodToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30 and the like). */
export function isIsoDate(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Monday of the week containing `iso`. Archive requests are made per week, so they share cache entries. */
export function weekStartOf(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDaysIso(iso, -((dow + 6) % 7));
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Nearest published days before and after `day`, from its week (and the week's neighbours when empty). */
export function nearestDays(day: string, week: ApodWeekData): { before: string | null; after: string | null } {
  const dates = [...week.entries.map((e) => e.date), week.before, week.after].filter((d): d is string => !!d);
  const before = dates.filter((d) => d < day).sort().pop() ?? null;
  const after = dates.filter((d) => d > day).sort()[0] ?? null;
  return { before, after };
}

/** A uniformly random day of the archive (16 Jun 1995 … `today`). */
export function randomDay(today: string, rand = Math.random): string {
  return addDaysIso(APOD_FIRST, Math.floor(rand() * (daysBetween(APOD_FIRST, today) + 1)));
}
