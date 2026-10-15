import type { CloseApproach, OrbitsData, SmallBodyOrbit } from "../../shared/contract";
import {
  closestApproach, earthPosition, jdTdb, KM_PER_AU, moonGeocentric, msFromJdTdb, norm, planetElements, planetPosition,
  sub, keplerPosition, type PlanetId, type Vec3,
} from "../../shared/orbit";

/**
 * Everything the 3D Solar System shows, computed in the browser from published orbital data
 * (shared/orbit.ts). No three.js here, so the panel's list, details and WebGL fallback use the
 * same numbers as the 3D view without loading the 3D library.
 */

export const KM_PER_LD = 384_400;
export const AU_PER_LD = KM_PER_LD / KM_PER_AU;

/** The time range the panel allows: inside the 1800–2050 fit of JPL's planetary elements. */
export const TIME_MIN = Date.UTC(1900, 0, 1);
export const TIME_MAX = Date.UTC(2049, 11, 31, 23, 59);

export type BodyId = "sun" | "mercury" | "venus" | "earth" | "moon" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";

export interface MajorBody {
  id: BodyId;
  name: string;
  /** Equatorial radius, km (for the true-size sphere shown when zoomed in). */
  radiusKm: number;
  /** Element set used for its orbit line (Earth's orbit is the Earth–Moon barycentre's). */
  planet?: PlanetId;
}

export const BODIES: MajorBody[] = [
  { id: "sun", name: "Sun", radiusKm: 695_700 },
  { id: "mercury", name: "Mercury", radiusKm: 2_440, planet: "mercury" },
  { id: "venus", name: "Venus", radiusKm: 6_052, planet: "venus" },
  { id: "earth", name: "Earth", radiusKm: 6_378, planet: "emb" },
  { id: "moon", name: "Moon", radiusKm: 1_737 },
  { id: "mars", name: "Mars", radiusKm: 3_396, planet: "mars" },
  { id: "jupiter", name: "Jupiter", radiusKm: 71_492, planet: "jupiter" },
  { id: "saturn", name: "Saturn", radiusKm: 60_268, planet: "saturn" },
  { id: "uranus", name: "Uranus", radiusKm: 25_559, planet: "uranus" },
  { id: "neptune", name: "Neptune", radiusKm: 24_764, planet: "neptune" },
];

export function isBodyId(id: string): id is BodyId {
  return BODIES.some((b) => b.id === id);
}

/** Heliocentric ecliptic J2000 positions (au) of the Sun, planets, Earth and Moon. */
export function bodyPositions(jd: number): Record<BodyId, Vec3> {
  const earth = earthPosition(jd);
  const m = moonGeocentric(jd);
  const out = { sun: [0, 0, 0], earth, moon: [earth[0] + m[0], earth[1] + m[1], earth[2] + m[2]] } as Record<BodyId, Vec3>;
  for (const b of BODIES) if (b.planet && b.id !== "earth") out[b.id] = planetPosition(b.planet, jd);
  return out;
}

/** Orbital period of a planet (days) from its current elements. */
export function planetPeriodDays(id: PlanetId, jd: number): number {
  const a = planetElements(id, jd).a;
  return 365.256898 * a ** 1.5;
}

/** The CAD API gives times in TDB; convert them to UTC ms (69 s earlier). */
export function cadTimeToUtcMs(iso: string): number {
  return msFromJdTdb(Date.parse(iso) / 86_400_000 + 2440587.5);
}

export interface Asteroid {
  des: string;
  label: string;
  approach: CloseApproach;
  orbit: SmallBodyOrbit | null;
  /** Official (CNEOS, n-body) close-approach time, UTC ms. */
  caMs: number;
}

export function asteroidsFrom(data: OrbitsData): Asteroid[] {
  return data.approaches.map((a) => ({
    des: a.des,
    label: a.name.replace(/^\((.*)\)$/, "$1").trim(),
    approach: a,
    orbit: data.orbits[a.des] ?? null,
    caMs: cadTimeToUtcMs(a.time),
  }));
}

export type AsteroidStatus = "approaching" | "passed";

/** Before or after its official closest approach, at the displayed time. PHA is a separate flag. */
export function asteroidStatus(a: Asteroid, ms: number): AsteroidStatus {
  return a.caMs < ms ? "passed" : "approaching";
}

export function asteroidPosition(a: Asteroid, jd: number): Vec3 | null {
  return a.orbit ? keplerPosition(a.orbit, jd) : null;
}

export interface ModelApproach {
  /** UTC ms of the closest approach in the two-body model. */
  ms: number;
  distAu: number;
  /** (model − official) / official distance. */
  relDiff: number;
  /** Model time − official time, hours. */
  dtHours: number;
}

const modelCache = new WeakMap<Asteroid, ModelApproach | null>();

/** The two-body model's own closest approach near the official time (for honesty about accuracy). */
export function modelApproach(a: Asteroid): ModelApproach | null {
  if (modelCache.has(a)) return modelCache.get(a)!;
  let out: ModelApproach | null = null;
  if (a.orbit) {
    const ca = closestApproach(a.orbit, jdTdb(a.caMs), 4);
    const ms = msFromJdTdb(ca.jd);
    out = { ms, distAu: ca.dist, relDiff: (ca.dist - a.approach.distAu) / a.approach.distAu, dtHours: (ms - a.caMs) / 3_600_000 };
  }
  modelCache.set(a, out);
  return out;
}

export type Agreement = "good" | "fair" | "poor";

/** How well the two-body path reproduces the official approach (shown on every selection). */
export function agreement(m: ModelApproach | null): Agreement | null {
  if (!m) return null;
  const r = Math.abs(m.relDiff);
  if (r <= 0.05 && Math.abs(m.dtHours) <= 2) return "good";
  if (r <= 0.15 && Math.abs(m.dtHours) <= 12) return "fair";
  return "poor";
}

/** Distance from Earth (au) at `jd`, or null without an orbit. */
export function earthDistance(a: Asteroid, jd: number, earth = earthPosition(jd)): number | null {
  const p = asteroidPosition(a, jd);
  return p ? norm(sub(p, earth)) : null;
}

/** Geocentric path of an asteroid around `centerMs` (±days), placed at Earth's position at `jd`. */
export function geocentricTrack(a: Asteroid, centerMs: number, days: number, steps: number, earthNow: Vec3): Vec3[] {
  const out: Vec3[] = [];
  if (!a.orbit) return out;
  for (let k = 0; k <= steps; k++) {
    const ms = centerMs + (steps ? -days + (2 * days * k) / steps : 0) * 86_400_000;
    const jd = jdTdb(ms);
    const r = sub(keplerPosition(a.orbit, jd), earthPosition(jd));
    out.push([earthNow[0] + r[0], earthNow[1] + r[1], earthNow[2] + r[2]]);
  }
  return out;
}

/** The Moon's geocentric orbit over one sidereal month around `jd`, placed at Earth. */
export function moonTrack(jd: number, earthNow: Vec3, steps = 96): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k <= steps; k++) {
    const m = moonGeocentric(jd - 13.66 + (27.32 * k) / steps);
    out.push([earthNow[0] + m[0], earthNow[1] + m[1], earthNow[2] + m[2]]);
  }
  return out;
}

export function fmtDistance(au: number): string {
  const ld = au / AU_PER_LD;
  if (ld < 100) return `${ld < 10 ? ld.toFixed(2) : ld.toFixed(1)} LD`;
  return `${au < 10 ? au.toFixed(3) : au.toFixed(2)} au`;
}
