/**
 * All-sky map helpers (equatorial coordinates, Hammer–Aitoff equal-area projection).
 * Shared by the exoplanet panel now and intended for the v2 GCN and JWST/HST sky maps.
 * Astronomical convention: RA increases to the LEFT, centre at RA 0h (or `centerRa`).
 */
const D2R = Math.PI / 180;
const SQRT2 = Math.SQRT2;

export interface SkyFrame {
  width: number;
  height: number;
  /** Project RA/Dec (degrees) to pixel coordinates. */
  project(ra: number, dec: number): [number, number];
  /** SVG path for the outline ellipse. */
  outline(): string;
  /** SVG paths for RA/Dec grid lines. */
  graticule(): string[];
  /** SVG path for the galactic plane (b = 0). */
  galacticPlane(): string;
}

function hammer(lonRad: number, latRad: number): [number, number] {
  const cl = Math.cos(latRad);
  const d = Math.sqrt(1 + cl * Math.cos(lonRad / 2));
  return [(2 * SQRT2 * cl * Math.sin(lonRad / 2)) / d, (SQRT2 * Math.sin(latRad)) / d];
}

/** Galactic (l, b) → equatorial J2000 (ra, dec), degrees. */
export function galacticToEquatorial(l: number, b: number): [number, number] {
  const raGP = 192.85948 * D2R, decGP = 27.12825 * D2R, lNCP = 122.93192 * D2R;
  const lr = l * D2R, br = b * D2R;
  const sinDec = Math.sin(decGP) * Math.sin(br) + Math.cos(decGP) * Math.cos(br) * Math.cos(lNCP - lr);
  const dec = Math.asin(sinDec);
  const y = Math.cos(br) * Math.sin(lNCP - lr);
  const x = Math.cos(decGP) * Math.sin(br) - Math.sin(decGP) * Math.cos(br) * Math.cos(lNCP - lr);
  let ra = (raGP + Math.atan2(y, x)) / D2R;
  ra = ((ra % 360) + 360) % 360;
  return [ra, dec / D2R];
}

export function skyFrame(width: number, pad = 6, centerRa = 0): SkyFrame {
  const w = width - pad * 2;
  const height = Math.round(w / 2) + pad * 2;
  const sx = w / (4 * SQRT2);
  const sy = (height - pad * 2) / (2 * SQRT2);
  const cx = width / 2, cy = height / 2;

  const project = (ra: number, dec: number): [number, number] => {
    let lon = ra - centerRa;
    lon = ((lon + 180) % 360 + 360) % 360 - 180; // wrap to -180..180
    const [x, y] = hammer(-lon * D2R, dec * D2R); // minus: RA grows to the left
    return [cx + x * sx, cy - y * sy];
  };

  const line = (pts: [number, number][]) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");

  return {
    width,
    height,
    project,
    outline: () => {
      const pts: [number, number][] = [];
      for (let d = -90; d <= 90; d += 3) pts.push(project(centerRa + 179.999, d));
      for (let d = 90; d >= -90; d -= 3) pts.push(project(centerRa - 179.999, d));
      return line(pts) + "Z";
    },
    graticule: () => {
      const out: string[] = [];
      for (let dec = -60; dec <= 60; dec += 30) {
        const pts: [number, number][] = [];
        for (let r = -179.999; r <= 179.999; r += 4) pts.push(project(centerRa + r, dec));
        out.push(line(pts));
      }
      for (let ra = -150; ra <= 150; ra += 30) {
        const pts: [number, number][] = [];
        for (let d = -90; d <= 90; d += 3) pts.push(project(centerRa + ra, d));
        out.push(line(pts));
      }
      return out;
    },
    galacticPlane: () => {
      // Split the path where it wraps around the map edge.
      let d = "";
      let prev: [number, number] | null = null;
      for (let l = 0; l <= 360; l += 2) {
        const [ra, dec] = galacticToEquatorial(l, 0);
        const p = project(ra, dec);
        d += `${!prev || Math.abs(p[0] - prev[0]) > w / 3 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        prev = p;
      }
      return d;
    },
  };
}
