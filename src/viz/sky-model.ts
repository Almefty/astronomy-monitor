/**
 * What the "Sky tonight" panel shows, computed from shared/sky.ts: tonight's events, whether and
 * when each planet can be seen, the Moon, and the geometry of the sky dome. Pure (no DOM, no
 * satellite.js), so the panel's list, summary and tests share it; the pass predictions live in
 * src/viz/passes.ts, which the panel loads with import().
 */

import type { VisiblePass } from "./passes";
import {
  altitudeAboveHorizon, compassPoint, moonPhase, nightDate, nightEvents, nightWindow, PLANET_HORIZON, planetInfo, refineCrossings,
  sampleFunction, skyPosition, SKY_PLANETS, timeZoneOffset, toObserver, TWILIGHT, type MoonPhase, type NightEvent, type NightEvents, type Observer,
  type Samples, type SkyBody, type SkyPlanet,
} from "../../shared/sky";

const DEG = Math.PI / 180;
const MINUTE = 60_000;

export type Interval = [number, number];

/** Rise and set in the night window (from one set of altitude samples; see riseTransitSet in shared/sky.ts). */
export interface RiseSet {
  /** "normal": crosses the horizon in the window; otherwise up or down the whole window. */
  state: "normal" | "always-up" | "never-up";
  /** First rise and first set in the window (either can be null). */
  rise: number | null;
  set: number | null;
}

/** Rise/set from samples of a body's altitude above its rise/set limit (positive = up). */
export function riseSetFrom(f: (ms: number) => number, samples: Samples): { rs: RiseSet; up: Interval[] } {
  const c = refineCrossings(f, samples, 0);
  const state = c.length ? "normal" : samples.v[0]! >= 0 ? "always-up" : "never-up";
  return {
    rs: { state, rise: c.find((x) => x.rising)?.ms ?? null, set: c.find((x) => !x.rising)?.ms ?? null },
    up: intervalsAbove(f, samples, 0, c),
  };
}

export const PLANET_NAMES: Record<SkyPlanet, string> = {
  mercury: "Mercury", venus: "Venus", mars: "Mars", jupiter: "Jupiter", saturn: "Saturn", uranus: "Uranus", neptune: "Neptune",
};
export const BODY_NAMES: Record<SkyBody, string> = { sun: "Sun", moon: "Moon", ...PLANET_NAMES };

/** Planets count as visible from this geometric altitude (degrees): lower is lost in haze and buildings. */
export const MIN_PLANET_ALT = 5;
/** Closer to the Sun than this (degrees) a planet is lost in its glare. */
export const GLARE_ELONGATION = 10;
/** The sky is dark enough for planets and spacecraft once the Sun is below civil twilight (−6°). */
export const DARK_SUN_ALT = TWILIGHT.civil;
/** Planets fainter than this need binoculars (Uranus is at the naked-eye limit under a dark sky). */
export const NAKED_EYE_MAG = 5.5;

/* ------------------------------------------------------------------ */
/* Intervals                                                           */
/* ------------------------------------------------------------------ */

/** Where sampled `f` is at or above `level`, refined by bisection to 1 s. */
export function intervalsAbove(f: (ms: number) => number, samples: Samples, level: number, crossings = refineCrossings(f, samples, level)): Interval[] {
  const start = samples.t[0]!, end = samples.t[samples.t.length - 1]!;
  const out: Interval[] = [];
  let open: number | null = samples.v[0]! >= level ? start : null;
  for (const c of crossings) {
    if (c.rising && open === null) open = c.ms;
    else if (!c.rising && open !== null) {
      out.push([open, c.ms]);
      open = null;
    }
  }
  if (open !== null) out.push([open, end]);
  return out;
}

/** Overlap of two sorted, non-overlapping interval lists. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0], b[j]![0]), hi = Math.min(a[i]![1], b[j]![1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tonight                                                             */
/* ------------------------------------------------------------------ */

export type PlanetStatus =
  /** Above 5° while the Sun is below −6°, and not lost in the Sun's glare. */
  | "visible"
  /** Within 10° of the Sun. */
  | "glare"
  /** Above 5° only while the Sun is above −6°. */
  | "daylight"
  /** Above the horizon after dark, but never above 5°. */
  | "low"
  /** Below the horizon for the whole night window. */
  | "below"
  /** The Sun never gets below −6° tonight (polar day, or white nights). */
  | "no-dark";

export interface PlanetTonight {
  id: SkyPlanet;
  name: string;
  status: PlanetStatus;
  /** Plain-language reason for the status ("Too close to the Sun (6° away)"). */
  reason: string;
  /** Highest point while it is visible (dark sky, above 5°), else null. */
  best: { ms: number; alt: number; az: number } | null;
  /** When it is visible: above 5° with the Sun below −6°. */
  visible: Interval[];
  /** Apparent magnitude at the best time (or the middle of the night). */
  mag: number | null;
  /** Angular distance from the Sun, degrees. */
  elongation: number;
  rs: RiseSet;
}

export interface MoonTonight {
  phase: MoonPhase;
  rs: RiseSet;
  /** When the Moon is up (above its rise/set limit) in the window. */
  up: Interval[];
}

export interface Tonight {
  /** The observer's night date ("YYYY-MM-DD", see nightDate in shared/sky.ts). */
  date: string;
  /** Solar noon to the next solar noon, UTC ms. */
  start: number;
  end: number;
  events: NightEvents;
  /** Sun below −6° (dark enough for planets and passes). Empty on a polar day / white night. */
  dark: Interval[];
  /** Sun below −18° (astronomical darkness). */
  fullDark: Interval[];
  /** The time slider's range: sunset → sunrise, or the whole window when the Sun doesn't set or rise. */
  range: Interval;
  moon: MoonTonight;
  planets: PlanetTonight[];
}

function evMs(e: NightEvent): number | null {
  return e.state === "time" ? e.ms : null;
}

/** Highest point near sample `t` (golden-section search within ± one step), or the sample itself. */
function refineMax(f: (ms: number) => number, t: number, step: number, lo: number, hi: number): number {
  let a = Math.max(lo, t - step), b = Math.min(hi, t + step);
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(x1), f2 = f(x2);
  while (b - a > 30_000) {
    if (f1 > f2) {
      b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(x1);
    } else {
      a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(x2);
    }
  }
  const m = (a + b) / 2;
  return f(m) > f(t) ? m : t;
}

function planetTonight(id: SkyPlanet, obs: Observer, start: number, end: number, dark: Interval[], step: number): PlanetTonight {
  const alt = (t: number) => skyPosition(id, t, obs).alt;
  const samples = sampleFunction(alt, start, end, step);
  const { rs } = riseSetFrom((t) => alt(t) - PLANET_HORIZON, { t: samples.t, v: samples.v.map((v) => v - PLANET_HORIZON) });
  const visible = intersect(intervalsAbove(alt, samples, MIN_PLANET_ALT), dark);
  const mid = dark.length ? (dark[0]![0] + dark[dark.length - 1]![1]) / 2 : (start + end) / 2;
  let best: PlanetTonight["best"] = null;
  if (visible.length) {
    // The highest visible moment: an interval edge, or a sample inside refined to the true maximum.
    let bestMs = visible[0]![0], bestAlt = -90;
    const inside = (t: number) => visible.find(([a, b]) => t >= a && t <= b);
    for (const t of visible.flat()) {
      const v = alt(t);
      if (v > bestAlt) [bestMs, bestAlt] = [t, v];
    }
    samples.t.forEach((t, k) => {
      if (inside(t) && samples.v[k]! > bestAlt) [bestMs, bestAlt] = [t, samples.v[k]!];
    });
    const iv = inside(bestMs)!;
    if (bestMs > iv[0] && bestMs < iv[1]) bestMs = refineMax(alt, bestMs, step, iv[0], iv[1]);
    const p = skyPosition(id, bestMs, obs);
    best = { ms: bestMs, alt: p.alt, az: p.az };
  }
  const info = planetInfo(id, best?.ms ?? mid);
  const name = PLANET_NAMES[id];
  const elongation = info.elongation;
  let status: PlanetStatus, reason: string;
  if (elongation < GLARE_ELONGATION) {
    status = "glare";
    reason = `Too close to the Sun (${Math.round(elongation)}° away), lost in its glare`;
  } else if (!dark.length) {
    status = "no-dark";
    reason = "The sky doesn’t get dark enough tonight";
  } else if (visible.length) {
    status = "visible";
    reason = "";
  } else {
    const upAfterDark = intersect(intervalsAbove(alt, samples, 0), dark).length > 0;
    const upAtAll = samples.v.some((v) => v >= MIN_PLANET_ALT);
    if (upAfterDark) {
      status = "low";
      reason = `Stays below ${MIN_PLANET_ALT}° after dark`;
    } else if (upAtAll) {
      status = "daylight";
      reason = "Up only in daylight";
    } else {
      status = "below";
      reason = "Below the horizon all night";
    }
  }
  return { id, name, status, reason, best, visible, mag: info.mag, elongation, rs };
}

/**
 * Everything the panel lists for the observer's night containing `now` (or for `date`): events,
 * dark intervals, the Moon and each planet. ~20 ms in a desktop browser.
 */
export function computeTonight(obs: Observer, now: number, date = nightDate(now, obs), step = 10 * MINUTE): Tonight {
  const [start, end] = nightWindow(date, obs);
  const events = nightEvents(obs, date);
  const sunAlt = (t: number) => skyPosition("sun", t, obs).alt;
  const sunSamples = sampleFunction(sunAlt, start, end, step);
  const below = (limit: number): Interval[] => {
    const above = intervalsAbove(sunAlt, sunSamples, limit);
    const out: Interval[] = [];
    let t = start;
    for (const [a, b] of above) {
      if (a > t) out.push([t, a]);
      t = b;
    }
    if (t < end) out.push([t, end]);
    return out.filter(([a, b]) => b - a > 1000);
  };
  const dark = below(DARK_SUN_ALT);
  const fullDark = below(TWILIGHT.astronomical);
  const sunset = evMs(events.sunset), sunrise = evMs(events.sunrise);
  const range: Interval = [sunset ?? start, sunrise ?? end];
  const moonF = (t: number) => altitudeAboveHorizon("moon", t, obs);
  const { rs: moonRs, up: moonUp } = riseSetFrom(moonF, sampleFunction(moonF, start, end, step));
  const phaseAt = now >= start && now <= end ? now : (range[0] + range[1]) / 2;
  return {
    date,
    start,
    end,
    events,
    dark,
    fullDark,
    range,
    moon: { phase: moonPhase(phaseAt, obs), rs: moonRs, up: moonUp },
    planets: SKY_PLANETS.map((id) => planetTonight(id, obs, start, end, dark, step)),
  };
}

/* ------------------------------------------------------------------ */
/* Sky geometry                                                        */
/* ------------------------------------------------------------------ */

export interface AltAz {
  alt: number;
  az: number;
}

/**
 * Direction from `from` to `to` on the sky, degrees clockwise from "up" (towards the zenith) as
 * seen facing `from` — i.e. towards increasing azimuth. For the Moon and the Sun it is where the
 * Moon's lit side points.
 */
export function skyBearing(from: AltAz, to: AltAz): number {
  const a1 = from.alt * DEG, a2 = to.alt * DEG, dz = (to.az - from.az) * DEG;
  const y = Math.sin(dz) * Math.cos(a2);
  const x = Math.cos(a1) * Math.sin(a2) - Math.sin(a1) * Math.cos(a2) * Math.cos(dz);
  return ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
}

/** The point `dist` degrees from `p` along `bearing` (as in skyBearing). */
export function skyOffset(p: AltAz, bearing: number, dist: number): AltAz {
  const a = p.alt * DEG, b = bearing * DEG, d = dist * DEG;
  const sinAlt = Math.sin(a) * Math.cos(d) + Math.cos(a) * Math.sin(d) * Math.cos(b);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = p.az * DEG + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(a), Math.cos(d) - Math.sin(a) * sinAlt);
  return { alt: alt / DEG, az: ((az / DEG) % 360 + 360) % 360 };
}

/**
 * The sky dome as seen lying on your back: zenith in the centre, horizon on the circle of radius
 * `r`, north up and east on the LEFT (azimuthal equidistant: distance from the centre ∝ zenith angle).
 */
export function domePoint(p: AltAz, cx: number, cy: number, r: number): [number, number] {
  const d = (r * (90 - p.alt)) / 90;
  return [cx - d * Math.sin(p.az * DEG), cy - d * Math.cos(p.az * DEG)];
}

/** Angle on the dome (degrees clockwise from screen-up) of the direction `bearing` at point `p`. */
export function domeAngle(p: AltAz, bearing: number, cx: number, cy: number, r: number): number {
  const q = skyOffset(p, bearing, 0.5);
  const [x0, y0] = domePoint(p, cx, cy, r), [x1, y1] = domePoint(q, cx, cy, r);
  return (Math.atan2(x1 - x0, -(y1 - y0)) / DEG + 360) % 360;
}

/** Where the Moon's lit side points (degrees clockwise from up, facing the Moon) at `ms`. */
export function moonLitBearing(obs: Observer, ms: number): number {
  return skyBearing(skyPosition("moon", ms, obs), skyPosition("sun", ms, obs));
}

/** How dark the sky is for a Sun altitude (degrees). */
export function skyState(sunAlt: number): "day" | "civil" | "nautical" | "astronomical" | "night" {
  if (sunAlt >= -0.833) return "day";
  if (sunAlt >= TWILIGHT.civil) return "civil";
  if (sunAlt >= TWILIGHT.nautical) return "nautical";
  if (sunAlt >= TWILIGHT.astronomical) return "astronomical";
  return "night";
}

export const SKY_STATE_TEXT: Record<ReturnType<typeof skyState>, string> = {
  day: "daylight",
  civil: "civil twilight",
  nautical: "nautical twilight",
  astronomical: "astronomical twilight",
  night: "dark sky",
};

/** "high in the SE", "low in the W", "overhead". */
export function whereInSky(p: AltAz): string {
  if (p.alt >= 80) return "almost overhead";
  const height = p.alt < 20 ? "low" : p.alt < 50 ? "" : "high";
  return `${height ? `${height} ` : ""}in the ${compassPoint(p.az)}`;
}

/**
 * Plain sentences for the night's unusual cases (polar day and night, no full darkness), or [] for
 * an ordinary night.
 */
export function nightSentences(ev: NightEvents): string[] {
  const out: string[] = [];
  if (ev.sunset.state === "always-above") out.push("The Sun doesn’t set tonight: it is polar day here.");
  else if (ev.sunset.state === "always-below") out.push("The Sun doesn’t rise today: it is polar night here.");
  else if (ev.civilDusk.state === "always-above") out.push("The Sun sets, but stays above −6°: the sky stays bright all night (white night).");
  else if (ev.astronomicalDusk.state === "always-above") out.push("The sky never gets fully dark tonight: the Sun stays above −18°, so twilight lasts all night.");
  if (ev.sunset.state === "always-below") {
    if (ev.civilDusk.state === "always-above") out.push("The Sun stays just below the horizon, so it is civil twilight all day.");
    else if (ev.astronomicalDusk.state === "always-below") out.push("It is fully dark around the clock.");
    else out.push("Twilight brightens the sky around midday.");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Location and formatting (the panel's pure helpers)                  */
/* ------------------------------------------------------------------ */

export interface SkyLocation {
  kind: "preset" | "manual" | "device";
  /** Preset city name, else null. */
  name: string | null;
  lat: number;
  lon: number;
  /** IANA zone for preset cities; null = the browser's own zone. */
  timeZone: string | null;
}

/** localStorage key (via src/core/storage.ts) for the chosen location. */
export const LOCATION_KEY = "sky:location";

function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A stored location, validated (storage is user-editable), or null. */
export function parseLocation(raw: unknown): SkyLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "preset" && r.kind !== "manual" && r.kind !== "device") return null;
  if (typeof r.lat !== "number" || typeof r.lon !== "number") return null;
  const obs = toObserver(r.lat, r.lon);
  if (!obs) return null;
  const name = typeof r.name === "string" && r.name.length <= 60 ? r.name : null;
  return { kind: r.kind, name: r.kind === "preset" ? name : null, lat: obs.lat, lon: obs.lon, timeZone: validZone(r.timeZone) ? r.timeZone : null };
}

/** "6.20° S, 106.80° E". */
export function formatCoords(lat: number, lon: number): string {
  const f = (x: number) => Math.abs(x).toFixed(2);
  return `${f(lat)}° ${lat < 0 ? "S" : "N"}, ${f(lon)}° ${lon < 0 ? "W" : "E"}`;
}

/** "UTC+7", "UTC−3:30", "UTC". */
export function utcOffsetLabel(ms: number, tz: string): string {
  const off = timeZoneOffset(ms, tz);
  if (!off) return "UTC";
  const a = Math.abs(off);
  return `UTC${off < 0 ? "−" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

/** Parse a coordinate typed by a visitor ("−6.2", "6,2"), or NaN. */
export function parseCoordinate(text: string): number {
  const t = text.trim().replace(/[−–]/g, "-").replace(",", ".").replace(/°$/, "");
  return /^-?\d{1,3}(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}
/** "21:40" in the location's zone. */
export const hhmm = (ms: number, tz: string) => formatter(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
/** "Tue 3 Nov" in the location's zone. */
export const dayLabel = (ms: number, tz: string) => formatter(tz, { weekday: "short", day: "numeric", month: "short" }).format(ms).replace(",", "");

/** Magnitude with a real minus sign: "−3.1". */
export function fmtMag(m: number): string {
  const r = Math.round(m * 10) / 10;
  return `${r < 0 ? "−" : ""}${Math.abs(r).toFixed(1)}`;
}

/** "19:42–19:48", or "19:42 · 40 s" for a pass shorter than two minutes. */
export function passTimes(p: Pick<VisiblePass, "start" | "end">, tz: string): string {
  const dur = p.end.ms - p.start.ms;
  return dur < 2 * MINUTE ? `${hhmm(p.start.ms, tz)} · ${Math.max(1, Math.round(dur / 1000))} s` : `${hhmm(p.start.ms, tz)}–${hhmm(p.end.ms, tz)}`;
}

