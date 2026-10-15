/**
 * Small, dependency-free astronomy helpers shared by the Worker and the browser.
 *
 * Used in v2 for the Sun's position on the sky maps and for sanity-checking telescope
 * target positions (a telescope cannot point closer to the Sun than its avoidance angle).
 * The 3D Solar System's orbit propagation (shared/orbit.ts) builds on these, so keep them
 * pure and unit-tested.
 */

export const DEG = Math.PI / 180;

/** Julian Date (UT) of a JS time. */
export function julianDate(t: Date | number): number {
  const ms = typeof t === "number" ? t : t.getTime();
  return ms / 86_400_000 + 2440587.5;
}

/** Days since J2000.0 (2000-01-01 12:00 TT, ignoring the ~70 s TT−UT offset). */
export function daysSinceJ2000(t: Date | number): number {
  return julianDate(t) - 2451545.0;
}

/** Mean obliquity of the ecliptic, degrees. */
export function obliquity(t: Date | number): number {
  return 23.439291 - 0.0000004 * daysSinceJ2000(t);
}

/** Ecliptic (λ, β) → equatorial (α, δ), all in degrees. */
export function eclipticToEquatorial(lon: number, lat: number, t: Date | number): [number, number] {
  const e = obliquity(t) * DEG;
  const l = lon * DEG, b = lat * DEG;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  return [norm360(ra / DEG), dec / DEG];
}

/**
 * Apparent position of the Sun (Astronomical Almanac low-precision formula,
 * good to ~0.01° for 1950–2050). Returns [RA, Dec] in degrees.
 */
export function sunPosition(t: Date | number): [number, number] {
  const n = daysSinceJ2000(t);
  const L = norm360(280.46 + 0.9856474 * n);
  const g = norm360(357.528 + 0.9856003 * n) * DEG;
  const lambda = L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  return eclipticToEquatorial(lambda, 0, t);
}

/** Great-circle separation of two sky positions, degrees. */
export function angularSeparation(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d1 = dec1 * DEG, d2 = dec2 * DEG;
  const dra = (ra2 - ra1) * DEG;
  // Haversine form: stable for tiny separations (arcsecond error circles).
  const a = Math.sin((d2 - d1) / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin(dra / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / DEG;
}

/** Points on the small circle of `radius` degrees around (ra, dec) — for error circles and Sun-angle zones. */
export function smallCircle(ra: number, dec: number, radius: number, steps = 72): [number, number][] {
  const out: [number, number][] = [];
  const d0 = dec * DEG, r = radius * DEG;
  for (let i = 0; i <= steps; i++) {
    const az = (i / steps) * 2 * Math.PI;
    const dec2 = Math.asin(Math.sin(d0) * Math.cos(r) + Math.cos(d0) * Math.sin(r) * Math.cos(az));
    const dra = Math.atan2(Math.sin(az) * Math.sin(r) * Math.cos(d0), Math.cos(r) - Math.sin(d0) * Math.sin(dec2));
    out.push([norm360(ra + dra / DEG), dec2 / DEG]);
  }
  return out;
}

export function norm360(x: number): number {
  return ((x % 360) + 360) % 360;
}

/** "21h 50m 12s" / "−46° 52′" style labels. */
export function formatRa(ra: number): string {
  const h = norm360(ra) / 15;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const ss = Math.round(((h - hh) * 60 - mm) * 60);
  const [m2, s2] = ss === 60 ? [mm + 1, 0] : [mm, ss];
  const [h3, m3] = m2 === 60 ? [(hh + 1) % 24, 0] : [hh, m2];
  return `${h3}h ${String(m3).padStart(2, "0")}m ${String(s2).padStart(2, "0")}s`;
}

export function formatDec(dec: number): string {
  const sign = dec < 0 ? "−" : "+";
  const a = Math.abs(dec);
  let dd = Math.floor(a);
  let mm = Math.round((a - dd) * 60);
  if (mm === 60) {
    dd += 1;
    mm = 0;
  }
  return `${sign}${dd}° ${String(mm).padStart(2, "0")}′`;
}
