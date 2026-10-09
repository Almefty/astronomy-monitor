import { scaleBand, scaleLinear, scaleLog } from "d3-scale";
import type { ExoplanetData, NewPlanet, Notice, UpstreamCall } from "../../shared/contract";
import { ApiError, fetchSource, fetchText } from "../core/api";
import { h, onResize, s, safeUrl } from "../core/dom";
import { fmt, lightYears, utcDate } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelResult } from "../core/panel";
import { cssVar } from "../core/theme";
import { hoverLayer, placeLabels, svgRoot, yAxis, type HoverPoint, type LabelCandidate } from "../viz/chart";
import { skyFrame } from "../viz/sky";
import { hideTip, showTip } from "../viz/tooltip";

/* Discovery methods → three validated categorical slots + neutral "other". */
const METHODS = ["Transit", "Radial Velocity", "Microlensing", "Other"] as const;
const METHOD_VAR = ["--series-1", "--series-2", "--series-3", "--other"];
const methodIndex = (m: string) => {
  const i = METHODS.indexOf(m as (typeof METHODS)[number]);
  return i >= 0 && i < 3 ? i : 3;
};
const methodColor = (m: string) => `var(${METHOD_VAR[methodIndex(m)]})`;

/** [name, host, year, methodIdx, periodDays, radiusEarth, massEarth, distPc, ra, dec] */
type Row = [string, string, number | null, number, number | null, number | null, number | null, number | null, number | null, number | null];

interface ExoView {
  info: ExoplanetData;
  catalog: Row[] | null;
  methodNames: string[];
}

const SOLAR_SYSTEM: [string, number, number][] = [
  ["Mercury", 88, 0.383], ["Venus", 224.7, 0.949], ["Earth", 365.25, 1], ["Mars", 687, 0.532],
  ["Jupiter", 4333, 11.21], ["Saturn", 10759, 9.45], ["Uranus", 30687, 4.01], ["Neptune", 60190, 3.88],
];
const LABELLED_PLANETS = new Set(["Earth", "Jupiter", "Neptune", "Mercury"]);

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toRows(csv: string): { rows: Row[]; methodNames: string[] } {
  const [header, ...lines] = parseCsv(csv);
  if (!header) return { rows: [], methodNames: [] };
  const col = (n: string) => header.indexOf(n);
  const ix = {
    name: col("pl_name"), host: col("hostname"), year: col("disc_year"), method: col("discoverymethod"), per: col("pl_orbper"),
    rad: col("pl_rade"), mass: col("pl_bmasse"), dist: col("sy_dist"), ra: col("ra"), dec: col("dec"),
  };
  const n = (v: string | undefined) => {
    if (v === undefined || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const methods = new Set<string>();
  const rows = lines.map((l): Row => {
    methods.add(l[ix.method] ?? "");
    return [l[ix.name] ?? "", l[ix.host] ?? "", n(l[ix.year]), methodIndex(l[ix.method] ?? ""), n(l[ix.per]), n(l[ix.rad]), n(l[ix.mass]), n(l[ix.dist]), n(l[ix.ra]), n(l[ix.dec])];
  });
  return { rows, methodNames: [...methods] };
}

const archiveUrl = (name: string) => `https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(name)}`;

function planetTip(p: { name: string; host: string; method: string; period: number | null; radius: number | null; mass?: number | null; dist: number | null; year?: number | null; added?: string }) {
  const rows: [string, string][] = [
    ["Method", p.method],
    ["Radius", p.radius !== null ? `${fmt.sig(p.radius, 3)} R⊕` : "—"],
    ["Orbit", p.period !== null ? `${fmt.sig(p.period, 3)} days` : "—"],
  ];
  if (p.mass !== undefined) rows.push(["Mass", p.mass !== null ? `${fmt.sig(p.mass, 3)} M⊕` : "—"]);
  rows.push(["Distance", lightYears(p.dist)]);
  if (p.added) rows.push(["Added", utcDate(p.added, true)]);
  else if (p.year) rows.push(["Discovered", String(p.year)]);
  return { title: p.name, rows, note: `Host star: ${p.host}` };
}

/* ---------------------------------------------------------------- Discovery space */

function drawDiscoverySpace(el: HTMLElement, view: ExoView, width: number) {
  const height = Math.round(Math.min(440, Math.max(300, width * 0.62)));
  const m = { top: 12, right: 14, bottom: 34, left: 46 };
  const x = scaleLog().domain([0.1, 1e5]).range([m.left, width - m.right]).clamp(true);
  const y = scaleLog().domain([0.3, 30]).range([height - m.bottom, m.top]).clamp(true);
  const recentNames = new Set(view.info.recent.map((p) => p.name));

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = h("canvas", { width: Math.round(width * dpr), height: Math.round(height * dpr), "aria-hidden": "true" });
  canvas.style.height = `${height}px`;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  const ctx = canvas.getContext("2d")!;
  const plotted = (view.catalog ?? []).filter((r) => r[4] !== null && r[5] !== null && r[4]! > 0 && r[5]! > 0);

  const paint = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const colors = METHOD_VAR.map((v) => cssVar(v));
    ctx.globalAlpha = 0.5;
    for (const r of plotted) {
      if (recentNames.has(r[0])) continue;
      ctx.fillStyle = colors[r[3]]!;
      ctx.beginPath();
      ctx.arc(x(r[4]!), y(r[5]!), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  paint();

  const svg = svgRoot(width, height, "Exoplanet discovery space: orbital period versus planet radius");
  svg.style.position = "relative";
  const g = s("g");
  svg.append(g);
  yAxis(g, y, [0.5, 1, 2, 4, 10, 20], (v) => `${v}`, m.left, width - m.right);
  const xt = [0.1, 1, 10, 100, 1000, 1e4, 1e5];
  const ax = s("g", { class: "axis" });
  for (const t of xt) {
    const px = Math.round(x(t)) + 0.5;
    g.append(s("line", { class: "gridline", x1: px, x2: px, y1: m.top, y2: height - m.bottom }));
    ax.append(s("text", { x: px, y: height - m.bottom + 15, "text-anchor": "middle" }, t >= 1000 ? fmt.compact(t) : String(t)));
  }
  g.append(ax);
  g.append(s("text", { class: "axis-label", x: width - m.right, y: height - 4, "text-anchor": "end" }, "orbital period (days, log) →"));
  g.append(s("text", { class: "axis-label", x: 4, y: m.top - 2 }, "radius (R⊕)"));

  const points: HoverPoint[] = [];
  // Solar System for reference.
  for (const [name, per, rad] of SOLAR_SYSTEM) {
    const px = x(per), py = y(rad);
    const c = s("circle", { cx: px, cy: py, r: 4.5, fill: "var(--panel)", stroke: "var(--ink)", "stroke-width": 1.5 });
    g.append(c);
    if (LABELLED_PLANETS.has(name)) g.append(s("text", { class: "mark-label", x: px + 8, y: py + 4 }, name));
    points.push({ x: px, y: py, mark: c, tip: { title: `${name} (Solar System)`, rows: [["Radius", `${rad} R⊕`], ["Orbit", `${fmt.int(per)} days`]] } });
  }
  // Recently added planets, emphasised.
  const recent = view.info.recent.filter((p) => p.periodDays && p.radiusEarth);
  const labels: LabelCandidate[] = [];
  recent.forEach((p, i) => {
    const px = x(p.periodDays!), py = y(p.radiusEarth!);
    const c = s("circle", { cx: px, cy: py, r: 5.5, fill: methodColor(p.method), stroke: "var(--ink)", "stroke-width": 1.5 });
    g.append(c);
    if (i < 6) labels.push({ x: px + 9, y: py - 6, text: p.name });
    points.push({ x: px, y: py, mark: c, href: archiveUrl(p.name), tip: planetTip({ name: p.name, host: p.host, method: p.method, period: p.periodDays, radius: p.radiusEarth, mass: p.massEarth, dist: p.distPc, added: p.added }) });
  });
  placeLabels(g, labels);
  // Hover for catalog points uses the same nearest-point layer (data only, no DOM per point).
  for (const r of plotted) {
    if (recentNames.has(r[0])) continue;
    points.push({ x: x(r[4]!), y: y(r[5]!), href: archiveUrl(r[0]), tip: planetTip({ name: r[0], host: r[1], method: METHODS[r[3]]!, period: r[4], radius: r[5], dist: r[7], year: r[2] }) });
  }
  hoverLayerFast(svg, points, { x: m.left, y: m.top, w: width - m.left - m.right, h: height - m.top - m.bottom });

  const holder = h("div", { style: `position:relative;height:${height}px` }, canvas, svg);
  el.replaceChildren(holder);
  const onTheme = () => paint();
  window.addEventListener("themechange", onTheme);
  return () => window.removeEventListener("themechange", onTheme);
}

/** Like hoverLayer, but without per-point keyboard targets (thousands of points; the table covers keyboard use). */
function hoverLayerFast(svg: SVGSVGElement, points: HoverPoint[], area: { x: number; y: number; w: number; h: number }) {
  const rect = s("rect", { class: "hit", x: area.x, y: area.y, width: area.w, height: area.h });
  svg.append(rect);
  let hot: HoverPoint | null = null;
  const ring = s("circle", { r: 6, fill: "none", stroke: "var(--ink)", "stroke-width": 2, style: "pointer-events:none", visibility: "hidden" });
  svg.append(ring);
  const nearest = (ev: PointerEvent) => {
    const b = svg.getBoundingClientRect();
    const lx = ((ev.clientX - b.left) / b.width) * svg.viewBox.baseVal.width;
    const ly = ((ev.clientY - b.top) / b.height) * svg.viewBox.baseVal.height;
    let best: HoverPoint | null = null, bd = 18 * 18;
    for (const p of points) {
      const d = (p.x - lx) ** 2 + (p.y - ly) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  rect.addEventListener("pointermove", (ev) => {
    hot = nearest(ev);
    if (hot) {
      ring.setAttribute("cx", String(hot.x));
      ring.setAttribute("cy", String(hot.y));
      ring.setAttribute("visibility", "visible");
      showTip(hot.tip, ev.clientX, ev.clientY);
    } else {
      ring.setAttribute("visibility", "hidden");
      hideTip();
    }
    rect.style.cursor = hot?.href ? "pointer" : "default";
  });
  rect.addEventListener("pointerleave", () => {
    ring.setAttribute("visibility", "hidden");
    hideTip();
  });
  rect.addEventListener("click", (ev) => {
    const p = nearest(ev);
    if (p?.href && ev.pointerType === "mouse") window.open(p.href, "_blank", "noopener");
  });
}

/* ---------------------------------------------------------------- Per-year bars */

function drawYears(el: HTMLElement, rows: Row[], width: number) {
  const thisYear = new Date().getUTCFullYear();
  const first = 1995;
  const years = Array.from({ length: thisYear - first + 1 }, (_, i) => first + i);
  const counts = new Map<number, number[]>(years.map((yr) => [yr, [0, 0, 0, 0]]));
  for (const r of rows) if (r[2] !== null && counts.has(r[2])) counts.get(r[2])![r[3]]!++;
  const height = 190;
  const m = { top: 12, right: 8, bottom: 24, left: 40 };
  const x = scaleBand<number>().domain(years).range([m.left, width - m.right]).paddingInner(0.18);
  const max = Math.max(...years.map((yr) => counts.get(yr)!.reduce((a, b) => a + b, 0)));
  const y = scaleLinear().domain([0, max]).range([height - m.bottom, m.top]).nice();
  const svg = svgRoot(width, height, "Confirmed exoplanet discoveries per year, by method");
  const g = s("g");
  svg.append(g);
  yAxis(g, y, y.ticks(4), (v) => fmt.int(v), m.left, width - m.right);
  const bw = Math.min(24, x.bandwidth());
  const points: HoverPoint[] = [];
  for (const yr of years) {
    const c = counts.get(yr)!;
    const total = c.reduce((a, b) => a + b, 0);
    let base = y(0);
    const bx = x(yr)! + (x.bandwidth() - bw) / 2;
    const segs = c.map((v, i) => [v, i] as const).filter(([v]) => v > 0);
    segs.forEach(([v, i], k) => {
      const segH = y(0) - y(v);
      const top = base - segH;
      const gap = k > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const hh = Math.max(0, segH - gap);
      const r = k === segs.length - 1 ? Math.min(3, bw / 2, hh / 2) : 0; // rounded data-end on top only
      const yy = top;
      const d = r
        ? `M${bx},${yy + hh} V${yy + r} Q${bx},${yy} ${bx + r},${yy} H${bx + bw - r} Q${bx + bw},${yy} ${bx + bw},${yy + r} V${yy + hh} Z`
        : `M${bx},${yy} h${bw} v${hh} h${-bw} Z`;
      g.append(s("path", { d, fill: `var(${METHOD_VAR[i]})` }));
      base = top;
    });
    points.push({
      x: bx + bw / 2, y: y(total),
      tip: { title: `${yr}${yr === thisYear ? " (so far)" : ""}: ${fmt.int(total)} planets`, rows: METHODS.map((name, i) => [name, fmt.int(c[i]!)] as [string, string]) },
    });
  }
  const ax = s("g", { class: "axis" });
  for (const yr of years) {
    if (yr % 5 !== 0 && yr !== thisYear) continue;
    if (yr !== thisYear && thisYear - yr < 3) continue;
    ax.append(s("text", { x: x(yr)! + x.bandwidth() / 2, y: height - m.bottom + 15, "text-anchor": "middle" }, String(yr)));
  }
  g.append(ax);
  hoverLayer(svg, points, { x: m.left, y: m.top, w: width - m.left - m.right, h: height - m.top - m.bottom }, 30);
  el.replaceChildren(svg);
}

/* ---------------------------------------------------------------- Sky map */

function drawSky(el: HTMLElement, view: ExoView, width: number) {
  const f = skyFrame(width, 4);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = h("canvas", { width: Math.round(width * dpr), height: Math.round(f.height * dpr), "aria-hidden": "true" });
  canvas.style.cssText = `position:absolute;inset:0;height:${f.height}px`;
  const ctx = canvas.getContext("2d")!;
  const recentNames = new Set(view.info.recent.map((p) => p.name));
  const hosts = new Map<string, [number, number, number]>();
  for (const r of view.catalog ?? []) if (r[8] !== null && r[9] !== null && !recentNames.has(r[0])) hosts.set(r[1], [r[8], r[9], r[3]]);
  const paint = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, f.height);
    const colors = METHOD_VAR.map((v) => cssVar(v));
    ctx.globalAlpha = 0.55;
    for (const [ra, dec, mi] of hosts.values()) {
      const [px, py] = f.project(ra, dec);
      ctx.fillStyle = colors[mi]!;
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
  };
  paint();
  const svg = svgRoot(width, f.height, "Sky positions of exoplanet host stars, equatorial coordinates");
  svg.style.position = "relative";
  svg.append(s("path", { d: f.outline(), fill: "none", stroke: "var(--axis)", "stroke-width": 1 }));
  for (const d of f.graticule()) svg.append(s("path", { d, fill: "none", stroke: "var(--grid)", "stroke-width": 1 }));
  svg.append(s("path", { d: f.galacticPlane(), fill: "none", stroke: "var(--ink-3)", "stroke-width": 1.2, opacity: 0.8 }));
  const [gx, gy] = f.project(266.4, -28.9);
  const nearEdge = gx > width - 110;
  svg.append(s("text", { class: "ref-label", x: nearEdge ? gx - 6 : gx + 6, y: gy + 16, "text-anchor": nearEdge ? "end" : "start" }, "Galactic centre"));
  const points: HoverPoint[] = [];
  for (const p of view.info.recent) {
    if (p.ra === null || p.dec === null) continue;
    const [px, py] = f.project(p.ra, p.dec);
    const c = s("circle", { cx: px, cy: py, r: 4.5, fill: methodColor(p.method), stroke: "var(--ink)", "stroke-width": 1.5 });
    svg.append(c);
    points.push({ x: px, y: py, mark: c, href: archiveUrl(p.name), tip: planetTip({ name: p.name, host: p.host, method: p.method, period: p.periodDays, radius: p.radiusEarth, dist: p.distPc, added: p.added }) });
  }
  hoverLayer(svg, points, { x: 0, y: 0, w: width, h: f.height }, 24);
  el.replaceChildren(h("div", { style: `position:relative;height:${f.height}px` }, canvas, svg));
  const onTheme = () => paint();
  window.addEventListener("themechange", onTheme);
  return () => window.removeEventListener("themechange", onTheme);
}

/* ---------------------------------------------------------------- Cards */

function planetGlyph(p: NewPlanet): SVGSVGElement {
  const svg = s("svg", { viewBox: "0 0 52 52", "aria-hidden": "true" });
  const earthR = 7;
  const r = p.radiusEarth === null ? null : Math.min(24, Math.max(2.5, earthR * p.radiusEarth));
  svg.append(s("circle", { cx: 26, cy: 26, r: 25, fill: "var(--panel-2)" }));
  if (r !== null) svg.append(s("circle", { cx: 26, cy: 26, r, fill: methodColor(p.method) }));
  svg.append(s("circle", { cx: 26, cy: 26, r: earthR, fill: "none", stroke: "var(--ink)", "stroke-width": 1.2 }));
  if (r === null) svg.append(s("text", { x: 26, y: 46, "text-anchor": "middle", class: "axis-label" }, "size ?"));
  return svg;
}

function cards(recent: NewPlanet[]): HTMLElement {
  return h(
    "div",
    { class: "planet-cards" },
    recent.slice(0, 9).map((p) =>
      h(
        "a",
        { class: "planet-card", href: safeUrl(archiveUrl(p.name)) ?? "#", target: "_blank", rel: "noopener", title: `${p.name} — open in the NASA Exoplanet Archive` },
        planetGlyph(p),
        h("div", { class: "pname" }, p.name),
        h("div", { class: "pmeta" }, `${p.method} · ${p.facility || "facility n/a"}`),
        h(
          "div",
          { class: "pfacts" },
          [
            p.radiusEarth !== null ? `${fmt.sig(p.radiusEarth, 2)} R⊕` : null,
            p.massEarth !== null ? `${fmt.sig(p.massEarth, 2)} M⊕` : null,
            p.periodDays !== null ? `${fmt.sig(p.periodDays, 3)} d` : null,
            p.eqTempK !== null ? `${fmt.int(p.eqTempK)} K` : null,
            lightYears(p.distPc),
            `added ${utcDate(p.added)}`,
          ].filter(Boolean).join(" · "),
        ),
      ),
    ),
  );
}

function recentTable(recent: NewPlanet[]): HTMLElement {
  return h(
    "details",
    { class: "table-toggle" },
    h("summary", null, `Show all ${recent.length} recently added planets as a table`),
    h(
      "div",
      { class: "data-table-wrap" },
      h(
        "table",
        { class: "data-table" },
        h("thead", null, h("tr", null, ["Planet", "Added", "Method", "Radius R⊕", "Mass M⊕", "Period d", "Temp K", "Distance"].map((t, i) => h("th", i >= 3 ? { class: "num", scope: "col" } : { scope: "col" }, t)))),
        h(
          "tbody",
          null,
          recent.map((p) =>
            h(
              "tr",
              null,
              h("td", null, p.name),
              h("td", null, utcDate(p.added, true)),
              h("td", null, p.method),
              h("td", { class: "num" }, p.radiusEarth !== null ? fmt.sig(p.radiusEarth, 3) : "—"),
              h("td", { class: "num" }, p.massEarth !== null ? fmt.sig(p.massEarth, 3) : "—"),
              h("td", { class: "num" }, p.periodDays !== null ? fmt.sig(p.periodDays, 4) : "—"),
              h("td", { class: "num" }, p.eqTempK !== null ? fmt.int(p.eqTempK) : "—"),
              h("td", { class: "num" }, p.distPc !== null ? lightYears(p.distPc) : "—"),
            ),
          ),
        ),
      ),
    ),
  );
}

const legend = () =>
  h(
    "ul",
    { class: "legend" },
    METHODS.map((name, i) => h("li", null, h("span", { class: "swatch", style: `--c:var(${METHOD_VAR[i]})` }), name === "Other" ? "Other methods" : name)),
    h("li", null, h("span", { class: "swatch ring", style: "--c:var(--ink)" }), "Recently added (ringed)"),
  );

export const exoplanetPanel: PanelDefinition<ExoView> = {
  id: "exoplanets",
  title: "Exoplanet discoveries",
  subtitle: "Every confirmed planet beyond the Solar System, with the newest additions to NASA’s archive highlighted",
  icon: ICONS.planet,
  span: "span-12",
  source: { name: "NASA Exoplanet Archive (TAP)", url: "https://exoplanetarchive.ipac.caltech.edu/" },

  async load(signal): Promise<PanelResult<ExoView>> {
    const [info, csv] = await Promise.allSettled([fetchSource("exoplanets", {}, signal), fetchText("/api/exoplanets/catalog", signal)]);
    if (info.status === "rejected") throw info.reason;
    const notices: Notice[] = [...info.value.notices];
    const upstream: UpstreamCall[] = [...info.value.upstream];
    let catalog: Row[] | null = null;
    let methodNames: string[] = [];
    if (csv.status === "fulfilled") {
      ({ rows: catalog, methodNames } = toRows(csv.value));
      upstream.push({ name: "Exoplanet Archive: full catalog (CSV)", url: "/api/exoplanets/catalog", ok: true, status: 200, ms: 0 });
    } else {
      const msg = csv.reason instanceof ApiError ? csv.reason.message : "unknown error";
      notices.push({ level: "warning", text: `The full planet catalog didn’t load (${msg}); charts are hidden, the newest planets are still listed.` });
    }
    return { data: { info: info.value.data, catalog, methodNames }, fetchedAt: info.value.fetchedAt, upstream, notices };
  },

  render(root, { data }) {
    const { info, catalog } = data;
    const recent = info.recent;
    const newest = recent[0];
    const nearest = [...recent].filter((p) => p.distPc !== null).sort((a, b) => a.distPc! - b.distPc!)[0];
    const smallest = [...recent].filter((p) => p.radiusEarth !== null).sort((a, b) => a.radiusEarth! - b.radiusEarth!)[0];
    const stat = (label: string, value: string, detail: string) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, value), h("div", { class: "stat-detail", title: detail }, detail));

    root.append(
      h(
        "div",
        { class: "stats" },
        stat("Confirmed planets", info.total !== null ? fmt.int(info.total) : catalog ? fmt.int(catalog.length) : "—", "in the Planetary Systems table"),
        stat(`Added, last ${info.windowDays} days`, String(recent.length), newest ? `latest batch ${utcDate(newest.added, true)}` : "none"),
        newest ? stat("Newest", newest.name, `${newest.method} · ${newest.host}`) : null,
        nearest ? stat("Nearest new world", lightYears(nearest.distPc), nearest.name) : null,
        smallest ? stat("Smallest new world", `${fmt.sig(smallest.radiusEarth!, 2)} R⊕`, smallest.name) : null,
      ),
    );

    const cleanups: (() => void)[] = [];
    if (catalog) {
      const scatter = h("div", { class: "chart" });
      const sky = h("div", { class: "chart" });
      const years = h("div", { class: "chart" });
      const withRadius = catalog.filter((r) => r[4] !== null && r[5] !== null).length;
      root.append(
        h(
          "div",
          { class: "exo-layout" },
          h(
            "div",
            { class: "chart-block" },
            h("div", { class: "chart-head" }, h("h3", null, "Discovery space"), h("p", null, `${fmt.int(withRadius)} planets with known period and radius · Solar System as open circles`)),
            scatter,
            legend(),
          ),
          h(
            "div",
            { class: "exo-right" },
            h(
              "div",
              { class: "chart-block" },
              h("div", { class: "chart-head" }, h("h3", null, "Where they are on the sky"), h("p", null, "Host stars · line = Milky Way plane")),
              sky,
            ),
            h("div", { class: "chart-block" }, h("div", { class: "chart-head" }, h("h3", null, "Discoveries per year"), h("p", null, "by method")), years),
          ),
        ),
      );
      let offScatterTheme: (() => void) | null = null;
      let offSkyTheme: (() => void) | null = null;
      cleanups.push(
        onResize(scatter, (w) => {
          offScatterTheme?.();
          offScatterTheme = drawDiscoverySpace(scatter, data, w);
        }),
        onResize(sky, (w) => {
          offSkyTheme?.();
          offSkyTheme = drawSky(sky, data, w);
        }),
        onResize(years, (w) => drawYears(years, catalog, w)),
        () => offScatterTheme?.(),
        () => offSkyTheme?.(),
      );
    }

    root.append(
      h("h3", { class: "section-title", style: "margin-top:20px" }, "Newest additions"),
      recent.length ? cards(recent) : h("p", { class: "footnote" }, `No planets were added in the last ${info.windowDays} days.`),
      ...(recent.length ? [recentTable(recent)] : []),
      h("p", { class: "footnote" }, "“Added” is when a planet first appeared in the archive, which usually follows its publication. Radii for non-transiting planets are often estimated from mass by the archive. Disc glyphs compare each planet’s size with Earth (ring)."),
    );
    return () => cleanups.forEach((f) => f());
  },

  summarize({ data }) {
    const p = data.info.recent[0];
    if (!p) return { label: "Newest exoplanet", icon: ICONS.planet, value: `${fmt.int(data.info.total ?? data.catalog?.length ?? 0)} known`, detail: "none added recently" };
    return {
      label: "Newest exoplanet",
      icon: ICONS.planet,
      value: p.name,
      detail: `added ${utcDate(p.added)} · ${p.radiusEarth !== null ? `${fmt.sig(p.radiusEarth, 2)} R⊕ · ` : ""}${lightYears(p.distPc)}`,
    };
  },
};
