import { scaleLinear, scaleLog, scaleUtc } from "d3-scale";
import type { Cme, Envelope, ErrorKind, Flare, GoesData, Notice, SolarData, UpstreamCall } from "../../shared/contract";
import { ApiError, fetchSource } from "../core/api";
import { h, icon, onResize, s, safeUrl } from "../core/dom";
import { fmt, relative, utc } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelHost, PanelResult } from "../core/panel";
import { hoverLayer, placeLabels, svgRoot, timeAxis, yAxis, type HoverPoint, type LabelCandidate } from "../viz/chart";
import { hideTip, showTip } from "../viz/tooltip";

const DAY = 86_400_000;
const AU_KM = 149_597_870.7;
const START_AU = 0.1; // CME speeds are measured from 21.5 solar radii ≈ 0.1 au

type Level = { label: string; color: string; rank: number };
const LEVELS: Level[] = [
  { label: "Quiet", color: "var(--good)", rank: 0 },
  { label: "Active", color: "var(--warning)", rank: 1 },
  { label: "Elevated", color: "var(--serious)", rank: 2 },
  { label: "Severe", color: "var(--critical)", rank: 3 },
];

/** NOAA radio-blackout scale from flare flux: M1=R1, M5=R2, X1=R3, X10=R4, X20=R5. */
function rScale(flux: number): number {
  if (flux >= 2e-3) return 5;
  if (flux >= 1e-3) return 4;
  if (flux >= 1e-4) return 3;
  if (flux >= 5e-5) return 2;
  if (flux >= 1e-5) return 1;
  return 0;
}
const severityColor = (r: number) => (r >= 3 ? "var(--critical)" : r === 2 ? "var(--serious)" : r === 1 ? "var(--warning)" : "var(--other)");
const gColor = (kp: number) => (kp >= 7 ? "var(--critical)" : kp >= 6 ? "var(--serious)" : kp >= 5 ? "var(--warning)" : "var(--other)");
const gLabel = (kp: number) => (kp >= 9 ? "G5" : kp >= 8 ? "G4" : kp >= 7 ? "G3" : kp >= 6 ? "G2" : kp >= 5 ? "G1" : "below storm level");

function cmeColor(c: Cme) {
  if (c.earth) return "var(--series-3)";
  if (c.lon === null) return "var(--other)";
  return "var(--series-1)";
}

const cmeName = (c: Cme) => `CME ${utc(c.start)}`;

function assess(data: SolarData, now: number) {
  const recent = now - 3 * DAY;
  const recentFlares = data.flares.filter((f) => new Date(f.peak).getTime() >= recent);
  const topRecent = recentFlares.reduce<Flare | null>((m, f) => (!m || f.flux > m.flux ? f : m), null);
  const recentKp = Math.max(0, ...data.storms.flatMap((s) => s.readings).filter((r) => new Date(r.time).getTime() >= recent).map((r) => r.kp));
  const incoming = data.cmes
    .filter((c) => c.earth?.arrival && new Date(c.earth.arrival).getTime() > now - 12 * 3600_000)
    .sort((a, b) => a.earth!.arrival!.localeCompare(b.earth!.arrival!));
  // Rank by the low end of the modelled Kp range (the high end assumes the worst magnetic orientation).
  const incomingKp = Math.max(0, ...incoming.map((c) => c.earth?.kpMin ?? 0));

  let rank = 0;
  const r = topRecent ? rScale(topRecent.flux) : 0;
  if (r >= 3 || recentKp >= 7 || incomingKp >= 7) rank = 3;
  else if (r >= 2 || recentKp >= 6 || incomingKp >= 6) rank = 2;
  else if (r >= 1 || recentKp >= 5 || incoming.length) rank = 1;

  const parts: string[] = [];
  if (topRecent) parts.push(`Strongest flare in the last 3 days: ${topRecent.classType} (${utc(topRecent.peak)}).`);
  else parts.push("No flares catalogued in the last 3 days.");
  const upcoming = incoming.filter((c) => new Date(c.earth!.arrival!).getTime() > now);
  if (upcoming.length) {
    const first = upcoming[0]!;
    parts.push(
      `${upcoming.length} CME${upcoming.length > 1 ? "s" : ""} predicted to reach Earth; first ${relative(first.earth!.arrival!, now)}${first.earth!.kpMax !== null ? ` (Kp ${first.earth!.kpMin}–${first.earth!.kpMax} modelled)` : ""}.`,
    );
  }
  if (recentKp >= 5) parts.push(`Geomagnetic storm reached Kp ${fmt.fixed(recentKp, 1)} (${gLabel(recentKp)}).`);
  return { level: LEVELS[rank]!, text: parts.join(" "), upcoming, incoming };
}

function flareTip(f: Flare) {
  const r = rScale(f.flux);
  return {
    title: `${f.classType} flare`,
    rows: [
      ["Peak", utc(f.peak)],
      ["Region", f.region ? `AR ${f.region}` : "—"],
      ["Location", f.location || "—"],
      ["Radio blackout", r ? `R${r}` : "below R1"],
    ] as [string, string][],
    note: f.linkedIds.some((id) => id.includes("CME")) ? "Linked to a coronal mass ejection." : undefined,
  };
}

function cmeTip(c: Cme) {
  const rows: [string, string][] = [
    ["Speed", c.speed ? `${fmt.int(c.speed)} km/s` : "—"],
    ["Direction", c.lon === null ? "unknown" : `${c.lat ?? "?"}° lat, ${c.lon}° lon`],
    ["Width", c.halfAngle ? `${c.halfAngle * 2}°` : "—"],
  ];
  if (c.earth) {
    rows.push(["Earth arrival", c.earth.arrival ? utc(c.earth.arrival) : "glancing, time n/a"]);
    if (c.earth.kpMax !== null) rows.push(["Modelled Kp", `${c.earth.kpMin}–${c.earth.kpMax}`]);
  }
  return { title: cmeName(c), rows, note: c.earth ? (c.earth.glancingBlow ? "WSA-ENLIL: glancing blow at Earth." : "WSA-ENLIL: direct arrival at Earth.") : undefined };
}

function drawTimeline(el: HTMLElement, data: SolarData, width: number) {
  const now = Date.now();
  const narrow = width < 560;
  const m = { left: 48, right: narrow ? 26 : 30 };
  const bands = { flare: { top: 22, h: 132 }, cme: { top: 182, h: 96 }, kp: { top: 306, h: 84 } };
  const height = bands.kp.top + bands.kp.h + 30;
  const svg = svgRoot(width, height, "Solar flares, coronal mass ejections and the Kp index over time");
  const g = s("g");
  svg.append(g);

  const start = new Date(data.start).getTime();
  const lastArrival = Math.max(0, ...data.cmes.map((c) => (c.earth?.arrival ? new Date(c.earth.arrival).getTime() : 0)));
  const end = Math.min(now + 5 * DAY, Math.max(now + 2.5 * DAY, lastArrival + 0.6 * DAY));
  const x = scaleUtc().domain([new Date(start), new Date(end)]).range([m.left, width - m.right]);
  const x0 = m.left, x1 = width - m.right;

  // Forecast zone.
  const nx = Math.round(x(new Date(now)));
  g.append(s("rect", { x: nx, y: bands.flare.top - 8, width: x1 - nx, height: height - 30 - bands.flare.top + 8, fill: "var(--panel-2)" }));
  g.append(s("text", { class: "ref-label", x: nx + 6, y: bands.flare.top + 4 }, "forecast"));

  const points: HoverPoint[] = [];
  const bandTitle = (y: number, t: string) => g.append(s("text", { class: "ref-label", x: x0, y: y - 8, "font-weight": 600 }, t));

  // --- Flares (log X-ray flux).
  const yf = scaleLog().domain([1e-8, 1e-3]).range([bands.flare.top + bands.flare.h, bands.flare.top]);
  bandTitle(bands.flare.top, "Solar flares · peak X-ray class");
  yAxis(g, yf, [1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3], () => "", x0, x1, { grid: true });
  ["A", "B", "C", "M", "X"].forEach((cls, i) => {
    const yy = (yf(10 ** (-8 + i)) + yf(10 ** (-7 + i))) / 2;
    g.append(s("text", { class: "axis-label", x: x0 - 10, y: yy + 4, "text-anchor": "end" }, cls));
  });
  if (!data.feeds.flares) g.append(s("text", { class: "ref-label", x: (x0 + x1) / 2, y: bands.flare.top + 60, "text-anchor": "middle" }, "Flare feed unavailable"));
  const flaresByFlux = [...data.flares].sort((a, b) => a.flux - b.flux);
  const labels: LabelCandidate[] = [];
  const labelled = new Set([...data.flares].filter((f) => f.flux >= 1e-5).sort((a, b) => b.flux - a.flux).slice(0, narrow ? 3 : 6).map((f) => f.id));
  for (const f of flaresByFlux) {
    const px = x(new Date(f.peak));
    const py = yf(Math.min(Math.max(f.flux, 1.1e-8), 9e-4));
    const color = severityColor(rScale(f.flux));
    g.append(s("line", { x1: px, x2: px, y1: bands.flare.top + bands.flare.h, y2: py, stroke: color, "stroke-width": 2, "stroke-linecap": "round", opacity: 0.8 }));
    const dot = s("circle", { cx: px, cy: py, r: 4.5, fill: color, stroke: "var(--panel)", "stroke-width": 2 });
    g.append(dot);
    if (labelled.has(f.id)) labels.push({ x: px, y: py - 9, text: f.classType, anchor: "middle" });
    points.push({ x: px, y: py, tip: flareTip(f), mark: dot, href: f.link });
  }

  // Biggest flares get first pick of label space.
  placeLabels(g, labels.sort((a, b) => a.y - b.y));

  // --- CMEs (speed).
  const maxSpeed = Math.max(1200, ...data.cmes.map((c) => c.speed ?? 0)) * 1.08;
  const yc = scaleLinear().domain([0, maxSpeed]).range([bands.cme.top + bands.cme.h, bands.cme.top]).nice();
  bandTitle(bands.cme.top, "Coronal mass ejections · speed km/s");
  yAxis(g, yc, yc.ticks(3), (v) => fmt.compact(v), x0, x1);
  if (!data.feeds.cmes) g.append(s("text", { class: "ref-label", x: (x0 + x1) / 2, y: bands.cme.top + 50, "text-anchor": "middle" }, "CME feed unavailable"));
  const cmeDots = new Map<string, { x: number; y: number }>();
  for (const c of [...data.cmes].sort((a, b) => Number(!!a.earth) - Number(!!b.earth))) {
    if (c.speed === null) continue;
    const px = x(new Date(c.start));
    const py = yc(c.speed);
    const dot = s("circle", { cx: px, cy: py, r: c.earth ? 5 : 4, fill: cmeColor(c), stroke: "var(--panel)", "stroke-width": 2 });
    g.append(dot);
    cmeDots.set(c.id, { x: px, y: py });
    points.push({ x: px, y: py, tip: cmeTip(c), mark: dot, href: c.link });
  }

  // --- Kp (storm readings) + modelled CME arrivals.
  const yk = scaleLinear().domain([0, 9]).range([bands.kp.top + bands.kp.h, bands.kp.top]);
  bandTitle(bands.kp.top, "Geomagnetic activity · Kp index");
  yAxis(g, yk, [0, 3, 5, 7, 9], (v) => String(v), x0, x1);
  const g1 = Math.round(yk(5)) + 0.5;
  g.append(s("line", { class: "ref-line", x1: x0, x2: x1, y1: g1, y2: g1 }));
  g.append(s("text", { class: "ref-label", x: x0 + 4, y: g1 - 4 }, "storm level (G1)"));
  const barW = Math.max(4, x(new Date(start + 3 * 3600_000)) - x(new Date(start)) - 1);
  for (const st of data.storms) {
    for (const r of st.readings) {
      const px = x(new Date(r.time));
      const top = yk(r.kp);
      const bar = s("rect", { x: px - barW / 2, y: top, width: barW, height: yk(0) - top, fill: gColor(r.kp), rx: 1.5 });
      g.append(bar);
      points.push({ x: px, y: top, tip: { title: `Kp ${fmt.fixed(r.kp, 2)} · ${gLabel(r.kp)}`, rows: [["Observed", utc(r.time)], ["Source", r.source || "—"]] }, mark: bar, href: st.link });
    }
  }
  if (!data.storms.length && data.feeds.storms) {
    g.append(s("text", { class: "ref-label", x: (x0 + nx) / 2, y: bands.kp.top + bands.kp.h - 30, "text-anchor": "middle" }, "No geomagnetic storms (Kp ≥ 5) in this window"));
  }
  for (const c of data.cmes) {
    if (!c.earth?.arrival) continue;
    const t = new Date(c.earth.arrival).getTime();
    if (t < start || t > end) continue;
    const px = x(new Date(t));
    const lo = yk(c.earth.kpMin ?? 1);
    const hi = yk(c.earth.kpMax ?? 3);
    const future = t > now;
    const from = cmeDots.get(c.id);
    if (from && future) {
      g.append(s("path", { d: `M${from.x},${from.y} C${from.x},${bands.kp.top - 6} ${px},${from.y + 20} ${px},${hi}`, fill: "none", stroke: "var(--series-3)", "stroke-width": 1, opacity: 0.5 }));
    }
    g.append(s("line", { x1: px, x2: px, y1: lo, y2: hi, stroke: "var(--series-3)", "stroke-width": 3, "stroke-linecap": "round", opacity: future ? 1 : 0.4 }));
    const marker = s("rect", { x: px - 4, y: hi - 4, width: 8, height: 8, transform: `rotate(45 ${px} ${hi})`, fill: future ? "var(--series-3)" : "var(--panel)", stroke: "var(--series-3)", "stroke-width": 1.5 });
    g.append(marker);
    points.push({
      x: px, y: hi,
      tip: { title: `Predicted CME arrival · ${utc(c.earth.arrival)}`, rows: [["From", cmeName(c)], ["Modelled Kp", c.earth.kpMax !== null ? `${c.earth.kpMin}–${c.earth.kpMax}` : "n/a"], ["Type", c.earth.glancingBlow ? "glancing blow" : "direct arrival"]], note: future ? `${relative(c.earth.arrival, now)}` : "Prediction for a past time." },
      mark: marker, href: c.link,
    });
  }

  // Now line + shared axis.
  g.append(s("line", { class: "now-line", x1: nx + 0.5, x2: nx + 0.5, y1: bands.flare.top - 8, y2: height - 30 }));
  g.append(s("text", { class: "ref-label", x: nx - 5, y: bands.flare.top + 4, "text-anchor": "end" }, "now"));
  timeAxis(g, x, height - 30, null, Math.floor((x1 - x0) / (narrow ? 60 : 80)));

  hoverLayer(svg, points, { x: x0 - 6, y: bands.flare.top - 8, w: x1 - x0 + 12, h: height - 30 - bands.flare.top + 8 }, 28);
  el.replaceChildren(svg);
}

/** Top-down heliosphere: where recent CMEs' leading edges are now, at constant speed. */
function drawHeliosphere(el: HTMLElement, data: SolarData, width: number) {
  const now = Date.now();
  const size = Math.min(width, 380);
  const c = size / 2;
  const MAX_AU = 1.3;
  const auPx = (size / 2 - 16) / MAX_AU;
  const svg = svgRoot(size, size, "Top-down view of the inner solar system with coronal mass ejections in transit");
  svg.style.margin = "0 auto";
  const g = s("g");
  svg.append(g);

  const orbitLabels: SVGTextElement[] = [];
  // Orbits (planets are not drawn at their real positions; only the distances matter here).
  for (const [au, name] of [[0.387, "Mercury"], [0.723, "Venus"], [1, "Earth’s orbit (1 au)"]] as [number, string][]) {
    g.append(s("circle", { cx: c, cy: c, r: au * auPx, fill: "none", stroke: au === 1 ? "var(--axis)" : "var(--grid)", "stroke-width": au === 1 ? 1.5 : 1 }));
    // Labels sit just above the top of each orbit, clear of the line. They are added after the
    // CME arcs (below) with a halo, so arcs crossing them never make them unreadable.
    orbitLabels.push(s("text", { class: "axis-label halo", x: c, y: c - au * auPx - 9, "text-anchor": "middle" }, name));
  }

  // Leading edge of each recent CME with a known direction.
  const inTransit = data.cmes
    .filter((cm) => cm.lon !== null && cm.speed && cm.time21_5 && cm.halfAngle)
    .map((cm) => {
      const dt = (now - new Date(cm.time21_5!).getTime()) / 1000;
      return { cm, r: START_AU + (cm.speed! * dt) / AU_KM };
    })
    .filter(({ r }) => r > START_AU && r < MAX_AU)
    // Keep the picture readable: Earth-directed first, then fastest; at most 8.
    .sort((a, b) => Number(!!b.cm.earth) - Number(!!a.cm.earth) || b.cm.speed! - a.cm.speed!)
    .slice(0, 8)
    .reverse();

  const points: HoverPoint[] = [];
  const pol = (au: number, deg: number) => {
    const rad = (deg * Math.PI) / 180;
    // Stonyhurst longitude: 0 = towards Earth (right), west (+) is counter-clockwise seen from the north.
    return [c + Math.cos(rad) * au * auPx, c - Math.sin(rad) * au * auPx] as const;
  };
  for (const { cm, r } of inTransit) {
    const color = cmeColor(cm);
    const a0 = cm.lon! - cm.halfAngle!;
    const a1 = cm.lon! + cm.halfAngle!;
    const steps = 24;
    let d = `M${pol(START_AU, a0).join(",")}`;
    for (let i = 0; i <= steps; i++) d += ` L${pol(r, a0 + ((a1 - a0) * i) / steps).join(",")}`;
    d += ` L${pol(START_AU, a1).join(",")} Z`;
    const wedge = s("path", { d, fill: color, "fill-opacity": 0.1, stroke: "none" });
    let front = `M${pol(r, a0).join(",")}`;
    for (let i = 1; i <= steps; i++) front += ` L${pol(r, a0 + ((a1 - a0) * i) / steps).join(",")}`;
    const edge = s("path", { d: front, fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linecap": "round" });
    g.append(wedge, edge);
    const [tx, ty] = pol(r, cm.lon!);
    points.push({
      x: tx, y: ty, mark: edge, href: cm.link,
      tip: { ...cmeTip(cm), note: `Estimated front ≈ ${fmt.fixed(r, 2)} au from the Sun now (constant speed).${cm.earth ? " Modelled to reach Earth." : ""}` },
    });
  }

  g.append(...orbitLabels);

  // Sun and Earth.
  g.append(s("circle", { cx: c, cy: c, r: 7, fill: "var(--sun)" }));
  g.append(s("text", { class: "ref-label", x: c, y: c + 20, "text-anchor": "middle" }, "Sun"));
  const [ex, ey] = pol(1, 0);
  g.append(s("circle", { cx: ex, cy: ey, r: 5, fill: "var(--ink)", stroke: "var(--panel)", "stroke-width": 2 }));
  g.append(s("text", { class: "mark-label", x: ex - 9, y: ey - 9, "text-anchor": "end" }, "Earth"));

  if (!inTransit.length) {
    g.append(s("text", { class: "ref-label", x: c, y: c + auPx * 0.5, "text-anchor": "middle" }, "No catalogued CMEs in transit right now"));
  }
  hoverLayer(svg, points, { x: 0, y: 0, w: size, h: size }, 36);
  el.replaceChildren(svg);
}

function sideLists(data: SolarData, now: number, earthCmes: Cme[]) {
  const top = [...data.flares].sort((a, b) => b.flux - a.flux).slice(0, 5);
  const earthList = earthCmes.length
    ? h(
        "ol",
        { class: "rank-list" },
        [...earthCmes].reverse().slice(0, 5).map((c) =>
          h(
            "li",
            null,
            h("span", { class: "name" }, h("a", { href: safeUrl(c.link) ?? "#", target: "_blank", rel: "noopener" }, `Arrives ${utc(c.earth!.arrival!)}`)),
            h("span", { class: "sub" }, `${relative(c.earth!.arrival!, now)} · ${c.earth!.glancingBlow ? "glancing blow" : "direct"} · left Sun ${utc(c.start, false)}${c.speed ? ` at ${fmt.int(c.speed)} km/s` : ""}`),
            h("span", { class: "value" }, c.earth!.kpMax !== null ? `Kp ${c.earth!.kpMin}–${c.earth!.kpMax}` : "—", h("small", null, "modelled")),
          ),
        ),
      )
    : h("p", { class: "footnote" }, "No Earth-directed CMEs modelled in this window.");
  const flareList = top.length
    ? h(
        "ol",
        { class: "rank-list" },
        top.map((f) =>
          h(
            "li",
            null,
            h("span", { class: "name" }, h("a", { href: safeUrl(f.link) ?? "#", target: "_blank", rel: "noopener" }, f.region ? `Region ${f.region}` : "Unnumbered region")),
            h("span", { class: "sub" }, `${utc(f.peak)} · ${f.location || "location n/a"}`),
            h("span", { class: "value" }, h("span", { class: "status-tag", style: `--tag:${severityColor(rScale(f.flux))};font:inherit` }, f.classType), h("small", null, rScale(f.flux) ? `R${rScale(f.flux)} blackout` : "minor")),
          ),
        ),
      )
    : h("p", { class: "footnote" }, "No flares in this window.");
  return [h("div", null, h("h3", { class: "section-title" }, "CMEs modelled to reach Earth"), earthList), h("div", null, h("h3", { class: "section-title" }, "Strongest flares"), flareList)];
}

/* ---------------------------------------------------------------- GOES X-ray flux (live) */

const CLASS_LETTERS = ["A", "B", "C", "M", "X"] as const;

/** 6.5e-7 → "B6.5"; X-class keeps counting past 10 (X12.3). */
export function xrayClass(flux: number): string {
  const i = Math.max(0, Math.min(4, Math.floor(Math.log10(flux) + 8)));
  return `${CLASS_LETTERS[i]}${fmt.fixed(flux / 10 ** (i - 8), 1)}`;
}

const sci = (v: number) => {
  const e = Math.floor(Math.log10(v));
  return `${fmt.fixed(v / 10 ** e, 1)}×10${String(e).replace("-", "⁻").replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]!)} W/m²`;
};

function latestPoint(g: GoesData): [number, number] | null {
  for (let i = g.points.length - 1; i >= 0; i--) {
    const p = g.points[i]!;
    if (p[1] !== null) return [p[0], p[1]];
  }
  return null;
}

function drawXray(el: HTMLElement, g: GoesData, width: number, hours: number) {
  const now = Date.now();
  const narrow = width < 560;
  const m = { left: 44, right: narrow ? 12 : 92, top: 14, bottom: 28 };
  const height = narrow ? 210 : 230;
  const svg = svgRoot(width, height, `GOES X-ray flux, last ${hours} hours`);
  const gr = s("g");
  svg.append(gr);
  const last = g.points.length ? g.points[g.points.length - 1]![0] : now;
  const end = Math.max(last, now - 5 * 60_000);
  const start = end - hours * 3600_000;
  const x = scaleUtc().domain([new Date(start), new Date(end)]).range([m.left, width - m.right]);
  const y = scaleLog().domain([1e-9, 1e-3]).range([height - m.bottom, m.top]).clamp(true);
  const x0 = m.left, x1 = width - m.right;

  yAxis(gr, y, [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3], () => "", x0, x1, { grid: true });
  CLASS_LETTERS.forEach((cls, i) => {
    const yy = (y(10 ** (-8 + i)) + y(10 ** (-7 + i))) / 2;
    gr.append(s("text", { class: "axis-label", x: x0 - 10, y: yy + 4, "text-anchor": "end" }, cls));
  });
  // R1 (M1) threshold: the level at which flares start to cause radio blackouts.
  const yr1 = Math.round(y(1e-5)) + 0.5;
  gr.append(s("line", { class: "ref-line", x1: x0, x2: x1, y1: yr1, y2: yr1, "stroke-dasharray": "3 3" }));
  gr.append(s("text", { class: "ref-label", x: x0 + 4, y: yr1 - 4 }, "M1 · radio blackouts start (R1)"));

  // Flare in progress: shade from its start to now.
  const lf = g.latestFlare;
  if (lf && !lf.end && Date.parse(lf.begin) > start) {
    const bx = x(new Date(lf.begin));
    gr.append(s("rect", { x: bx, y: m.top, width: Math.max(2, x(new Date(end)) - bx), height: height - m.top - m.bottom, fill: "var(--warning)", opacity: 0.12 }));
    gr.append(s("text", { class: "ref-label", x: bx + 4, y: m.top + 12 }, `flare in progress${lf.currentClass ? ` · ${lf.currentClass}` : ""}`));
  }

  const inView = g.points.filter((p) => p[0] >= start - 60_000);
  // Data gaps of 10+ minutes (outages; around the equinoxes GOES also passes through Earth's
  // shadow once a day, when the flux ramps down to zero for up to ~70 min).
  let gapFrom: number | null = null;
  const gaps: [number, number][] = [];
  for (const p of inView) {
    if (p[1] === null) gapFrom ??= p[0];
    else if (gapFrom !== null) {
      if (p[0] - gapFrom >= 10 * 60_000) gaps.push([gapFrom, p[0]]);
      gapFrom = null;
    }
  }
  if (gapFrom !== null && end - gapFrom >= 10 * 60_000) gaps.push([gapFrom, end]);
  for (const [a, b] of gaps) {
    const gx = x(new Date(Math.max(a, start)));
    const gw = x(new Date(b)) - gx;
    if (gw < 2) continue;
    gr.append(s("rect", { x: gx, y: m.top, width: gw, height: height - m.top - m.bottom, fill: "var(--panel-2)" }));
    if (gw > 46) gr.append(s("text", { class: "ref-label", x: gx + gw / 2, y: height - m.bottom - 6, "text-anchor": "middle" }, "data gap"));
  }
  const path = (idx: 1 | 2) => {
    let d = "";
    let prev: number | null = null;
    for (const p of inView) {
      const v = p[idx];
      if (v === null) {
        prev = null;
        continue;
      }
      d += `${prev === null || p[0] - prev > 3 * 60_000 ? "M" : "L"}${x(new Date(p[0])).toFixed(1)},${y(v).toFixed(1)}`;
      prev = p[0];
    }
    return d;
  };
  gr.append(s("path", { d: path(2), fill: "none", stroke: "var(--other)", "stroke-width": 1.5, "stroke-linejoin": "round" }));
  gr.append(s("path", { d: path(1), fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round" }));

  // Direct labels at the line ends (desktop), so identity isn't colour-only.
  const lastLong = [...inView].reverse().find((p) => p[1] !== null);
  const lastShort = [...inView].reverse().find((p) => p[2] !== null);
  if (!narrow) {
    const ly1 = lastLong ? y(lastLong[1]!) : null;
    let ly2 = lastShort ? y(lastShort[2]!) : null;
    if (ly1 !== null && ly2 !== null && Math.abs(ly1 - ly2) < 14) ly2 = ly1 + (ly2 >= ly1 ? 14 : -14);
    if (ly1 !== null) gr.append(s("text", { class: "mark-label", x: x1 + 6, y: ly1 + 4 }, "0.1–0.8 nm"));
    if (ly2 !== null) gr.append(s("text", { class: "ref-label", x: x1 + 6, y: ly2 + 4 }, "0.05–0.4 nm"));
  }

  // Flare peaks: biggest first get label space.
  const labels: LabelCandidate[] = [];
  const peaks = g.flares.filter((f) => Date.parse(f.max) >= start && f.maxFlux >= 1e-6).sort((a, b) => b.maxFlux - a.maxFlux).slice(0, narrow ? 3 : 6);
  for (const f of peaks) {
    const px = x(new Date(f.max)), py = y(f.maxFlux);
    gr.append(s("circle", { cx: px, cy: py, r: 3.5, fill: severityColor(rScale(f.maxFlux)), stroke: "var(--panel)", "stroke-width": 1.5 }));
    labels.push({ x: px, y: py - 8, text: f.maxClass, anchor: "middle" });
  }
  placeLabels(gr, labels);

  // Now marker.
  const lp = latestPoint(g);
  if (lp) {
    const px = x(new Date(lp[0])), py = y(lp[1]);
    gr.append(s("circle", { cx: px, cy: py, r: 4.5, fill: "var(--series-1)", stroke: "var(--panel)", "stroke-width": 2 }));
  }
  timeAxis(gr, x, height - m.bottom, null, Math.floor((x1 - x0) / (narrow ? 70 : 90)));

  // Crosshair hover: nearest minute.
  const cross = s("line", { class: "ref-line", x1: 0, x2: 0, y1: m.top, y2: height - m.bottom, visibility: "hidden" });
  const dot = s("circle", { r: 4, fill: "var(--series-1)", stroke: "var(--panel)", "stroke-width": 2, visibility: "hidden" });
  gr.append(cross, dot);
  const hit = s("rect", { class: "hit", x: x0, y: m.top, width: x1 - x0, height: height - m.top - m.bottom });
  svg.append(hit);
  const times = inView.map((p) => p[0]);
  const move = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const lx = ((ev.clientX - r.left) / r.width) * width;
    const t = x.invert(lx).getTime();
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < t) lo = mid;
      else hi = mid;
    }
    const p = inView[Math.abs(times[lo]! - t) < Math.abs(times[hi]! - t) ? lo : hi];
    if (!p) return;
    const px = x(new Date(p[0]));
    cross.setAttribute("x1", String(px));
    cross.setAttribute("x2", String(px));
    cross.setAttribute("visibility", "visible");
    if (p[1] !== null) {
      dot.setAttribute("cx", String(px));
      dot.setAttribute("cy", String(y(p[1])));
      dot.setAttribute("visibility", "visible");
    } else dot.setAttribute("visibility", "hidden");
    showTip(
      {
        title: utc(new Date(p[0])),
        rows: [
          ["0.1–0.8 nm", p[1] !== null ? `${xrayClass(p[1])} · ${sci(p[1])}` : "no data"],
          ["0.05–0.4 nm", p[2] !== null ? sci(p[2]) : "no data"],
        ],
      },
      ev.clientX,
      ev.clientY,
    );
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    hideTip();
  });
  el.replaceChildren(svg);
}

/** Merge a fresh (6-hour) GOES download into the series already shown, keeping 24 h. */
export function mergeGoes(prev: GoesData | null, next: GoesData): GoesData {
  if (!prev || next.hours >= prev.hours) return next;
  const byT = new Map<number, GoesData["points"][number]>();
  for (const p of prev.points) byT.set(p[0], p);
  for (const p of next.points) byT.set(p[0], p);
  const points = [...byT.values()].sort((a, b) => a[0] - b[0]);
  const cut = points.length ? points[points.length - 1]![0] - prev.hours * 3600_000 : 0;
  const flares = new Map<string, GoesData["flares"][number]>();
  for (const f of [...prev.flares, ...next.flares]) flares.set(f.begin, f);
  if (next.latestFlare) flares.set(next.latestFlare.begin, next.latestFlare);
  return {
    satellite: next.satellite ?? prev.satellite,
    hours: prev.hours,
    points: points.filter((p) => p[0] >= cut),
    flares: [...flares.values()].filter((f) => Date.parse(f.max) >= cut && f.end).sort((a, b) => a.max.localeCompare(b.max)),
    latestFlare: next.latestFlare,
  };
}

/* ---------------------------------------------------------------- Two independent feeds */

interface Feed<T> {
  data: T | null;
  fetchedAt: string | null;
  error: { message: string; hint?: string; kind?: string; at: string } | null;
  upstream: UpstreamCall[];
  notices: Notice[];
}

/** DONKI (events) and GOES (live X-rays) load, fail and refresh independently. */
export interface SolarView {
  donki: Feed<SolarData>;
  goes: Feed<GoesData>;
}

const emptyFeed = <T,>(): Feed<T> => ({ data: null, fetchedAt: null, error: null, upstream: [], notices: [] });

async function runFeed<T>(prev: Feed<T> | undefined, fetcher: () => Promise<Envelope<T>>, merge?: (prev: T | null, next: T) => T): Promise<Feed<T>> {
  try {
    const env = await fetcher();
    return { data: merge ? merge(prev?.data ?? null, env.data) : env.data, fetchedAt: env.fetchedAt, error: null, upstream: env.upstream, notices: env.notices };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    const api = err instanceof ApiError ? err : null;
    // Keep the previous data (shown as stale) and record why the update failed.
    return {
      ...(prev ?? emptyFeed<T>()),
      error: { message: api?.message ?? (err as Error).message, hint: api?.body?.error.hint, kind: api?.body?.error.kind, at: new Date().toISOString() },
      upstream: api?.body?.upstream ?? [],
    };
  }
}

const GOES_EVERY = 60_000;

function errorInline(title: string, f: Feed<unknown>, actions: HTMLElement[]): HTMLElement {
  return h(
    "div",
    { class: "error-state inline", role: "alert" },
    h("div", null, h("h3", null, title), h("p", null, f.error?.message ?? ""), f.error?.hint ? h("p", { class: "hint" }, f.error.hint) : null, actions.length ? h("div", { class: "error-actions" }, actions) : null),
  );
}

function xrayBlock(g: GoesData, staleNote: string | null, hours: { value: number }): { el: HTMLElement; redraw(g: GoesData, staleNote: string | null): void; destroy(): void } {
  const chart = h("div", { class: "chart" });
  const now = h("div", { class: "xray-now" });
  const note = h("p", { class: "footnote xray-stale" });
  const seg = h("div", { class: "segmented", role: "group", "aria-label": "X-ray time range" });
  let data = g;
  let width = 0;
  const draw = () => width && drawXray(chart, data, width, hours.value);
  for (const [v, label] of [[6, "6 h"], [24, "24 h"]] as [number, string][]) {
    const b = h("button", { type: "button", "aria-pressed": String(hours.value === v) }, label);
    b.addEventListener("click", () => {
      hours.value = v;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw();
    });
    seg.append(b);
  }
  const fill = () => {
    const lp = latestPoint(data);
    const max = data.points.reduce<[number, number] | null>((mx, p) => (p[1] !== null && (!mx || p[1] > mx[1]) ? [p[0], p[1]] : mx), null);
    const r = lp ? rScale(lp[1]) : 0;
    now.replaceChildren(
      h("div", { class: "xray-reading" }, h("span", { class: "stat-label" }, "X-ray level now"), h("span", { class: "xray-class" }, lp ? xrayClass(lp[1]) : "—"), lp ? h("span", { class: "status-tag", style: `--tag:${severityColor(r)}` }, r ? `R${r} radio blackout` : "below R1") : null),
      h("div", { class: "xray-meta" }, lp ? `${utc(new Date(lp[0]))} · ${sci(lp[1])}` : "no recent reading", max ? h("span", null, ` · ${data.hours} h peak ${xrayClass(max[1])} at ${utc(new Date(max[0])).replace(" UTC", "")}`) : null),
    );
    note.textContent = staleNow ?? "";
    note.hidden = !staleNow;
  };
  let staleNow = staleNote;
  fill();
  const off = onResize(chart, (w) => {
    width = w;
    draw();
  });
  const el = h(
    "div",
    { class: "chart-block xray-block" },
    h("div", { class: "chart-head" }, h("h3", null, `Solar X-rays right now · GOES-${g.satellite ?? "?"}`), h("div", { class: "chart-head-tools" }, h("p", null, "1-minute data from NOAA SWPC"), seg)),
    now,
    chart,
    note,
    h(
      "ul",
      { class: "legend" },
      h("li", null, h("span", { class: "swatch line", style: "--c:var(--series-1)" }), "0.1–0.8 nm (defines the flare class)"),
      h("li", null, h("span", { class: "swatch line", style: "--c:var(--other)" }), "0.05–0.4 nm"),
      h("li", null, h("span", { class: "swatch", style: "--c:var(--other)" }), "flare peak ≥ C1 (yellow/orange/red from M1 = R1, as in the timeline)"),
    ),
  );
  return {
    el,
    redraw(next, stale) {
      data = next;
      staleNow = stale;
      fill();
      draw();
    },
    destroy: off,
  };
}

function goesStale(f: Feed<GoesData>): string | null {
  if (!f.error || !f.data) return null;
  return `Latest X-ray update failed (${utc(f.error.at)}): ${f.error.message} Showing data from ${f.fetchedAt ? utc(f.fetchedAt) : "earlier"}.`;
}

export const solarPanel: PanelDefinition<SolarView> = {
  id: "solar",
  title: "Solar activity & space weather",
  subtitle: "Live X-ray flux, flares, coronal mass ejections and geomagnetic storms, with modelled CME arrivals at Earth",
  icon: ICONS.flare,
  span: "span-12",
  source: { name: "NASA DONKI (CCMC) · NOAA SWPC GOES", url: "https://ccmc.gsfc.nasa.gov/tools/DONKI/" },

  live: [
    { label: "X-ray flux", everyMs: GOES_EVERY, params: { feed: "goes" }, lastUpdate: (r) => r.data.goes.fetchedAt },
    { label: "solar events (DONKI)", everyMs: 15 * 60_000, params: { feed: "donki" }, lastUpdate: (r) => r.data.donki.fetchedAt },
  ],

  migrate(snap) {
    const d = snap.data as Partial<SolarView> & Partial<SolarData>;
    if (d && "donki" in d && "goes" in d) return snap as PanelResult<SolarView>;
    // v1 snapshots held DONKI data only.
    if (d && Array.isArray(d.flares)) {
      return { ...snap, data: { donki: { data: d as SolarData, fetchedAt: snap.fetchedAt, error: null, upstream: snap.upstream, notices: snap.notices }, goes: emptyFeed<GoesData>() } };
    }
    return null;
  },

  controls(host: PanelHost<SolarView>) {
    const wrap = h("div", { class: "segmented", role: "group", "aria-label": "Time range" });
    const options: [string, string][] = [["7", "7 d"], ["30", "30 d"], ["59", "60 d"]];
    const sync = () => {
      for (const b of wrap.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.days === (host.params.days ?? "30")));
    };
    let touched = false;
    const shownDays = () => host.result?.data.donki.data?.days;
    host.onChange(() => {
      // Until the user picks a range, mirror the range of whatever data is shown (e.g. a restored snapshot).
      if (!touched && shownDays()) host.params.days = String(shownDays());
      sync();
    });
    for (const [days, label] of options) {
      const b = h("button", { type: "button", "data-days": days }, label);
      b.addEventListener("click", () => {
        touched = true;
        host.params.days = days;
        sync();
        void host.refresh({ feed: "donki" });
      });
      wrap.append(b);
    }
    host.params.days = shownDays() ? String(shownDays()) : "30";
    sync();
    return wrap;
  },

  async load(signal, params, prev): Promise<PanelResult<SolarView>> {
    const { feed, days, sample } = params;
    const p = prev?.data;
    const wantDonki = !p || feed !== "goes";
    const wantGoes = !p || feed !== "donki";
    const donkiParams: Record<string, string> = {};
    if (days) donkiParams.days = days;
    if (sample) donkiParams.sample = sample;
    // Live updates fetch only the last 6 hours and merge them into the 24 h already shown.
    const recentGoes = p?.goes.data && p.goes.fetchedAt && Date.now() - Date.parse(p.goes.fetchedAt) < 5 * 3600_000;
    const [donki, goes] = await Promise.all([
      wantDonki ? runFeed(p?.donki, () => fetchSource("solar", donkiParams, signal)) : Promise.resolve(p!.donki),
      wantGoes ? runFeed(p?.goes, () => fetchSource("goes", { hours: recentGoes ? "6" : "24" }, signal), recentGoes ? mergeGoes : undefined) : Promise.resolve(p!.goes),
    ]);
    if (!donki.data && !goes.data && donki.error) {
      // Nothing to show at all: let the panel show its error state (with the dev sample action).
      throw new ApiError(donki.error.message, { source: "solar", fetchedAt: donki.error.at, error: { kind: (donki.error.kind as ErrorKind) ?? "upstream", message: donki.error.message, ...(donki.error.hint ? { hint: donki.error.hint } : {}) }, upstream: [...donki.upstream, ...goes.upstream] }, 502);
    }
    const stamps = [donki.fetchedAt, goes.fetchedAt].filter((x): x is string => !!x).sort();
    return {
      data: { donki, goes },
      fetchedAt: stamps[stamps.length - 1] ?? new Date().toISOString(),
      // Each feed's most recent calls (a feed not refetched this time keeps its last ones).
      upstream: [...donki.upstream, ...goes.upstream],
      notices: [...donki.notices],
    };
  },

  errorActions(err, ctx) {
    const kind = err.body?.error.kind;
    if (ctx.env === "development" && (kind === "timeout" || kind === "unreachable")) {
      return [{ label: "Preview with saved sample (9 Oct 2026)", params: { sample: "1" } }];
    }
    return [];
  },

  render(root, { data: view }, ctx) {
    const now = Date.now();
    const data = view.donki.data;
    const goes = view.goes.data;
    const stat = (label: string, value: Node | string, detail: string) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, value), h("div", { class: "stat-detail", title: detail }, detail));
    const cleanups: (() => void)[] = [];

    const headline = h("p", { class: "headline" });
    const fillHeadline = (g: GoesData | null) => {
      const a = data ? assess(data, now) : null;
      const lp = g ? latestPoint(g) : null;
      const flareNow = g?.latestFlare && !g.latestFlare.end ? g.latestFlare : null;
      const r = lp ? rScale(lp[1]) : 0;
      const level = LEVELS[Math.max(a?.level.rank ?? 0, Math.min(3, r >= 3 ? 3 : r))]!;
      const parts: string[] = [];
      if (flareNow) parts.push(`Flare in progress: ${flareNow.currentClass ?? "rising"} since ${utc(flareNow.begin).replace(" UTC", "")} UTC.`);
      if (a) parts.push(a.text);
      else if (lp) parts.push(`X-ray level ${xrayClass(lp[1])}; flare, CME and storm catalogue unavailable right now.`);
      headline.replaceChildren(h("span", { class: "status-tag", style: `--tag:${level.color}` }, level.label), h("span", null, parts.join(" ")));
    };
    fillHeadline(goes);
    root.append(headline);

    let xray: ReturnType<typeof xrayBlock> | null = null;
    const hours = { value: 24 };
    const goesSlot = h("div", { class: "xray-slot" });
    const fillGoes = (f: Feed<GoesData>) => {
      if (f.data) {
        if (xray) xray.redraw(f.data, goesStale(f));
        else {
          xray = xrayBlock(f.data, goesStale(f), hours);
          goesSlot.replaceChildren(xray.el);
        }
      } else if (f.error) {
        const retry = h("button", { class: "btn", type: "button" }, icon(ICONS.refresh), "Try again");
        retry.addEventListener("click", () => ctx.refresh({ feed: "goes" }));
        goesSlot.replaceChildren(errorInline("Couldn’t load the live X-ray flux.", f, [retry]));
      }
    };
    fillGoes(view.goes);
    cleanups.push(() => xray?.destroy());

    if (data) {
      const strongest = data.flares.reduce<Flare | null>((m, f) => (!m || f.flux > m.flux ? f : m), null);
      const mx = data.flares.filter((f) => f.flux >= 1e-5).length;
      const maxKp = Math.max(0, ...data.storms.map((s) => s.maxKp));
      const earthCmes = data.cmes.filter((c) => c.earth?.arrival).sort((x, y) => x.earth!.arrival!.localeCompare(y.earth!.arrival!));
      const nextArrival = earthCmes.find((c) => new Date(c.earth!.arrival!).getTime() > now);
      root.append(
        h(
          "div",
          { class: "stats" },
          stat(`Strongest flare · ${data.days} d`, strongest ? strongest.classType : "—", strongest ? `${utc(strongest.peak)}${strongest.region ? ` · AR ${strongest.region}` : ""}` : "no flares"),
          stat("M- and X-class flares", String(mx), "R1 radio blackout or stronger"),
          stat("CMEs", String(data.cmes.length), `${data.cmes.filter((c) => c.earth).length} modelled to reach Earth`),
          stat("Max Kp", maxKp ? fmt.fixed(maxKp, 1) : "< 5", maxKp ? `${gLabel(maxKp)} storm` : "no storms catalogued"),
          stat("Next CME arrival", nextArrival ? relative(nextArrival.earth!.arrival!, now) : "none", nextArrival ? `${utc(nextArrival.earth!.arrival!)} · Kp ${nextArrival.earth!.kpMin ?? "?"}–${nextArrival.earth!.kpMax ?? "?"}` : "no Earth arrivals modelled"),
        ),
      );
    }
    root.append(goesSlot);

    if (data) {
      const earthCmes = data.cmes.filter((c) => c.earth?.arrival).sort((x, y) => x.earth!.arrival!.localeCompare(y.earth!.arrival!));
      const timeline = h("div", { class: "chart" });
      const helio = h("div", { class: "chart" });
      const donkiStale = view.donki.error
        ? h("p", { class: "footnote xray-stale" }, `Latest DONKI update failed (${utc(view.donki.error.at)}): ${view.donki.error.message} Showing events from ${view.donki.fetchedAt ? utc(view.donki.fetchedAt) : "earlier"}.`)
        : null;
      root.append(
        donkiStale ?? "",
        h(
          "div",
          { class: "solar-layout" },
          h(
            "div",
            { class: "chart-block" },
            h("div", { class: "chart-head" }, h("h3", null, "Activity timeline"), h("p", null, "Shaded area: modelled arrivals ahead")),
            timeline,
            h(
              "ul",
              { class: "legend" },
              h("li", null, h("span", { class: "swatch", style: "--c:var(--other)" }), "Below R1 / G1"),
              h("li", null, h("span", { class: "swatch", style: "--c:var(--warning)" }), "R1 · G1 (minor)"),
              h("li", null, h("span", { class: "swatch", style: "--c:var(--serious)" }), "R2 · G2 (moderate)"),
              h("li", null, h("span", { class: "swatch", style: "--c:var(--critical)" }), "R3+ · G3+ (strong)"),
              h("li", null, h("span", { class: "swatch", style: "--c:var(--series-3)" }), "CME modelled to reach Earth (◆ = predicted arrival, bar = Kp range)"),
              h("li", null, h("span", { class: "swatch", style: "--c:var(--series-1)" }), "Other CME"),
              h("li", null, h("span", { class: "swatch", style: "--c:var(--other)" }), "CME, direction unknown"),
            ),
          ),
          h(
            "div",
            { class: "solar-side" },
            h(
              "div",
              { class: "chart-block" },
              h("div", { class: "chart-head" }, h("h3", null, "CMEs in transit now")),
              helio,
              h("p", { class: "footnote" }, "Seen from above the Sun’s north pole; Earth fixed at right. Fronts are extrapolated at constant speed from the catalogued analysis, so treat positions as rough."),
            ),
          ),
        ),
        h("div", { class: "solar-lists" }, ...sideLists(data, now, earthCmes)),
      );
      cleanups.push(
        onResize(timeline, (w) => drawTimeline(timeline, data, w)),
        onResize(helio, (w) => drawHeliosphere(helio, data, w)),
      );
    } else {
      const actions: HTMLElement[] = [];
      const retry = h("button", { class: "btn", type: "button" }, icon(ICONS.refresh), "Try again");
      retry.addEventListener("click", () => ctx.refresh({ feed: "donki" }));
      actions.push(retry);
      const kind = view.donki.error?.kind;
      if (ctx.env === "development" && (kind === "timeout" || kind === "unreachable")) {
        const sampleBtn = h("button", { class: "btn", type: "button" }, "Preview with saved sample (9 Oct 2026)");
        sampleBtn.addEventListener("click", () => ctx.refresh({ feed: "donki", sample: "1" }));
        actions.push(sampleBtn);
      }
      root.append(errorInline("Couldn’t load flares, CMEs and storms (NASA DONKI).", view.donki, actions));
    }
    root.append(
      h("p", { class: "footnote" }, "Flare classes: GOES 1–8 Å (0.1–0.8 nm) peak flux (A < B < C < M < X, each 10× stronger). R = NOAA radio-blackout scale; G = geomagnetic-storm scale (Kp 5 = G1 … Kp 9 = G5). CME arrivals and Kp ranges come from WSA-ENLIL model runs. Live X-ray data: NOAA SWPC, primary GOES satellite; around the equinoxes the satellite passes through Earth’s shadow once a day, so the flux drops to zero and shows as a data gap."),
    );

    let shownDonki = view.donki;
    return {
      destroy: () => cleanups.forEach((f) => f()),
      update(result) {
        // Only the GOES feed changed (live mode): redraw the X-ray block and the headline in place.
        if (result.data.donki !== shownDonki && JSON.stringify(result.data.donki) !== JSON.stringify(shownDonki)) return false;
        if (!xray && result.data.goes.data) return false;
        shownDonki = result.data.donki;
        fillGoes(result.data.goes);
        fillHeadline(result.data.goes.data);
        return true;
      },
    };
  },

  summarize({ data: view }) {
    const now = Date.now();
    const data = view.donki.data;
    const lp = view.goes.data ? latestPoint(view.goes.data) : null;
    const xr = lp ? `X-ray ${xrayClass(lp[1])} now` : null;
    if (!data) return xr ? { label: "Sun & space weather", icon: ICONS.flare, value: xr, detail: "flare/CME catalogue unavailable" } : null;
    const a = assess(data, now);
    const top = data.flares.reduce<Flare | null>((m, f) => (!m || f.flux > m.flux ? f : m), null);
    const next = a.upcoming[0];
    return {
      label: "Sun & space weather",
      icon: ICONS.flare,
      value: `${a.level.label}${xr ? ` · ${xr.replace(" now", "")}` : top ? ` · ${top.classType} max` : ""}`,
      detail: next
        ? `CME due ${relative(next.earth!.arrival!, now)}${next.earth!.kpMax !== null ? ` · Kp ${next.earth!.kpMin}–${next.earth!.kpMax}` : ""}`
        : `${data.cmes.length} CMEs, ${data.flares.length} flares in ${data.days} d${top ? ` · max ${top.classType}` : ""}`,
    };
  },
};
