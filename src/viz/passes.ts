/**
 * Visible passes of bright spacecraft (v4, "Sky tonight"): SGP4 propagation of CelesTrak elements
 * (satellite.js) and a search for the times each one is high enough, sunlit and seen against a dark
 * enough sky. Everything runs in the browser; the observer's location never leaves it.
 *
 * This is the only file that imports `satellite.js`. The panel loads it with `import()`, so the
 * library stays out of the main bundle (like three.js in `orrery3d.ts`).
 *
 * Model and its limits:
 * - SGP4 (Vallado et al. 2006 revision, "improved" mode) in the TEME frame; GMST (IAU 1982) turns
 *   it into Earth-fixed coordinates. Accuracy is limited by the element set: about a kilometre at
 *   epoch, growing by kilometres per day (seconds of timing), more after a reboost.
 * - Earth's shadow is a cylinder of the Earth's equatorial radius (no penumbra, no atmosphere):
 *   entry and exit times are off by a few seconds.
 * - "Visible" = above 10° altitude, sunlit, and the Sun below −6° (civil twilight) for the observer.
 * - Brightness uses McCants' convention: standard magnitude (1,000 km, half lit) scaled by range and
 *   the illuminated fraction of a sphere, (1 + cos phase)/2. Real spacecraft vary by a magnitude
 *   or more with attitude, and flare.
 */

import {
  ecfToEci, ecfToLookAngles, eciToEcf, geodeticToEcf, gstime, json2satrec, propagate, SatRecError,
  type EcfVec3, type GeodeticLocation, type SatRec,
} from "satellite.js";
import type { SatelliteElements } from "../../shared/contract";
import type { Vec3 } from "../../shared/orbit";
import {
  nightDate, nightWindow, refineCrossings, sampleFunction, skyPosition, sunVectorOfDate, vectorAngle, TWILIGHT,
  type Observer,
} from "../../shared/sky";

const DEG = Math.PI / 180;
const MINUTE = 60_000;
const DAY = 86_400_000;
/** Earth's equatorial radius, km (radius of the shadow cylinder). */
const EARTH_RADIUS_KM = 6378.137;

/** A pass counts from this altitude (degrees): lower passes are lost in haze and buildings. */
export const MIN_ALTITUDE = 10;
/** The observer's Sun must be below this altitude (degrees) for a pass to be visible. */
export const MAX_SUN_ALTITUDE = TWILIGHT.civil;
/** Search step, ms. A pass above 10° lasts at least ~1 min for these orbits, so none is missed. */
export const STEP_MS = 20_000;
/** Edge times are refined to this, ms. */
const EDGE_TOL_MS = 500;
/** Elements older than this (days) aren't used at all: errors reach many minutes. */
export const MAX_ELEMENT_AGE_DAYS = 30;

export interface PassPoint {
  ms: number;
  /** Geometric altitude, degrees. */
  alt: number;
  /** Azimuth from north through east, degrees. */
  az: number;
}

/** Why a visible pass starts or ends there. */
export type PassEdgeCause =
  /** Crosses 10° altitude. */
  | "horizon"
  /** Leaves or enters the Earth's shadow. */
  | "shadow"
  /** The sky gets dark enough or too bright (the Sun crosses −6°). */
  | "twilight"
  /** The search window starts or ends mid-pass. */
  | "window";

export interface VisiblePass {
  satId: number;
  name: string;
  start: PassPoint & { cause: PassEdgeCause };
  /** Highest point of the visible part (can be an edge if it fades into the shadow before culmination). */
  peak: PassPoint & { rangeKm: number };
  end: PassPoint & { cause: PassEdgeCause };
  /** Brightest estimated magnitude during the visible part. */
  mag: number;
  /** Positions every ~20 s across the visible part, edges and peak included, in time order. */
  track: PassPoint[];
}

export interface SatellitePasses {
  id: number;
  name: string;
  /** Element age at the start of the search, days. */
  ageDays: number;
  passes: VisiblePass[];
  /** Why nothing could be predicted (elements too old, SGP4 failure), else null. */
  error: string | null;
}

export interface PassPrediction {
  satellites: SatellitePasses[];
  /** All visible passes, in time order. */
  passes: VisiblePass[];
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** True when a satellite (geocentric, km) is in the Earth's cylindrical shadow; `sunDir` is a unit vector. */
export function inEarthShadow(sat: Vec3, sunDir: Vec3): boolean {
  const along = dot(sat, sunDir);
  if (along >= 0) return false;
  const perp: Vec3 = [sat[0] - along * sunDir[0], sat[1] - along * sunDir[1], sat[2] - along * sunDir[2]];
  return Math.hypot(...perp) < EARTH_RADIUS_KM;
}

/**
 * Estimated visual magnitude from a standard magnitude (1,000 km, half illuminated), the range (km)
 * and the phase angle at the satellite between the Sun and the observer (degrees; 0 = fully lit):
 * m = std − 15.75 + 2.5·log10(range² / f), f = (1 + cos phase)/2 (McCants).
 */
export function estimateMagnitude(stdMag: number, rangeKm: number, phaseDeg: number): number {
  const f = Math.max(1e-4, (1 + Math.cos(phaseDeg * DEG)) / 2);
  return stdMag - 15.75 + 2.5 * Math.log10((rangeKm * rangeKm) / f);
}

/** Intervals within [start, end] when the observer's Sun is below `limit` degrees, UTC ms. */
export function darkIntervals(obs: Observer, start: number, end: number, limit = MAX_SUN_ALTITUDE): [number, number][] {
  const sunAlt = (t: number) => skyPosition("sun", t, obs).alt;
  const samples = sampleFunction(sunAlt, start, end, 10 * MINUTE);
  const out: [number, number][] = [];
  let open: number | null = samples.v[0]! < limit ? start : null;
  for (const c of refineCrossings(sunAlt, samples, limit)) {
    if (!c.rising && open === null) open = c.ms;
    else if (c.rising && open !== null) {
      out.push([open, c.ms]);
      open = null;
    }
  }
  if (open !== null) out.push([open, end]);
  return out;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** From `now` to the end of the observer's `nights`-th night (tonight counts as the first), UTC ms. */
export function passSearchWindow(now: number, obs: Observer, nights = 4): [number, number] {
  return [now, nightWindow(addDays(nightDate(now, obs), nights - 1), obs)[1]];
}

/* ------------------------------------------------------------------ */
/* Propagation                                                         */
/* ------------------------------------------------------------------ */

interface State extends PassPoint {
  rangeKm: number;
  sunlit: boolean;
  mag: number;
  /** Angle at the Earth's centre between the observer and the satellite, degrees. */
  centralAngle: number;
}

interface Context {
  satrec: SatRec;
  stdMag: number;
  site: GeodeticLocation;
  siteEcf: EcfVec3<number>;
  /** False to find every pass above 10°, lit or not (for checks against ephemerides). */
  requireSunlit: boolean;
  /** Largest central angle (degrees) at which the satellite can be above 10° (with a margin). */
  reachDeg: number;
  /** Upper bound on how fast that central angle can change, degrees per ms. */
  rateDegPerMs: number;
}

/** Earth's gravitational parameter, km³/s², and rotation rate, rad/s. */
const MU_EARTH = 398600.4418;
const EARTH_ROTATION = 7.2921159e-5;

/**
 * Bounds for skipping ahead while a satellite is far from the observer. Above 10°, the central angle
 * θ between the observer and the satellite is at most acos(R·cos 10° / r) − 10° (a sphere of the
 * polar radius and the orbit's apogee radius make it generous), and θ changes no faster than the
 * satellite's fastest angular motion plus the Earth's rotation. So while θ exceeds that reach, no
 * pass can start for (θ − reach) / rate, and the 20-s scan jumps ahead (≈ 15× faster).
 */
function skipBounds(satrec: SatRec): Pick<Context, "reachDeg" | "rateDegPerMs"> {
  const n = satrec.no / 60; // rad/s
  const e = satrec.ecco;
  const rMax = Math.cbrt(MU_EARTH / (n * n)) * (1 + e);
  const el = MIN_ALTITUDE * DEG;
  const reach = Math.acos(Math.min(1, (6356.752 * Math.cos(el)) / rMax)) - el;
  const rate = (n * (1 + e) ** 2) / (1 - e * e) ** 1.5 + EARTH_ROTATION; // rad/s
  return { reachDeg: reach / DEG + 1, rateDegPerMs: ((rate * 1.05) / DEG) / 1000 };
}

/** Satellite position seen by the observer at `ms`, or null if SGP4 fails (e.g. decayed). */
function stateAt(ctx: Context, ms: number): State | null {
  const date = new Date(ms);
  const pv = propagate(ctx.satrec, date, { communityDecayCheckEnabled: true });
  if (!pv) return null;
  const p = pv.position;
  const gmst = gstime(date);
  const look = ecfToLookAngles(ctx.site, eciToEcf(p, gmst));
  const sun = sunVectorOfDate(ms);
  const r = Math.hypot(...sun);
  const sunDir: Vec3 = [sun[0] / r, sun[1] / r, sun[2] / r];
  const sat: Vec3 = [p.x, p.y, p.z];
  const site = ecfToEci(ctx.siteEcf, gmst);
  const toObserver: Vec3 = [site.x - p.x, site.y - p.y, site.z - p.z];
  return {
    centralAngle: vectorAngle(sat, [site.x, site.y, site.z]),
    ms,
    alt: look.elevation / DEG,
    az: ((look.azimuth / DEG) % 360 + 360) % 360,
    rangeKm: look.rangeSat,
    sunlit: !inEarthShadow(sat, sunDir),
    mag: estimateMagnitude(ctx.stdMag, look.rangeSat, vectorAngle(sunDir, toObserver)),
  };
}

const isVisible = (ctx: Context, s: State | null): s is State => !!s && s.alt >= MIN_ALTITUDE && (s.sunlit || !ctx.requireSunlit);

/** The visibility edge between `lo` (not visible) and `hi` (visible), either order in time. */
function refineEdge(ctx: Context, lo: State | null, loMs: number, hi: State): { state: State; cause: PassEdgeCause } {
  let a = loMs, b = hi.ms, sa = lo, sb = hi;
  while (Math.abs(b - a) > EDGE_TOL_MS) {
    const mid = (a + b) / 2, sm = stateAt(ctx, mid);
    if (isVisible(ctx, sm)) [b, sb] = [mid, sm];
    else [a, sa] = [mid, sm];
  }
  const cause: PassEdgeCause = sa && sa.alt >= MIN_ALTITUDE && !sa.sunlit ? "shadow" : "horizon";
  return { state: sb, cause };
}

/** Highest point between `a` and `b` (golden-section search; altitude is unimodal over a pass). */
function refinePeak(ctx: Context, a: number, b: number, best: State): State {
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a), x2 = a + g * (b - a);
  let s1 = stateAt(ctx, x1), s2 = stateAt(ctx, x2);
  while (b - a > 200 && s1 && s2) {
    if (s1.alt > s2.alt) {
      b = x2; x2 = x1; s2 = s1; x1 = b - g * (b - a); s1 = stateAt(ctx, x1);
    } else {
      a = x1; x1 = x2; s1 = s2; x2 = a + g * (b - a); s2 = stateAt(ctx, x2);
    }
  }
  const c = [best, s1, s2].filter((s): s is State => !!s);
  return c.reduce((m, s) => (s.alt > m.alt ? s : m));
}

function buildPass(sat: SatelliteElements, run: State[], start: { state: State; cause: PassEdgeCause }, end: { state: State; cause: PassEdgeCause }, ctx: Context): VisiblePass {
  const best = run.reduce((m, s) => (s.alt > m.alt ? s : m));
  const peak = refinePeak(ctx, Math.max(start.state.ms, best.ms - STEP_MS), Math.min(end.state.ms, best.ms + STEP_MS), best);
  const all = [start.state, ...run, peak, end.state]
    .filter((s, i, arr) => s.ms >= start.state.ms && s.ms <= end.state.ms && arr.findIndex((o) => o.ms === s.ms) === i)
    .sort((x, y) => x.ms - y.ms);
  const point = (s: State): PassPoint => ({ ms: Math.round(s.ms), alt: s.alt, az: s.az });
  return {
    satId: sat.id,
    name: sat.name,
    start: { ...point(start.state), cause: start.cause },
    peak: { ...point(peak), rangeKm: peak.rangeKm },
    end: { ...point(end.state), cause: end.cause },
    mag: Math.min(...all.map((s) => s.mag)),
    track: all.map(point),
  };
}

/** Visible passes of one satellite inside the given dark intervals. */
function passesFor(sat: SatelliteElements, ctx: Context, dark: [number, number][], windowStart: number, windowEnd: number): VisiblePass[] {
  const out: VisiblePass[] = [];
  for (const [a, b] of dark) {
    let prev: State | null = null;
    let prevMs = a;
    let run: State[] = [];
    let start: { state: State; cause: PassEdgeCause } | null = null;
    for (let t = a; ; ) {
      const s = stateAt(ctx, t);
      const vis = isVisible(ctx, s);
      if (vis && !start) {
        start = t === a ? { state: s, cause: a === windowStart ? "window" : "twilight" } : refineEdge(ctx, prev, prevMs, s);
      }
      if (vis) run.push(s);
      if (!vis && start && prev) {
        out.push(buildPass(sat, run, start, refineEdge(ctx, s, t, prev), ctx));
        start = null;
        run = [];
      }
      if (t >= b) {
        if (start && vis) out.push(buildPass(sat, run, start, { state: s, cause: b === windowEnd ? "window" : "twilight" }, ctx));
        break;
      }
      prev = s;
      prevMs = t;
      // Far from the observer, jump ahead as far as no pass can start (see skipBounds).
      const skip = !start && s ? (s.centralAngle - ctx.reachDeg) / ctx.rateDegPerMs : 0;
      t = Math.min(t + Math.max(STEP_MS, skip), b);
    }
  }
  return out;
}

function siteOf(obs: Observer): Pick<Context, "site" | "siteEcf"> {
  const site: GeodeticLocation = { latitude: obs.lat * DEG, longitude: obs.lon * DEG, height: (obs.height ?? 0) / 1000 };
  return { site, siteEcf: geodeticToEcf(site) };
}

function satrecOf(sat: SatelliteElements): SatRec | string {
  try {
    const satrec = json2satrec({ ...sat.omm });
    return satrec.error === SatRecError.None ? satrec : "Its orbital elements couldn’t be used (SGP4 error).";
  } catch {
    return "Its orbital elements couldn’t be read.";
  }
}

/**
 * Visible passes of each satellite between `start` and `end` (UTC ms) for an observer. Satellites
 * fail independently: one with bad or very old elements gets an `error` and no passes.
 */
export function predictPasses(sats: readonly SatelliteElements[], obs: Observer, start: number, end: number): PassPrediction {
  const dark = darkIntervals(obs, start, end);
  const site = siteOf(obs);
  const satellites: SatellitePasses[] = sats.map((sat) => {
    const ageDays = (start - Date.parse(sat.epoch)) / DAY;
    const base = { id: sat.id, name: sat.name, ageDays };
    if (!(Math.abs(ageDays) <= MAX_ELEMENT_AGE_DAYS)) {
      return { ...base, passes: [], error: `Its orbital elements are ${Math.round(Math.abs(ageDays))} days from the search dates, too far for useful predictions.` };
    }
    const satrec = satrecOf(sat);
    if (typeof satrec === "string") return { ...base, passes: [], error: satrec };
    const passes = passesFor(sat, { satrec, stdMag: sat.stdMag, ...site, ...skipBounds(satrec), requireSunlit: true }, dark, start, end);
    const failed = satrec.error !== SatRecError.None;
    return { ...base, passes: failed ? [] : passes, error: failed ? "Its orbit couldn’t be propagated over these dates (SGP4 error or decayed)." : null };
  });
  const passes = satellites.flatMap((s) => s.passes).sort((x, y) => x.start.ms - y.start.ms);
  return { satellites, passes };
}

/**
 * Every pass above 10° between `start` and `end`, day or night, lit or not (for checks against
 * ephemerides). `skipAhead: false` scans every 20 s (to test the skipping).
 */
export function passesAboveHorizon(sat: SatelliteElements, obs: Observer, start: number, end: number, { skipAhead = true } = {}): VisiblePass[] {
  const satrec = satrecOf(sat);
  if (typeof satrec === "string") throw new Error(satrec);
  const bounds = skipAhead ? skipBounds(satrec) : { reachDeg: 180, rateDegPerMs: 1 };
  return passesFor(sat, { satrec, stdMag: sat.stdMag, ...siteOf(obs), ...bounds, requireSunlit: false }, [[start, end]], start, end);
}

/** Where a satellite is in the observer's sky at `ms` (null if SGP4 fails), with its estimated magnitude. */
export function satellitePosition(sat: SatelliteElements, obs: Observer, ms: number): (PassPoint & { rangeKm: number; sunlit: boolean; mag: number }) | null {
  const satrec = satrecOf(sat);
  if (typeof satrec === "string") return null;
  const s = stateAt({ satrec, stdMag: sat.stdMag, ...siteOf(obs), ...skipBounds(satrec), requireSunlit: true }, ms);
  return s && { ms: s.ms, alt: s.alt, az: s.az, rangeKm: s.rangeKm, sunlit: s.sunlit, mag: s.mag };
}
