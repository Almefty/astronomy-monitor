/**
 * Orbit propagation for the 3D Solar System (v3). Pure and dependency-free so it runs in the
 * browser every frame (no requests while the time slider moves) and in unit tests.
 *
 * Frame: heliocentric, mean ecliptic and equinox of J2000, astronomical units. Time: Julian Date
 * in TDB (≈ TT; converted from UTC by adding TT−UTC = 69.184 s).
 *
 * Accuracy (checked against JPL Horizons in test/orbit.test.ts):
 * - Planets: JPL's "Approximate Positions of the Planets", Table 1 (Standish), fitted to DE430
 *   for 1800–2050. JPL's stated errors: ~15–40″ in longitude for Mercury–Mars, up to 600″ and
 *   1.5 million km for Saturn — invisible at Solar System scale, but not mission-grade.
 * - Moon: the main terms of Meeus' lunar theory (Astronomical Algorithms ch. 47), ~0.05°.
 * - Asteroids: two-body Kepler orbits from JPL SBDB osculating elements. Ignores planetary
 *   pulls, including Earth's own during a close flyby, so the miss distance computed here can
 *   differ from CNEOS' official value; the panel shows both.
 */

import { DEG } from "./astro";

/** Gaussian gravitational constant, rad/day (k² = GM☉ in au³/day²). */
export const GAUSS_K = 0.01720209895;
export const KM_PER_AU = 149_597_870.7;
/** Moon/Earth mass ratio (DE440). */
const MOON_EARTH_MASS = 0.0123000371;
/** TT − UTC since 2017 (32.184 s + 37 leap seconds). No new leap second announced as of Oct 2026. */
const TT_MINUS_UTC_S = 69.184;
export const J2000 = 2451545.0;

export type Vec3 = [number, number, number];

/** Julian Date (TDB ≈ TT) of a UTC time in ms. */
export function jdTdb(ms: number): number {
  return (ms + TT_MINUS_UTC_S * 1000) / 86_400_000 + 2440587.5;
}

/** UTC ms of a Julian Date (TDB). */
export function msFromJdTdb(jd: number): number {
  return (jd - 2440587.5) * 86_400_000 - TT_MINUS_UTC_S * 1000;
}

/** Osculating heliocentric elements (ecliptic J2000). Angles in degrees. */
export interface Elements {
  /** Eccentricity. */
  e: number;
  /** Perihelion distance, au (well defined for every conic, unlike a). */
  q: number;
  i: number;
  /** Longitude of the ascending node Ω. */
  om: number;
  /** Argument of perihelion ω. */
  w: number;
  /** Time of perihelion passage, JD TDB. */
  tp: number;
}

/** Solve Kepler's equation M = E − e sin E (elliptic), radians. */
export function solveKepler(M: number, e: number): number {
  // Reduce to [−π, π] so the starting guess is good for any number of revolutions.
  const m = M - 2 * Math.PI * Math.round(M / (2 * Math.PI));
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - m;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** Solve the hyperbolic Kepler equation M = e sinh H − H, radians. */
export function solveKeplerHyperbolic(M: number, e: number): number {
  let H = Math.asinh(M / e);
  for (let k = 0; k < 60; k++) {
    const f = e * Math.sinh(H) - H - M;
    const d = f / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return H;
}

/** Position in the orbital plane: [x towards perihelion, y], au. */
function planePosition(el: Elements, jd: number): [number, number] {
  const { e, q } = el;
  const dt = jd - el.tp;
  if (Math.abs(e - 1) < 1e-6) {
    // Parabola (Barker's equation).
    const W = (3 * GAUSS_K * dt) / Math.sqrt(2 * q ** 3);
    const Y = Math.cbrt(W + Math.sqrt(W * W + 1));
    const s = Y - 1 / Y; // tan(ν/2)
    return [q * (1 - s * s), 2 * q * s];
  }
  const a = q / (1 - e);
  const n = GAUSS_K / Math.sqrt(Math.abs(a) ** 3);
  if (e < 1) {
    const E = solveKepler(n * dt, e);
    return [a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E)];
  }
  const H = solveKeplerHyperbolic(n * dt, e);
  return [a * (Math.cosh(H) - e), -a * Math.sqrt(e * e - 1) * Math.sinh(H)];
}

/** Rotate orbital-plane coordinates into the ecliptic frame. */
function toEcliptic(x: number, y: number, el: Pick<Elements, "i" | "om" | "w">): Vec3 {
  const O = el.om * DEG, w = el.w * DEG, I = el.i * DEG;
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * x + (-sw * cO - cw * sO * cI) * y,
    (cw * sO + sw * cO * cI) * x + (-sw * sO + cw * cO * cI) * y,
    sw * sI * x + cw * sI * y,
  ];
}

/** Heliocentric ecliptic J2000 position (au) of a body on a two-body orbit. */
export function keplerPosition(el: Elements, jd: number): Vec3 {
  const [x, y] = planePosition(el, jd);
  return toEcliptic(x, y, el);
}

/** Orbital period in days (Infinity for open orbits). */
export function periodDays(el: Pick<Elements, "e" | "q">): number {
  if (el.e >= 1) return Infinity;
  const a = el.q / (1 - el.e);
  return (2 * Math.PI) / (GAUSS_K / Math.sqrt(a ** 3));
}

/**
 * `n` points along the orbit as drawn in a static picture: a full ellipse for closed orbits,
 * or ±`spanDays` around perihelion for open ones. Points are spaced evenly in eccentric anomaly,
 * which puts more of them near perihelion where the curve bends most.
 */
export function orbitPath(el: Pick<Elements, "e" | "q" | "i" | "om" | "w">, n = 256, spanDays = 400): Vec3[] {
  const out: Vec3[] = [];
  const { e, q } = el;
  if (e < 1) {
    const a = q / (1 - e);
    const b = a * Math.sqrt(1 - e * e);
    for (let k = 0; k <= n; k++) {
      const E = (k / n) * 2 * Math.PI;
      out.push(toEcliptic(a * (Math.cos(E) - e), b * Math.sin(E), el));
    }
    return out;
  }
  for (let k = 0; k <= n; k++) {
    const t = -spanDays + (2 * spanDays * k) / n;
    out.push(keplerPosition({ ...el, tp: 0 } as Elements, t));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Planets: JPL "Approximate Positions of the Planets", Table 1        */
/* https://ssd.jpl.nasa.gov/planets/approx_pos.html (verified 15 Oct 2026) */
/* ------------------------------------------------------------------ */

export type PlanetId = "mercury" | "venus" | "emb" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";

/** a (au), e, I, L, ϖ (long. peri.), Ω (deg) and their rates per Julian century. */
export const PLANET_ELEMENTS: Record<PlanetId, [number[], number[]]> = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus: [[0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255], [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418]],
  emb: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  mars: [[1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};

/** JPL's nominal errors for Table 1 (1800–2050): longitude ″, latitude ″, distance (1000 km). */
export const PLANET_ERRORS: Record<PlanetId, [number, number, number]> = {
  mercury: [15, 1, 1],
  venus: [20, 1, 4],
  emb: [20, 8, 6],
  mars: [40, 2, 25],
  jupiter: [400, 10, 600],
  saturn: [600, 25, 1500],
  uranus: [50, 2, 1000],
  neptune: [10, 1, 200],
};

/** Table 1 is fitted for 1800–2050; outside that the panel refuses to extrapolate. */
export const PLANET_VALID_FROM = Date.UTC(1800, 0, 1);
export const PLANET_VALID_TO = Date.UTC(2050, 0, 1);

/** Planet orbit as Elements-like values at a given JD (the elements drift slowly). */
export function planetElements(id: PlanetId, jd: number): Elements & { a: number; M: number } {
  const [el0, rate] = PLANET_ELEMENTS[id];
  const T = (jd - J2000) / 36525;
  const v = el0.map((x, k) => x + rate[k]! * T);
  const [a, e, i, L, peri, om] = v as [number, number, number, number, number, number];
  const w = peri - om;
  const M = L - peri;
  const n = GAUSS_K / Math.sqrt(a ** 3) / DEG; // deg/day
  return { a, e, q: a * (1 - e), i, om, w, M, tp: jd - M / n };
}

/** Heliocentric ecliptic J2000 position of a planet (or the Earth–Moon barycentre), au. */
export function planetPosition(id: PlanetId, jd: number): Vec3 {
  const el = planetElements(id, jd);
  const E = solveKepler(el.M * DEG, el.e);
  return toEcliptic(el.a * (Math.cos(E) - el.e), el.a * Math.sqrt(1 - el.e ** 2) * Math.sin(E), el);
}

/* ------------------------------------------------------------------ */
/* Moon: main terms of Meeus, Astronomical Algorithms (2nd ed.) ch. 47 */
/* ------------------------------------------------------------------ */

// [D, M, M', F, Σl (1e-6 °), Σr (1e-3 km)] — the largest terms of Table 47.A.
const MOON_LR: [number, number, number, number, number, number][] = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
];
// [D, M, M', F, Σb (1e-6 °)] — the largest terms of Table 47.B.
const MOON_B: [number, number, number, number, number][] = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
];

/** Geocentric position of the Moon, ecliptic J2000, au. */
export function moonGeocentric(jd: number): Vec3 {
  const T = (jd - J2000) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T ** 3 / 538841;
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T ** 3 / 545868;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T ** 3 / 69699;
  const F = 93.272095 + 483202.0175233 * T - 0.0036539 * T * T - T ** 3 / 3526000;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const A1 = 119.75 + 131.849 * T, A2 = 53.09 + 479264.29 * T, A3 = 313.45 + 481266.484 * T;
  const sin = (x: number) => Math.sin(x * DEG), cos = (x: number) => Math.cos(x * DEG);
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const ef = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sl += l * ef * sin(arg);
    sr += r * ef * cos(arg);
  }
  for (const [d, m, mp, f, b] of MOON_B) {
    const ef = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sb += b * ef * sin(d * D + m * M + mp * Mp + f * F);
  }
  sl += 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2);
  sb += -2235 * sin(Lp) + 382 * sin(A3) + 175 * sin(A1 - F) + 175 * sin(A1 + F) + 127 * sin(Lp - Mp) - 115 * sin(Lp + Mp);
  // Mean equinox of date → J2000: remove the general precession in longitude (1.3970°/century).
  const lon = (Lp + sl / 1e6 - 1.396971 * T) * DEG;
  const lat = (sb / 1e6) * DEG;
  const dist = (385000.56 + sr / 1000) / KM_PER_AU;
  return [dist * Math.cos(lat) * Math.cos(lon), dist * Math.cos(lat) * Math.sin(lon), dist * Math.sin(lat)];
}

/** Earth's heliocentric position: the barycentre (Table 1) minus the Moon's share. */
export function earthPosition(jd: number): Vec3 {
  const b = planetPosition("emb", jd);
  const m = moonGeocentric(jd);
  const f = MOON_EARTH_MASS / (1 + MOON_EARTH_MASS);
  return [b[0] - m[0] * f, b[1] - m[1] * f, b[2] - m[2] * f];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * Closest geocentric distance of a two-body orbit within ±`windowDays` of `aroundJd`:
 * a coarse scan, then golden-section refinement. Returns the time (JD TDB) and distance (au).
 */
export function closestApproach(el: Elements, aroundJd: number, windowDays = 5): { jd: number; dist: number } {
  const dist = (jd: number) => norm(sub(keplerPosition(el, jd), earthPosition(jd)));
  const steps = Math.max(40, Math.round(windowDays * 2 * 24));
  let best = aroundJd, bestD = Infinity;
  for (let k = 0; k <= steps; k++) {
    const jd = aroundJd - windowDays + (2 * windowDays * k) / steps;
    const d = dist(jd);
    if (d < bestD) [best, bestD] = [jd, d];
  }
  const h0 = (2 * windowDays) / steps;
  let lo = best - h0, hi = best + h0;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
  let f1 = dist(x1), f2 = dist(x2);
  for (let k = 0; k < 60 && hi - lo > 1e-7; k++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = dist(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = dist(x2);
    }
  }
  const jd = (lo + hi) / 2;
  return { jd, dist: dist(jd) };
}
