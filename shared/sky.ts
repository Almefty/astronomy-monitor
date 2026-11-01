/**
 * Topocentric astronomy for the "Sky tonight" panel (v4): where the Sun, Moon and planets are in
 * an observer's sky, how bright the planets are, the Moon's phase, and the night's events
 * (sunset, twilight, rise/transit/set). Pure and dependency-free (no DOM, no three.js): everything
 * runs in the browser, and the observer's location is never sent anywhere.
 *
 * Frames and time:
 * - Input times are UTC ms. UT1 is taken as UTC (|UT1 − UTC| < 0.9 s, ≈ 0.004° of sky rotation);
 *   dynamical time is UTC + 69.184 s (`jdTdb` in shared/orbit.ts).
 * - Planets and the Moon come from shared/orbit.ts (heliocentric/geocentric, ecliptic J2000), are
 *   rotated to equatorial J2000, light-time corrected (planets), and precessed to the mean equator
 *   and equinox of date (IAU 1976). The Sun comes from Meeus ch. 25 directly in the frame of date.
 * - Sidereal time is IAU 1982 GMST, consistent with the mean equinox of date. Nutation (≤ ~0.005°)
 *   and planetary aberration (≤ 0.006°) are ignored; the Sun's annual aberration is included.
 * - Altitudes are geometric (airless) unless a function says "apparent"; `refraction` adds the
 *   standard atmosphere for display. Rise/set use the conventional limits, which already include it.
 *
 * Accuracy is checked against JPL Horizons and USNO in test/sky.test.ts (see the limits there).
 */

import { DEG, julianDate, norm360 } from "./astro";
import { earthPosition, J2000, jdTdb, KM_PER_AU, moonGeocentric, norm, planetPosition, sub, type PlanetId, type Vec3 } from "./orbit";

/** Mean obliquity of the ecliptic at J2000.0 (IAU 1976), degrees. */
export const OBLIQUITY_J2000 = 23.4392911;
/** Speed of light, au per day. */
const C_AU_PER_DAY = 173.1446327;
/** WGS 84 equatorial radius (km) and flattening. */
const EARTH_RADIUS_KM = 6378.137;
const EARTH_FLATTENING = 1 / 298.257223563;
const MOON_RADIUS_KM = 1737.4;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type SkyPlanet = Exclude<PlanetId, "emb">;
export type SkyBody = "sun" | "moon" | SkyPlanet;
export const SKY_PLANETS: readonly SkyPlanet[] = ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"];

/** An observer on the Earth's surface: geodetic latitude, east longitude (degrees), height (m). */
export interface Observer {
  lat: number;
  lon: number;
  height?: number;
}

/* ------------------------------------------------------------------ */
/* Vectors and angles                                                  */
/* ------------------------------------------------------------------ */

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** Angle between two vectors, degrees (stable near 0° and 180°). */
export function vectorAngle(a: Vec3, b: Vec3): number {
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(norm(c), dot(a, b)) / DEG;
}

/** Wrap an angle to (−180°, 180°]. */
export function norm180(x: number): number {
  const y = norm360(x);
  return y > 180 ? y - 360 : y;
}

/** Equatorial (or ecliptic) vector → right ascension / declination (degrees) and length. */
export function vecToRaDec(v: Vec3): { ra: number; dec: number; dist: number } {
  const dist = norm(v);
  return { ra: norm360(Math.atan2(v[1], v[0]) / DEG), dec: Math.asin(v[2] / dist) / DEG, dist };
}

export function raDecToVec(ra: number, dec: number, dist = 1): Vec3 {
  const a = ra * DEG, d = dec * DEG;
  return [dist * Math.cos(d) * Math.cos(a), dist * Math.cos(d) * Math.sin(a), dist * Math.sin(d)];
}

/** Rotate about the x axis by +ε: ecliptic → equatorial (same equinox). */
function eclipticToEquatorialVec(v: Vec3, eps: number): Vec3 {
  const c = Math.cos(eps * DEG), s = Math.sin(eps * DEG);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

/** Ecliptic J2000 → equatorial J2000 (ICRF to well under an arcsecond). */
export function eclipticToEquatorialJ2000(v: Vec3): Vec3 {
  return eclipticToEquatorialVec(v, OBLIQUITY_J2000);
}

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

/** Greenwich mean sidereal time (IAU 1982, Meeus 12.4), degrees. */
export function gmst(ms: number): number {
  const d = julianDate(ms) - J2000;
  const T = d / 36525;
  return norm360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T ** 3 / 38_710_000);
}

/** Local mean sidereal time at east longitude `lon`, degrees. */
export function localSiderealTime(ms: number, lon: number): number {
  return norm360(gmst(ms) + lon);
}

/* ------------------------------------------------------------------ */
/* Precession (IAU 1976, Lieske et al. 1977; Meeus 21.2)               */
/* ------------------------------------------------------------------ */

export type Mat3 = [number, number, number, number, number, number, number, number, number];

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r as Mat3;
}

/** Rotation of the axes about z by `a` (radians). */
function rotZ(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** Rotation of the axes about y by `a` (radians). */
function rotY(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}

/** Matrix taking equatorial J2000 vectors to the mean equator and equinox of `jdTT`. */
export function precessionMatrix(jdTT: number): Mat3 {
  const T = (jdTT - J2000) / 36525;
  const as = DEG / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * as;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * as;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * as;
  return mul(rotZ(-z), mul(rotY(theta), rotZ(-zeta)));
}

function apply(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Equatorial J2000 vector → mean equator and equinox of date. */
export function precessFromJ2000(v: Vec3, jdTT: number): Vec3 {
  return apply(precessionMatrix(jdTT), v);
}

/* ------------------------------------------------------------------ */
/* Observer and horizon                                                */
/* ------------------------------------------------------------------ */

/**
 * The observer's geocentric position (au) in the equatorial frame of date, for local sidereal
 * time `lst` (degrees). Uses the WGS 84 ellipsoid (Meeus ch. 11).
 */
export function observerVector(obs: Observer, lst: number): Vec3 {
  const phi = obs.lat * DEG;
  const u = Math.atan((1 - EARTH_FLATTENING) * Math.tan(phi));
  const h = (obs.height ?? 0) / 1000 / EARTH_RADIUS_KM;
  const rhoSin = (1 - EARTH_FLATTENING) * Math.sin(u) + h * Math.sin(phi);
  const rhoCos = Math.cos(u) + h * Math.cos(phi);
  const r = EARTH_RADIUS_KM / KM_PER_AU;
  return [r * rhoCos * Math.cos(lst * DEG), r * rhoCos * Math.sin(lst * DEG), r * rhoSin];
}

/**
 * Equatorial (of date) → horizontal. Altitude above the geometric horizon and azimuth from north
 * through east, degrees. `lat` is the geodetic latitude, `lst` the local sidereal time.
 */
export function equatorialToHorizontal(ra: number, dec: number, lst: number, lat: number): { alt: number; az: number } {
  const H = (lst - ra) * DEG, d = dec * DEG, p = lat * DEG;
  const up = Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H);
  const east = -Math.sin(H) * Math.cos(d);
  const north = Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(H);
  // atan2 keeps full precision near the zenith, where asin does not.
  return { alt: Math.atan2(up, Math.hypot(east, north)) / DEG, az: norm360(Math.atan2(east, north) / DEG) };
}

/**
 * Standard atmospheric refraction (10 °C, 1010 hPa) for a geometric altitude, degrees
 * (Sæmundsson 1986, Meeus 16.4). Below −1° the value is tapered to 0 at −5°: refraction is
 * meaningless below the horizon, but plots stay continuous.
 */
export function refraction(alt: number): number {
  if (alt >= 90) return 0;
  const h = Math.max(alt, -1);
  const r = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG) / 60;
  if (alt >= -1) return r;
  return r * Math.max(0, (alt + 5) / 4);
}

/** Refraction for an observed (apparent) altitude, degrees (Bennett 1982, Meeus 16.3). */
export function refractionFromApparent(apparent: number): number {
  if (apparent >= 90) return 0;
  return 1 / Math.tan((apparent + 7.31 / (apparent + 4.4)) * DEG) / 60;
}

/** Altitude as seen through the standard atmosphere (for display, not for geometry). */
export function apparentAltitude(alt: number): number {
  return alt + refraction(alt);
}

/* ------------------------------------------------------------------ */
/* Sun (Meeus ch. 25, low accuracy, ~0.01°)                            */
/* ------------------------------------------------------------------ */

/** Mean obliquity of the ecliptic of date (IAU 1976, Meeus 22.2), degrees. */
export function meanObliquity(jdTT: number): number {
  const T = (jdTT - J2000) / 36525;
  return 23.4392911 - 0.0130041667 * T - 1.6389e-7 * T * T + 5.0361e-7 * T ** 3;
}

/**
 * Geocentric Sun, equatorial vector of the mean equator and equinox of date, au. Includes the
 * annual aberration (−20.5″ in longitude); excludes nutation, like every position in this module.
 */
export function sunVectorOfDate(ms: number): Vec3 {
  const jd = jdTdb(ms);
  const T = (jd - J2000) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(M + C * DEG));
  const lon = (L0 + C - 0.00569) * DEG;
  return eclipticToEquatorialVec([R * Math.cos(lon), R * Math.sin(lon), 0], meanObliquity(jd));
}

/* ------------------------------------------------------------------ */
/* Moon and planets, geocentric                                        */
/* ------------------------------------------------------------------ */

/** Geocentric Moon, equatorial vector of date, au (Meeus ch. 47 main terms, via shared/orbit.ts). */
export function moonVectorOfDate(ms: number): Vec3 {
  const jd = jdTdb(ms);
  return precessFromJ2000(eclipticToEquatorialJ2000(moonGeocentric(jd)), jd);
}

/** A planet seen from the Earth's centre: vectors in ecliptic J2000, au. */
export interface PlanetGeometry {
  /** Planet minus Earth, light-time corrected (astrometric). */
  geo: Vec3;
  /** Heliocentric planet at the emission time. */
  helio: Vec3;
  /** Heliocentric Earth at the observation time. */
  earth: Vec3;
}

/** Planet geometry with one light-time iteration (≈ 0.1″ residual for the planets). */
export function planetGeometry(id: SkyPlanet, ms: number): PlanetGeometry {
  const jd = jdTdb(ms);
  const earth = earthPosition(jd);
  const first = sub(planetPosition(id, jd), earth);
  const helio = planetPosition(id, jd - norm(first) / C_AU_PER_DAY);
  return { geo: sub(helio, earth), helio, earth };
}

/** Astrometric geocentric RA/Dec (J2000/ICRF, degrees) and distance (au) — comparable to Horizons quantity 1. */
export function planetAstrometric(id: SkyPlanet, ms: number): { ra: number; dec: number; dist: number } {
  return vecToRaDec(eclipticToEquatorialJ2000(planetGeometry(id, ms).geo));
}

/** Geocentric equatorial vector of date (au) of any body. */
export function geocentricVectorOfDate(body: SkyBody, ms: number): Vec3 {
  if (body === "sun") return sunVectorOfDate(ms);
  if (body === "moon") return moonVectorOfDate(ms);
  return precessFromJ2000(eclipticToEquatorialJ2000(planetGeometry(body, ms).geo), jdTdb(ms));
}

/* ------------------------------------------------------------------ */
/* Positions in the observer's sky                                     */
/* ------------------------------------------------------------------ */

export interface SkyPosition {
  /** Topocentric RA/Dec, mean equator and equinox of date, degrees. */
  ra: number;
  dec: number;
  /** Topocentric distance, au. */
  dist: number;
  /** Geometric (airless) altitude of the centre, degrees. */
  alt: number;
  /** Azimuth from north through east, degrees. */
  az: number;
  /** Altitude through the standard atmosphere (for display). */
  apparentAlt: number;
}

/** Topocentric vector of date: geocentric minus the observer (parallax: ~1° for the Moon). */
export function topocentricVector(geo: Vec3, ms: number, obs: Observer): Vec3 {
  return sub(geo, observerVector(obs, localSiderealTime(ms, obs.lon)));
}

/** Where a body is in the observer's sky at `ms`. */
export function skyPosition(body: SkyBody, ms: number, obs: Observer): SkyPosition {
  const { ra, dec, dist } = vecToRaDec(topocentricVector(geocentricVectorOfDate(body, ms), ms, obs));
  const { alt, az } = equatorialToHorizontal(ra, dec, localSiderealTime(ms, obs.lon), obs.lat);
  return { ra, dec, dist, alt, az, apparentAlt: apparentAltitude(alt) };
}

/* ------------------------------------------------------------------ */
/* Moon phase                                                          */
/* ------------------------------------------------------------------ */

export type MoonPhaseName =
  | "New Moon" | "Waxing Crescent" | "First Quarter" | "Waxing Gibbous"
  | "Full Moon" | "Waning Gibbous" | "Last Quarter" | "Waning Crescent";

export interface MoonPhase {
  /** Illuminated fraction of the disk, 0–1. */
  illuminated: number;
  /** Sun–Moon–observer angle, degrees (0 = full). */
  phaseAngle: number;
  /** Moon–Sun angular distance seen from the observer, degrees. */
  elongation: number;
  /** Moon minus Sun in ecliptic longitude, 0–360° (0 new, 90 first quarter, 180 full, 270 last quarter). */
  lonDiff: number;
  waxing: boolean;
  name: MoonPhaseName;
  /** Time since the previous new moon, days. */
  ageDays: number;
}

/** Ecliptic longitude of date of an equatorial vector of date, degrees. */
function eclipticLongitudeOfDate(v: Vec3, jdTT: number): number {
  const e = meanObliquity(jdTT) * DEG;
  return norm360(Math.atan2(v[1] * Math.cos(e) + v[2] * Math.sin(e), v[0]) / DEG);
}

/** Moon minus Sun in geocentric ecliptic longitude, degrees in [0, 360). */
export function moonSunLonDiff(ms: number): number {
  const jd = jdTdb(ms);
  return norm360(eclipticLongitudeOfDate(moonVectorOfDate(ms), jd) - eclipticLongitudeOfDate(sunVectorOfDate(ms), jd));
}

/** Principal phases: the times the Moon−Sun longitude difference is 0, 90, 180 and 270°. */
export type PrincipalPhase = "New Moon" | "First Quarter" | "Full Moon" | "Last Quarter";
const PRINCIPAL: PrincipalPhase[] = ["New Moon", "First Quarter", "Full Moon", "Last Quarter"];

/** Principal phases between `start` and `end` (UTC ms), in time order. */
export function moonPhaseEvents(start: number, end: number, only?: PrincipalPhase): { phase: PrincipalPhase; ms: number }[] {
  const out: { phase: PrincipalPhase; ms: number }[] = [];
  PRINCIPAL.forEach((phase, k) => {
    if (only && phase !== only) return;
    // The difference grows ~12°/day; norm180 keeps the target at 0 with the jump on the far side.
    for (const c of findCrossings((t) => norm180(moonSunLonDiff(t) - 90 * k), start, end, 6 * HOUR)) {
      if (c.rising) out.push({ phase, ms: c.ms });
    }
  });
  return out.sort((a, b) => a.ms - b.ms);
}

/**
 * Phase name for an instant: a principal phase within ±6° of longitude difference (about ±12 h of
 * the exact moment), otherwise crescent or gibbous. (Almanacs name the principal phase for the
 * whole calendar day it falls on; this is the per-instant equivalent.)
 */
export function moonPhaseName(lonDiff: number): MoonPhaseName {
  const d = norm360(lonDiff);
  const near = (x: number) => Math.abs(norm180(d - x)) <= 6;
  if (near(0)) return "New Moon";
  if (near(90)) return "First Quarter";
  if (near(180)) return "Full Moon";
  if (near(270)) return "Last Quarter";
  if (d < 90) return "Waxing Crescent";
  if (d < 180) return "Waxing Gibbous";
  if (d < 270) return "Waning Gibbous";
  return "Waning Crescent";
}

/**
 * The Moon's phase at `ms`. With an observer, illumination and elongation are topocentric (the
 * ~1° parallax changes the illuminated fraction by up to ~1 percentage point).
 */
export function moonPhase(ms: number, obs?: Observer): MoonPhase {
  const geoMoon = moonVectorOfDate(ms), geoSun = sunVectorOfDate(ms);
  const moon = obs ? topocentricVector(geoMoon, ms, obs) : geoMoon;
  const sun = obs ? topocentricVector(geoSun, ms, obs) : geoSun;
  const phaseAngle = vectorAngle(sub(sun, moon), scale(moon, -1));
  const lonDiff = moonSunLonDiff(ms);
  return {
    illuminated: (1 + Math.cos(phaseAngle * DEG)) / 2,
    phaseAngle,
    elongation: vectorAngle(moon, sun),
    lonDiff,
    waxing: lonDiff < 180,
    name: moonPhaseName(lonDiff),
    ageDays: (ms - previousNewMoon(ms, lonDiff)) / DAY,
  };
}

/** Mean synodic month, days. */
const SYNODIC_MONTH = 29.530589;

/**
 * The last new moon at or before `ms`. Seeded from the current Moon−Sun longitude difference at the
 * mean synodic rate, then searched ±1.5 days (the true time differs from the mean-rate estimate by
 * well under a day).
 */
export function previousNewMoon(ms: number, lonDiff = moonSunLonDiff(ms)): number {
  const estimate = ms - (lonDiff / 360) * SYNODIC_MONTH * DAY;
  const found = moonPhaseEvents(estimate - 1.5 * DAY, Math.min(estimate + 1.5 * DAY, ms), "New Moon");
  return found.at(-1)?.ms ?? estimate;
}

/* ------------------------------------------------------------------ */
/* Planet brightness (Mallama & Hilton 2018)                           */
/* ------------------------------------------------------------------ */

/** IAU (WGCCRE) north poles, equatorial J2000, degrees: [α0, δ0]; flattening for planetographic latitude. */
const POLES = {
  saturn: { ra: 40.589, dec: 83.537, f: 0.09796 },
  uranus: { ra: 257.311, dec: -15.175, f: 0.02293 },
};

/** Planetocentric latitude (degrees) of the point under a direction `toward` (J2000 equatorial), for a pole. */
function subLatitude(pole: { ra: number; dec: number }, toward: Vec3): number {
  const p = raDecToVec(pole.ra, pole.dec);
  return Math.asin(Math.max(-1, Math.min(1, dot(p, toward) / norm(toward)))) / DEG;
}

function planetographic(latC: number, f: number): number {
  return Math.atan(Math.tan(latC * DEG) / (1 - f) ** 2) / DEG;
}

export interface PlanetInfo {
  /** Apparent visual magnitude (Mallama & Hilton 2018), or null outside the model's phase-angle range. */
  mag: number | null;
  /** Sun–planet–Earth angle, degrees. */
  phaseAngle: number;
  /** Illuminated fraction of the disk, 0–1. */
  illuminated: number;
  /** Angular distance from the Sun seen from the Earth, degrees. */
  elongation: number;
  /** Heliocentric distance r and geocentric distance Δ, au. */
  r: number;
  delta: number;
  /** Saturn only: the ring opening seen from the Earth (sub-Earth latitude of the ring plane), degrees. */
  ringTilt?: number;
}

/**
 * Apparent visual magnitude from the equations Mallama & Hilton (2018, Astronomy and Computing 25,
 * 10–24) wrote for The Astronomical Almanac (the model JPL Horizons uses).
 * Returns null outside a model's phase-angle range.
 * Simplifications: Mars omits the paper's small rotational/orbital-longitude corrections;
 * Saturn's ring term uses the ring tilt seen from the Earth only (not a Sun/Earth combination);
 * Neptune uses the post-2000 constant. Against Horizons (test/sky.test.ts) these stayed within
 * 0.03 mag for Mars and 0.04 mag for Saturn on the tested dates (2026–2027).
 */
export function planetMagnitude(
  id: SkyPlanet, r: number, delta: number, alpha: number, extra: { ringTilt?: number; uranusLat?: number } = {},
): number | null {
  const base = 5 * Math.log10(r * delta);
  const a = alpha;
  switch (id) {
    case "mercury":
      // The paper fits 2°–170°; Horizons applies the polynomial beyond (it stays monotonic to 180°).
      return base - 0.613 + 6.328e-2 * a - 1.6336e-3 * a ** 2 + 3.3644e-5 * a ** 3 - 3.4265e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6;
    case "venus":
      if (a < 163.7) return base - 4.384 - 1.044e-3 * a + 3.687e-4 * a ** 2 - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4;
      if (a <= 179) return base + 236.05828 - 2.81914 * a + 8.39034e-3 * a ** 2;
      return null;
    case "mars":
      if (a <= 50) return base - 1.601 + 2.267e-2 * a - 1.302e-4 * a ** 2;
      return base - 0.367 - 2.573e-2 * a + 3.445e-4 * a ** 2;
    case "jupiter": {
      if (a <= 12) return base - 9.395 - 3.7e-4 * a + 6.16e-4 * a ** 2;
      const x = a / 180;
      const p = 1 - 1.507 * x - 0.363 * x ** 2 - 0.062 * x ** 3 + 2.809 * x ** 4 - 1.876 * x ** 5;
      return p > 0 ? base - 9.428 - 2.5 * Math.log10(p) : null;
    }
    case "saturn": {
      const beta = Math.abs(extra.ringTilt ?? 0);
      if (a <= 6.5 && beta <= 27) {
        const sb = Math.sin(beta * DEG);
        return base - 8.914 - 1.825 * sb + 0.026 * a - 0.378 * sb * Math.exp(-2.25 * a);
      }
      // Globe only (outside the ring model's range; not reachable from the Earth).
      return a <= 6 ? base - 8.95 - 3.7e-4 * a + 6.16e-4 * a ** 2 : null;
    }
    case "uranus": {
      // The phase terms apply only beyond the largest phase angle seen from the Earth (3.1°).
      const v = base - 7.11 - 8.4e-4 * (extra.uranusLat ?? 0);
      return a > 3.1 ? v + 6.587e-3 * a + 1.045e-4 * a ** 2 : v;
    }
    case "neptune":
      // Likewise beyond 1.9° (never from the Earth).
      return a > 1.9 ? base - 7.0 + 7.944e-3 * a + 9.617e-5 * a ** 2 : base - 7.0;
  }
}

/** Brightness and Sun-relative geometry of a planet seen from the Earth's centre at `ms`. */
export function planetInfo(id: SkyPlanet, ms: number): PlanetInfo {
  const { geo, helio, earth } = planetGeometry(id, ms);
  const r = norm(helio), delta = norm(geo);
  const phaseAngle = vectorAngle(scale(helio, -1), scale(geo, -1));
  const elongation = vectorAngle(scale(earth, -1), geo);
  const extra: { ringTilt?: number; uranusLat?: number } = {};
  let ringTilt: number | undefined;
  if (id === "saturn") {
    ringTilt = subLatitude(POLES.saturn, eclipticToEquatorialJ2000(scale(geo, -1)));
    extra.ringTilt = ringTilt;
  } else if (id === "uranus") {
    const f = POLES.uranus.f;
    const earthLat = planetographic(subLatitude(POLES.uranus, eclipticToEquatorialJ2000(scale(geo, -1))), f);
    const sunLat = planetographic(subLatitude(POLES.uranus, eclipticToEquatorialJ2000(scale(helio, -1))), f);
    extra.uranusLat = (Math.abs(earthLat) + Math.abs(sunLat)) / 2;
  }
  return {
    mag: planetMagnitude(id, r, delta, phaseAngle, extra),
    phaseAngle,
    illuminated: (1 + Math.cos(phaseAngle * DEG)) / 2,
    elongation,
    r,
    delta,
    ...(ringTilt === undefined ? {} : { ringTilt }),
  };
}

/* ------------------------------------------------------------------ */
/* Root finding and events                                             */
/* ------------------------------------------------------------------ */

export interface Crossing {
  ms: number;
  /** True when f goes from negative to non-negative. */
  rising: boolean;
}

/**
 * Zero crossings of `f` on [start, end]: samples every `step` ms, then bisects each sign change to
 * `tol` ms. A dip shorter than `step` can be missed (a body grazing the horizon for a few minutes).
 */
export function findCrossings(f: (ms: number) => number, start: number, end: number, step = 10 * MINUTE, tol = 1000): Crossing[] {
  return refineCrossings(f, sampleFunction(f, start, end, step), 0, tol);
}

/** Samples of a function on a regular grid (the last step may be shorter). */
export interface Samples {
  t: number[];
  v: number[];
}

export function sampleFunction(f: (ms: number) => number, start: number, end: number, step = 10 * MINUTE): Samples {
  const t: number[] = [], v: number[] = [];
  for (let x = start; ; x = Math.min(x + step, end)) {
    t.push(x);
    v.push(f(x));
    if (x >= end) break;
  }
  return { t, v };
}

/**
 * Crossings of `f(t) = level` found from precomputed samples of `f`, so one set of samples serves
 * several levels (sunset and the three twilights). Bisects each sign change to `tol` ms.
 */
export function refineCrossings(f: (ms: number) => number, samples: Samples, level: number, tol = 1000): Crossing[] {
  const out: Crossing[] = [];
  const { t, v } = samples;
  for (let k = 1; k < t.length; k++) {
    const f0 = v[k - 1]! - level, f1 = v[k]! - level;
    if ((f0 < 0) === (f1 < 0)) continue;
    let lo = t[k - 1]!, hi = t[k]!, flo = f0;
    while (hi - lo > tol) {
      const mid = (lo + hi) / 2, fm = f(mid) - level;
      if ((fm < 0) === (flo < 0)) [lo, flo] = [mid, fm];
      else hi = mid;
    }
    // A sign change across a wrap (e.g. an hour angle jumping from +180° to −180°) is not a root.
    if (Math.abs(f1 - f0) > 180 && Math.abs(f((lo + hi) / 2) - level) > 90) continue;
    out.push({ ms: Math.round((lo + hi) / 2), rising: f0 < 0 });
  }
  return out;
}

/** Standard altitude of the centre at rise/set, degrees (Sun −50′; planets −34′; Moon −34′ − semidiameter). */
export const SUN_HORIZON = -0.8333;
export const PLANET_HORIZON = -0.5667;
export const TWILIGHT = { civil: -6, nautical: -12, astronomical: -18 } as const;

/** Altitude above the body's rise/set limit (positive = "up"), degrees. */
export function altitudeAboveHorizon(body: SkyBody, ms: number, obs: Observer): number {
  const p = skyPosition(body, ms, obs);
  if (body === "sun") return p.alt - SUN_HORIZON;
  if (body === "moon") return p.alt - (PLANET_HORIZON - Math.asin(MOON_RADIUS_KM / (p.dist * KM_PER_AU)) / DEG);
  return p.alt - PLANET_HORIZON;
}

export interface RiseTransitSet {
  /** "normal": crosses the horizon in the window; otherwise up or down the whole window. */
  state: "normal" | "always-up" | "never-up";
  /** First rise and first set in the window (either can be null, e.g. a set after the window ends). */
  rise: number | null;
  set: number | null;
  /** Upper transit (due south/north, highest point) in the window, and its geometric altitude. */
  transit: number | null;
  transitAlt: number | null;
}

/** Rise, upper transit and set of a body between `start` and `end` (UTC ms). */
export function riseTransitSet(body: SkyBody, obs: Observer, start: number, end: number): RiseTransitSet {
  const crossings = findCrossings((t) => altitudeAboveHorizon(body, t, obs), start, end);
  const hourAngle = (t: number) => norm180(localSiderealTime(t, obs.lon) - skyPosition(body, t, obs).ra);
  const transit = findCrossings(hourAngle, start, end).find((c) => c.rising)?.ms ?? null;
  const state = crossings.length ? "normal" : altitudeAboveHorizon(body, start, obs) >= 0 ? "always-up" : "never-up";
  return {
    state,
    rise: crossings.find((c) => c.rising)?.ms ?? null,
    set: crossings.find((c) => !c.rising)?.ms ?? null,
    transit,
    transitAlt: transit === null ? null : skyPosition(body, transit, obs).alt,
  };
}

/** One evening/morning event of the night. */
export type NightEvent =
  | { state: "time"; ms: number }
  /** The Sun stays above this limit for the whole window (polar day, or no full darkness in summer). */
  | { state: "always-above" }
  /** The Sun stays below this limit for the whole window (polar night). */
  | { state: "always-below" }
  /** The Sun crosses the limit in this window, but only in the other direction (edge of polar day/night). */
  | { state: "none" };

export interface NightEvents {
  /** The window: the observer's solar noon to the next one, UTC ms. */
  start: number;
  end: number;
  sunset: NightEvent;
  sunrise: NightEvent;
  civilDusk: NightEvent;
  civilDawn: NightEvent;
  nauticalDusk: NightEvent;
  nauticalDawn: NightEvent;
  /** Darkness begins / ends (Sun below −18°). */
  astronomicalDusk: NightEvent;
  astronomicalDawn: NightEvent;
}

function limitEvents(sunAlt: (ms: number) => number, samples: Samples, limit: number): [NightEvent, NightEvent] {
  const c = refineCrossings(sunAlt, samples, limit);
  if (!c.length) {
    const s: NightEvent = samples.v[0]! >= limit ? { state: "always-above" } : { state: "always-below" };
    return [s, s];
  }
  const down = c.find((x) => !x.rising);
  const up = c.findLast((x) => x.rising && (!down || x.ms > down.ms));
  return [down ? { state: "time", ms: down.ms } : { state: "none" }, up ? { state: "time", ms: up.ms } : { state: "none" }];
}

/**
 * Sunset, twilights and sunrise for the observer's night that starts on `date` ("YYYY-MM-DD", the
 * observer's own calendar date; see `nightDate`). The window runs from the Sun's upper transit
 * (solar noon at the observer's longitude) to the next one, so it always starts at the Sun's
 * highest point whatever time zone the results are shown in. The Sun's altitude is sampled once
 * and all four limits are found from those samples.
 */
export function nightEvents(obs: Observer, date: string): NightEvents {
  const [start, end] = nightWindow(date, obs);
  const sunAlt = (t: number) => skyPosition("sun", t, obs).alt;
  const samples = sampleFunction(sunAlt, start, end);
  const [sunset, sunrise] = limitEvents(sunAlt, samples, SUN_HORIZON);
  const [civilDusk, civilDawn] = limitEvents(sunAlt, samples, TWILIGHT.civil);
  const [nauticalDusk, nauticalDawn] = limitEvents(sunAlt, samples, TWILIGHT.nautical);
  const [astronomicalDusk, astronomicalDawn] = limitEvents(sunAlt, samples, TWILIGHT.astronomical);
  return { start, end, sunset, sunrise, civilDusk, civilDawn, nauticalDusk, nauticalDawn, astronomicalDusk, astronomicalDawn };
}

/** Sidereal rate, degrees of hour angle per ms (360.9856°/day). */
const HOUR_ANGLE_RATE = 360.98564736629 / DAY;

/**
 * The Sun's upper transit nearest the mean solar noon of `date` at the observer's longitude, UTC ms
 * (mean noon corrected by the equation of time; two iterations reach well under a second).
 */
export function solarNoon(date: string, obs: Observer): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let t = Date.UTC(y, m - 1, d, 12) - (obs.lon / 360) * DAY;
  for (let k = 0; k < 2; k++) {
    const ha = norm180(localSiderealTime(t, obs.lon) - vecToRaDec(sunVectorOfDate(t)).ra);
    t -= ha / (HOUR_ANGLE_RATE - 360 / 365.2422 / DAY);
  }
  return Math.round(t);
}

/** The observer's night window for `date`: solar noon to the next solar noon, UTC ms. */
export function nightWindow(date: string, obs: Observer): [number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return [solarNoon(date, obs), solarNoon(next, obs)];
}

/**
 * The date whose night window contains `ms` ("tonight", or last night before solar noon): the
 * calendar date of local mean solar time minus 12 h. Independent of the display time zone.
 */
export function nightDate(ms: number, obs: Observer): string {
  const date = new Date(ms + (obs.lon / 360) * DAY - 12 * HOUR).toISOString().slice(0, 10);
  const [start, end] = nightWindow(date, obs);
  // The equation of time (≤ 16 min) can move the true window edge across `ms`.
  if (ms < start) return new Date(Date.parse(date) - DAY).toISOString().slice(0, 10);
  if (ms >= end) return new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
  return date;
}

/* ------------------------------------------------------------------ */
/* Time zones (browser Intl) and places                                */
/* ------------------------------------------------------------------ */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function partsIn(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    dtfCache.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) if (type !== "literal") p[type] = Number(value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! };
}

/** UTC offset of `timeZone` at `ms`, minutes (east positive; Jakarta +420). */
export function timeZoneOffset(ms: number, timeZone: string): number {
  const p = partsIn(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/** Local calendar date ("YYYY-MM-DD") of `ms` in `timeZone`. */
export function localDate(ms: number, timeZone: string): string {
  const p = partsIn(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC ms of a local wall-clock time (not inside a DST gap) in `timeZone`. */
export function zonedTimeToUtc(date: string, hour: number, minute: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let t = wall - timeZoneOffset(wall, timeZone) * MINUTE;
  t = wall - timeZoneOffset(t, timeZone) * MINUTE;
  return t;
}

/** The browser's own IANA time zone (used for manually entered coordinates). */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
  /** IANA zone the panel shows times in for this place. */
  timeZone: string;
}

/** Preset places for the location picker (one high-latitude and two southern ones). */
export const PRESET_PLACES: readonly Place[] = [
  { name: "Jakarta", lat: -6.2, lon: 106.8, timeZone: "Asia/Jakarta" },
  { name: "London", lat: 51.51, lon: -0.13, timeZone: "Europe/London" },
  { name: "New York", lat: 40.71, lon: -74.01, timeZone: "America/New_York" },
  { name: "Tromsø", lat: 69.65, lon: 18.96, timeZone: "Europe/Oslo" },
  { name: "Cape Town", lat: -33.92, lon: 18.42, timeZone: "Africa/Johannesburg" },
  { name: "Sydney", lat: -33.87, lon: 151.21, timeZone: "Australia/Sydney" },
];

/** Round a coordinate to 0.01° (~1 km) before it is stored. */
export function roundCoordinate(x: number): number {
  return Math.round(x * 100) / 100;
}

/** A usable observer, or null: latitude in [−90, 90], longitude wrapped to (−180, 180]. */
export function toObserver(lat: number, lon: number): Observer | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
  return { lat: roundCoordinate(lat), lon: roundCoordinate(norm180(lon)) };
}
