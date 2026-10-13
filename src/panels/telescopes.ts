import { scaleUtc } from "d3-scale";
import type { ScheduledObservation, TelescopeData, TelescopeId, TelescopeSchedule } from "../../shared/contract";
import { angularSeparation, formatDec, formatRa, sunPosition } from "../../shared/astro";
import { ApiError, fetchSource } from "../core/api";
import { h, icon, onResize, s, safeUrl } from "../core/dom";
import { fmt, relative, utc } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelResult } from "../core/panel";
import { cssVar } from "../core/theme";
import { hoverLayer, placeLabels, svgRoot, timeAxis, type HoverPoint, type LabelCandidate } from "../viz/chart";
import { hideTip, showTip } from "../viz/tooltip";
import { shadeZone, skyBase, skyFrame, sunGlyph } from "../viz/sky";

const SCOPES: Record<TelescopeId, { name: string; color: string; programUrl: (p: string) => string; scheduleUrl: string }> = {
  JWST: {
    name: "Webb",
    color: "var(--series-1)",
    programUrl: (p) => `https://www.stsci.edu/jwst-program-info/program/?program=${encodeURIComponent(p)}`,
    scheduleUrl: "https://www.stsci.edu/jwst/science-execution/observing-schedules",
  },
  HST: {
    name: "Hubble",
    color: "var(--series-3)",
    programUrl: (p) => `https://www.stsci.edu/hst-program-info/program/?program=${encodeURIComponent(p)}`,
    scheduleUrl: "https://www.stsci.edu/hst/observing/observing-status",
  },
};

const SOURCE_TEXT: Record<NonNullable<ScheduledObservation["posSource"]>, string> = {
  "mast-planned": "MAST (planned pointing)",
  mast: "MAST (earlier observation of this target)",
  name: "coordinates in the target name",
  sesame: "CDS Sesame name lookup",
};

const t0 = (o: ScheduledObservation) => Date.parse(o.start);
const t1 = (o: ScheduledObservation) => Date.parse(o.end);

export function aladinUrl(ra: number, dec: number): string {
  return `https://aladin.cds.unistra.fr/AladinLite/?target=${encodeURIComponent(`${ra.toFixed(5)} ${dec >= 0 ? "+" : ""}${dec.toFixed(5)}`)}&fov=0.25&survey=CDS%2FP%2FDSS2%2Fcolor`;
}

/** What is observing at `now`, and the next distinct targets. */
export function nowNext(obs: ScheduledObservation[], now: number) {
  const current = obs.find((o) => t0(o) <= now && now < t1(o)) ?? null;
  const next: ScheduledObservation[] = [];
  for (const o of obs) {
    if (t0(o) <= now || o === current) continue;
    if (next.some((n) => n.target === o.target) || o.target === current?.target) continue;
    next.push(o);
    if (next.length === 3) break;
  }
  const previous = current ? null : [...obs].reverse().find((o) => t1(o) <= now) ?? null;
  return { current, next, previous };
}

function obsTip(tel: TelescopeId, o: ScheduledObservation) {
  const rows: [string, string][] = [
    ["Telescope", SCOPES[tel].name],
    ["When", `${utc(o.start)} → ${utc(o.end).replace(/^\d+ \w+ /, "")}`],
    ["Instrument", o.instrument],
    ["Program", `${o.program}${o.pi ? ` · ${o.pi}` : ""}`],
  ];
  if (o.ra !== null && o.dec !== null) rows.push(["RA, Dec", `${formatRa(o.ra)}, ${formatDec(o.dec)}`]);
  return { title: o.target, rows, note: o.title ?? (o.category ? `${o.category}${o.keywords ? ` · ${o.keywords}` : ""}` : undefined) };
}

function positionLine(o: ScheduledObservation): Node[] {
  if (o.kind === "moving") return [document.createTextNode("Solar System target — it moves, so it isn’t placed on the map.")];
  if (o.ra === null || o.dec === null) return [document.createTextNode("Position not found (not in MAST, not resolvable by name).")];
  return [
    document.createTextNode(`${formatRa(o.ra)}, ${formatDec(o.dec)} · ${o.posApprox ? "approx., " : ""}${SOURCE_TEXT[o.posSource!]} · `),
    h("a", { href: aladinUrl(o.ra, o.dec), target: "_blank", rel: "noopener", title: "Open this position in Aladin Lite (CDS sky atlas)" }, "View sky in Aladin", icon(ICONS.external)),
  ];
}

function nowCard(sched: TelescopeSchedule, now: number): HTMLElement {
  const sc = SCOPES[sched.telescope];
  const head = h("div", { class: "scope-head" }, h("span", { class: "status-tag", style: `--tag:${sc.color}` }, sc.name));
  if (sched.error) {
    return h(
      "div",
      { class: "scope-card is-error", role: "alert" },
      head,
      h("p", { class: "scope-error-title" }, sched.error.kind === "format" ? "Schedule format not recognised" : sched.error.kind === "stale" ? "No current schedule published" : "Schedule unavailable"),
      h("p", { class: "scope-error" }, sched.error.message),
      h("a", { class: "btn btn-small", href: sc.scheduleUrl, target: "_blank", rel: "noopener" }, "Open STScI’s schedule page", icon(ICONS.external)),
    );
  }
  const { current, next, previous } = nowNext(sched.observations, now);
  const main = current
    ? [
        h("div", { class: "scope-kicker" }, current.kind === "calibration" ? "Observing now · calibration" : "Observing now"),
        h("div", { class: "scope-target" }, current.target),
        h("div", { class: "scope-meta" }, current.instrument),
        h(
          "div",
          { class: "scope-meta" },
          h("a", { href: safeUrl(sc.programUrl(current.program)) ?? "#", target: "_blank", rel: "noopener" }, `Program ${current.program}`),
          current.pi ? ` · PI ${current.pi}` : "",
          current.title ? ` · ${current.title}` : current.category ? ` · ${current.category}${current.keywords ? ` (${current.keywords})` : ""}` : "",
        ),
        h("div", { class: "scope-meta mono" }, `${utc(current.start)} → ${utc(current.end)} · ends ${relative(current.end, now)}`),
        h("div", { class: "scope-pos" }, ...positionLine(current)),
      ]
    : [
        h("div", { class: "scope-kicker" }, "Between targets"),
        h("div", { class: "scope-target muted" }, "No sky target scheduled right now"),
        h("div", { class: "scope-meta" }, previous ? `Last: ${previous.target}, ended ${relative(previous.end, now)}. Slewing, calibrating or idle until the next visit.` : "Slewing, calibrating or idle until the next visit."),
      ];
  return h(
    "div",
    { class: "scope-card" },
    head,
    ...main,
    next.length
      ? h(
          "div",
          { class: "scope-next" },
          h("div", { class: "stat-label" }, "Next up"),
          h(
            "ol",
            null,
            next.map((o) => h("li", null, h("span", { class: "mono" }, relative(o.start, now)), h("span", { class: "scope-next-target", title: `${o.target} · ${o.instrument}` }, o.target), h("span", { class: "scope-next-inst" }, o.instrument.split(",")[0]!))),
          ),
        )
      : h("p", { class: "footnote" }, "Nothing further in the published schedule."),
  );
}

function drawSkyMap(el: HTMLElement, data: TelescopeData, width: number, now: number) {
  const f = skyFrame(width, 4);
  const canvas = h("canvas", { "aria-hidden": "true" });
  canvas.style.cssText = `position:absolute;inset:0;width:${width}px;height:${f.height}px`;
  const [sra, sdec] = sunPosition(now);
  const paint = () => shadeZone(canvas, f, (ra, dec) => {
    const e = angularSeparation(ra, dec, sra, sdec);
    return e >= 85 && e <= 135;
  }, cssVar("--series-1-wash"), width < 520 ? 2 : 3);
  const svg = svgRoot(width, f.height, "All-sky map of Webb and Hubble targets for the coming days, with the Sun and Webb's allowed pointing zone");
  svg.style.position = "relative";
  const base = skyBase(f);
  // The canvas zone sits under a transparent copy of the outline fill.
  base.firstElementChild?.setAttribute("fill", "none");
  svg.append(base, sunGlyph(f, sra, sdec));

  const points: HoverPoint[] = [];
  const labels: LabelCandidate[] = [];
  const nowMarks: { x: number; y: number; text: string }[] = [];
  for (const sched of data.schedules) {
    const tel = sched.telescope;
    const color = SCOPES[tel].color;
    const { current } = nowNext(sched.observations, now);
    const seen = new Set<string>();
    const upcoming = sched.observations.filter((o) => o.ra !== null && t1(o) > now);
    for (const o of upcoming) {
      if (seen.has(o.target)) continue;
      seen.add(o.target);
      const [x, y] = f.project(o.ra!, o.dec!);
      const isNow = current?.target === o.target;
      const size = isNow ? 6 : 3.5;
      const mark =
        tel === "JWST"
          ? s("circle", { cx: x, cy: y, r: size, fill: color, stroke: "var(--panel)", "stroke-width": 1.5, opacity: o.kind === "calibration" ? 0.55 : 1 })
          : s("rect", { x: x - size, y: y - size, width: size * 2, height: size * 2, rx: 1, fill: color, stroke: "var(--panel)", "stroke-width": 1.5, opacity: o.kind === "calibration" ? 0.55 : 1 });
      svg.append(mark);
      if (isNow) {
        svg.append(s("circle", { cx: x, cy: y, r: size + 5, fill: "none", stroke: color, "stroke-width": 1.5 }));
        nowMarks.push({ x, y, text: `${SCOPES[tel].name} now: ${o.target}` });
      }
      points.push({ x, y, mark, tip: { ...obsTip(tel, o), note: `${isNow ? "Observing now. " : `Starts ${relative(o.start, now)}. `}Click to open this position in Aladin.` }, href: aladinUrl(o.ra!, o.dec!) });
    }
  }
  for (const m of nowMarks) {
    const right = m.x < width - 170;
    labels.push({ x: right ? m.x + 14 : m.x - 14, y: m.y + 4, text: m.text, anchor: right ? "start" : "end" });
  }
  const lg = s("g");
  placeLabels(lg, labels);
  svg.append(lg);
  hoverLayer(svg, points, { x: 0, y: 0, w: width, h: f.height }, 18);
  el.replaceChildren(h("div", { style: `position:relative;height:${f.height}px` }, canvas, svg));
  paint();
  const onTheme = () => paint();
  window.addEventListener("themechange", onTheme);
  return () => window.removeEventListener("themechange", onTheme);
}

function drawGantt(el: HTMLElement, data: TelescopeData, width: number, now: number) {
  const narrow = width < 560;
  const m = { left: narrow ? 58 : 70, right: 12, top: 20, bottom: 26 };
  const lane = 30, gap = 10;
  const scheds = data.schedules.filter((s2) => !s2.error);
  const height = m.top + Math.max(1, scheds.length) * (lane + gap) + m.bottom;
  const svg = svgRoot(width, height, "Timeline of scheduled Webb and Hubble observations");
  const g = s("g");
  svg.append(g);
  const start = Date.parse(data.windowStart);
  const end = Math.max(...scheds.map((x) => (x.coverageEnd ? Date.parse(x.coverageEnd) : 0)), now + 2 * 86_400_000);
  const x = scaleUtc().domain([new Date(start), new Date(Math.min(end, Date.parse(data.windowEnd)))]).range([m.left, width - m.right]);
  const blocks: { x0: number; x1: number; y0: number; y1: number; mark: SVGElement; tip: ReturnType<typeof obsTip>; href?: string }[] = [];
  scheds.forEach((sched, i) => {
    const y0 = m.top + i * (lane + gap);
    const sc = SCOPES[sched.telescope];
    g.append(s("text", { class: "axis-label", x: m.left - 8, y: y0 + lane / 2 + 4, "text-anchor": "end" }, sc.name));
    g.append(s("rect", { x: m.left, y: y0, width: width - m.left - m.right, height: lane, fill: "var(--panel-2)", rx: 2 }));
    if (sched.coverageEnd && Date.parse(sched.coverageEnd) < x.domain()[1]!.getTime()) {
      const cx = x(new Date(sched.coverageEnd));
      const room = width - m.right - cx;
      if (room > 112) g.append(s("text", { class: "ref-label", x: cx + 6, y: y0 + lane / 2 + 4 }, "not yet published"));
      else if (room > 24) g.append(s("text", { class: "ref-label", x: cx + 6, y: y0 + lane / 2 + 4 }, "…"));
    }
    for (const o of sched.observations) {
      const a = Math.max(m.left, x(new Date(t0(o))));
      const b = Math.min(width - m.right, x(new Date(t1(o))));
      if (b <= m.left || a >= width - m.right) continue;
      const w = Math.max(1.5, b - a - 1);
      const fill = o.kind === "calibration" ? "var(--other)" : sc.color;
      const r = s("rect", { x: a, y: y0 + 3, width: w, height: lane - 6, fill, rx: 1.5, opacity: o.kind === "moving" ? 0.6 : 1 });
      g.append(r);
      const label = o.target;
      if (w > label.length * 6.4 + 10) g.append(s("text", { class: "gantt-label", x: a + 5, y: y0 + lane / 2 + 4 }, label));
      blocks.push({ x0: a - 2, x1: a + w + 2, y0, y1: y0 + lane, mark: r, tip: obsTip(sched.telescope, o), href: o.ra !== null ? aladinUrl(o.ra, o.dec!) : undefined });
    }
  });
  const nx = Math.round(x(new Date(now))) + 0.5;
  g.append(s("line", { class: "now-line", x1: nx, x2: nx, y1: m.top - 6, y2: height - m.bottom }));
  g.append(s("text", { class: "ref-label", x: nx, y: m.top - 9, "text-anchor": "middle" }, "now"));
  timeAxis(g, x, height - m.bottom, m.top, Math.floor((width - m.left - m.right) / (narrow ? 60 : 80)));
  // Hover: the block under the pointer within its lane (blocks can be hours wide).
  const hit = s("rect", { class: "hit", x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom });
  svg.append(hit);
  let hot: (typeof blocks)[number] | null = null;
  const find = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const lx = ((ev.clientX - r.left) / r.width) * width, ly = ((ev.clientY - r.top) / r.height) * height;
    return blocks.find((b) => lx >= b.x0 && lx <= b.x1 && ly >= b.y0 && ly <= b.y1) ?? null;
  };
  hit.addEventListener("pointermove", (ev) => {
    const b = find(ev);
    hot?.mark.classList.remove("is-hot");
    hot = b;
    b?.mark.classList.add("is-hot");
    if (b) showTip(b.tip, ev.clientX, ev.clientY);
    else hideTip();
    hit.style.cursor = b?.href ? "pointer" : "default";
  });
  hit.addEventListener("pointerleave", () => {
    hot?.mark.classList.remove("is-hot");
    hot = null;
    hideTip();
  });
  hit.addEventListener("click", (ev) => {
    const b = find(ev);
    if (b?.href && ev.pointerType === "mouse") window.open(b.href, "_blank", "noopener");
  });
  el.replaceChildren(svg);
}

function table(data: TelescopeData): HTMLElement {
  const rows = data.schedules.flatMap((sc) => sc.observations.map((o) => ({ tel: sc.telescope, o }))).sort((a, b) => t0(a.o) - t0(b.o));
  return h(
    "details",
    { class: "table-toggle" },
    h("summary", null, `Show all ${rows.length} scheduled observations as a table`),
    h(
      "div",
      { class: "data-table-wrap" },
      h(
        "table",
        { class: "data-table" },
        h("thead", null, h("tr", null, ["Target", "Telescope", "Start (UTC)", "Duration", "Instrument", "Program", "RA", "Dec", "Position from"].map((c, i) => h("th", i === 3 || i === 6 || i === 7 ? { class: "num" } : null, c)))),
        h(
          "tbody",
          null,
          rows.map(({ tel, o }) =>
            h(
              "tr",
              null,
              h("td", null, o.target),
              h("td", null, SCOPES[tel].name),
              h("td", null, utc(o.start)),
              h("td", { class: "num" }, `${fmt.fixed((t1(o) - t0(o)) / 3600_000, 1)} h`),
              h("td", null, o.instrument),
              h("td", null, h("a", { href: safeUrl(SCOPES[tel].programUrl(o.program)) ?? "#", target: "_blank", rel: "noopener" }, o.program)),
              h("td", { class: "num" }, o.ra !== null ? formatRa(o.ra) : "—"),
              h("td", { class: "num" }, o.dec !== null ? formatDec(o.dec) : "—"),
              h("td", null, o.kind === "moving" ? "moves (Solar System)" : o.posSource ? `${o.posApprox ? "≈ " : ""}${SOURCE_TEXT[o.posSource]}` : "not found"),
            ),
          ),
        ),
      ),
    ),
  );
}

async function loadOne(tel: TelescopeId, signal: AbortSignal) {
  try {
    return { tel, env: await fetchSource("telescopes", { telescope: tel }, signal), err: null as ApiError | null };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return { tel, env: null, err: err instanceof ApiError ? err : new ApiError((err as Error).message, null, 0) };
  }
}

export const telescopePanel: PanelDefinition<TelescopeData> = {
  id: "telescopes",
  title: "Space telescopes",
  subtitle: "What Webb and Hubble are observing now and over the coming days, from STScI’s published schedules",
  icon: ICONS.telescope,
  span: "span-12",
  source: { name: "STScI observing schedules · MAST · CDS Sesame", url: "https://www.stsci.edu/jwst/science-execution/observing-schedules" },

  async load(signal): Promise<PanelResult<TelescopeData>> {
    // One request per telescope, in parallel: each stays light on Worker CPU and fails alone.
    const parts = await Promise.all((["JWST", "HST"] as const).map((t) => loadOne(t, signal)));
    const ok = parts.filter((p) => p.env);
    if (!ok.length) throw parts[0]!.err!;
    const schedules: TelescopeSchedule[] = parts.map((p) =>
      p.env
        ? p.env.data.schedules[0]!
        : { telescope: p.tel, error: { kind: "unreachable", message: p.err!.message }, files: [], coverageStart: null, coverageEnd: null, observations: [], internalCount: 0, positions: { found: 0, rejected: 0 } },
    );
    const first = ok[0]!.env!;
    return {
      data: { windowStart: first.data.windowStart, windowEnd: first.data.windowEnd, schedules },
      fetchedAt: ok.map((p) => p.env!.fetchedAt).sort().pop()!,
      upstream: parts.flatMap((p) => p.env?.upstream ?? p.err?.body?.upstream ?? []),
      notices: parts.flatMap((p) => p.env?.notices ?? []),
    };
  },

  render(root, { data }) {
    const cards = h("div", { class: "scope-cards" });
    const map = h("div", { class: "chart" });
    const gantt = h("div", { class: "chart" });
    let mapW = 0, ganttW = 0;
    let offTheme: (() => void) | null = null;
    const draw = () => {
      const now = Date.now();
      cards.replaceChildren(...data.schedules.map((sc) => nowCard(sc, now)));
      if (mapW) {
        offTheme?.();
        offTheme = drawSkyMap(map, data, mapW, now);
      }
      if (ganttW) drawGantt(gantt, data, ganttW, now);
    };
    const ok = data.schedules.filter((x) => !x.error);
    const found = ok.reduce((n, x) => n + x.positions.found, 0);
    const rejected = ok.reduce((n, x) => n + x.positions.rejected, 0);
    root.append(
      h(
        "div",
        { class: "scope-layout" },
        h(
          "div",
          { class: "chart-block" },
          h("div", { class: "chart-head" }, h("h3", null, "Targets in the coming days"), h("p", null, "Click a target to view that patch of sky in Aladin")),
          map,
          h(
            "ul",
            { class: "legend" },
            h("li", null, h("span", { class: "swatch", style: `--c:${SCOPES.JWST.color}` }), "Webb (circle)"),
            h("li", null, h("span", { class: "swatch square", style: `--c:${SCOPES.HST.color}` }), "Hubble (square)"),
            h("li", null, h("span", { class: "swatch ring", style: "--c:var(--ink-3)" }), "observing now"),
            h("li", null, h("span", { class: "swatch square", style: "--c:var(--series-1-wash);outline:1px solid var(--line-strong)" }), "where Webb can point today (85–135° from the Sun)"),
            h("li", null, h("span", { class: "swatch line", style: "--c:var(--ink-3)" }), "Milky Way plane"),
          ),
        ),
        cards,
      ),
      h("div", { class: "chart-block", style: "margin-top:18px" }, h("div", { class: "chart-head" }, h("h3", null, "Schedule"), h("p", null, "UTC · grey = calibration")), gantt),
      table(data),
      h(
        "p",
        { class: "footnote" },
        `Times are STScI’s plans: Webb runs an event-driven schedule and Hubble’s can change, so actual times may shift. Positions: ${found} found (MAST pointings first, then coordinates in target names, then CDS name lookups)${rejected ? `; ${rejected} rejected because they broke the telescope’s Sun-angle limits` : ""}. Internal calibrations without a sky target (${ok.reduce((n, x) => n + x.internalCount, 0)}) aren’t listed. Schedules used: `,
        ...ok.flatMap((sc) => sc.files.map((f, i) => [i || sc !== ok[0] ? ", " : "", h("a", { href: safeUrl(f.url) ?? "#", target: "_blank", rel: "noopener" }, `${SCOPES[sc.telescope].name} ${f.label.toLowerCase()}`)])),
        ".",
      ),
    );
    const offs = [
      onResize(map, (w) => {
        mapW = w;
        draw();
      }),
      onResize(gantt, (w) => {
        ganttW = w;
        draw();
      }),
    ];
    draw();
    // "Now" moves on by itself: redraw once a minute (no network).
    const tick = window.setInterval(draw, 60_000);
    return () => {
      window.clearInterval(tick);
      offTheme?.();
      offs.forEach((f) => f());
    };
  },

  summarize({ data }) {
    const now = Date.now();
    const part = (tel: TelescopeId) => {
      const sc = data.schedules.find((x) => x.telescope === tel);
      if (!sc || sc.error) return null;
      return nowNext(sc.observations, now).current?.target ?? "between targets";
    };
    const jw = part("JWST"), hs = part("HST");
    if (!jw && !hs) return { label: "Webb & Hubble now", icon: ICONS.telescope, value: "schedules unavailable", detail: "see the panel for details" };
    return { label: "Webb & Hubble now", icon: ICONS.telescope, value: jw ? `Webb: ${jw}` : `Hubble: ${hs}`, detail: jw && hs ? `Hubble: ${hs}` : jw ? "Hubble schedule unavailable" : "Webb schedule unavailable" };
  },
};
