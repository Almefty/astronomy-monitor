/**
 * All-sky map helpers (equatorial coordinates, Hammer–Aitoff equal-area projection).
 * Shared by the exoplanet panel now and intended for the v2 GCN and JWST/HST sky maps.
 * Astronomical convention: RA increases to the LEFT, centre at RA 0h (or `centerRa`).
 */
import { s } from "../core/dom";

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
  /** Pixel → RA/Dec (degrees), or null outside the map. */
  invert(px: number, py: number): [number, number] | null;
  /** SVG path through sky points, broken where it wraps around the map edge. */
  polyline(points: [number, number][], close?: boolean): { d: string; wraps: boolean };
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

  const invert = (px: number, py: number): [number, number] | null => {
    // Inverse Hammer projection (x in ±2√2, y in ±√2).
    const x = (px - cx) / sx, y = -(py - cy) / sy;
    if ((x * x) / 8 + (y * y) / 2 > 1) return null;
    const z = Math.sqrt(1 - (x / 4) ** 2 - (y / 2) ** 2);
    const lon = 2 * Math.atan2(z * x, 2 * (2 * z * z - 1));
    const lat = Math.asin(Math.max(-1, Math.min(1, z * y)));
    const ra = ((centerRa - lon / D2R) % 360 + 360) % 360;
    return [ra, lat / D2R];
  };

  const polyline = (points: [number, number][], close = false) => {
    let d = "";
    let prev: [number, number] | null = null;
    let wraps = false;
    for (const [ra, dec] of points) {
      const p = project(ra, dec);
      const jump = !!prev && Math.abs(p[0] - prev[0]) > w / 3;
      wraps ||= jump;
      d += `${!prev || jump ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      prev = p;
    }
    return { d: close && !wraps ? `${d}Z` : d, wraps };
  };

  const line = (pts: [number, number][]) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");

  return {
    width,
    height,
    project,
    invert,
    polyline,
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

/**
 * Shared base layer for the v2 sky maps: outline, RA/Dec grid with hour labels, Milky Way
 * plane. Returns the SVG group so callers can add their own marks on top.
 */
export function skyBase(f: SkyFrame, opts: { labels?: boolean } = {}): SVGGElement {
  const g = s("g");
  g.append(s("path", { d: f.outline(), fill: "var(--panel-2)", stroke: "var(--axis)", "stroke-width": 1 }));
  for (const d of f.graticule()) g.append(s("path", { d, fill: "none", stroke: "var(--grid)", "stroke-width": 1 }));
  g.append(s("path", { d: f.galacticPlane(), fill: "none", stroke: "var(--ink-3)", "stroke-width": 1.1, opacity: 0.6, "stroke-dasharray": "1 3", "stroke-linecap": "round" }));
  if (opts.labels !== false && f.width >= 360) {
    for (const h of [18, 6]) {
      const [x, y] = f.project(h * 15, 0);
      g.append(s("text", { class: "axis-label halo", x, y: y + 13, "text-anchor": "middle" }, `${h}h`));
    }
    // 12h is the map's left and right edge (the map wraps there).
    for (const ra of [179.9, 180.1]) {
      const [x, y] = f.project(ra, 0);
      g.append(s("text", { class: "axis-label halo", x: ra < 180 ? x + 4 : x - 4, y: y + 13, "text-anchor": ra < 180 ? "start" : "end" }, "12h"));
    }
    for (const dec of [60, 30, -30, -60]) {
      const [x, y] = f.project(0, dec);
      g.append(s("text", { class: "axis-label halo", x: x + 4, y: y - 3 }, `${dec > 0 ? "+" : "−"}${Math.abs(dec)}°`));
    }
  }
  return g;
}

/** The Sun's position as a small glyph with label. */
export function sunGlyph(f: SkyFrame, ra: number, dec: number): SVGGElement {
  const [x, y] = f.project(ra, dec);
  const g = s("g", { "aria-hidden": "true" });
  g.append(s("circle", { cx: x, cy: y, r: 6, fill: "var(--sun)", stroke: "var(--panel)", "stroke-width": 2 }));
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    g.append(s("line", { x1: x + Math.cos(a) * 8.5, y1: y + Math.sin(a) * 8.5, x2: x + Math.cos(a) * 11, y2: y + Math.sin(a) * 11, stroke: "var(--sun)", "stroke-width": 1.5, "stroke-linecap": "round" }));
  }
  const right = x < f.width - 50;
  g.append(s("text", { class: "mark-label", x: right ? x + 14 : x - 14, y: y + 4, "text-anchor": right ? "start" : "end" }, "Sun"));
  return g;
}

/**
 * Shade the part of the sky where `inside(ra, dec)` holds, on a canvas behind the SVG
 * (cell-sampled through the inverse projection, so it wraps correctly at the map edge).
 */
export function shadeZone(canvas: HTMLCanvasElement, f: SkyFrame, inside: (ra: number, dec: number) => boolean, color: string, cell = 3) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(f.width * dpr);
  canvas.height = Math.round(f.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, f.width, f.height);
  ctx.fillStyle = color;
  for (let y = 0; y < f.height; y += cell) {
    for (let x = 0; x < f.width; x += cell) {
      const p = f.invert(x + cell / 2, y + cell / 2);
      if (p && inside(p[0], p[1])) ctx.fillRect(x, y, cell, cell);
    }
  }
}
