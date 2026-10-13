import type { GcnData, GcnEvent, GcnEventType } from "../../shared/contract";
import { formatDec, formatRa, smallCircle, sunPosition } from "../../shared/astro";
import { fetchSource } from "../core/api";
import { h, icon, onResize, s, safeUrl } from "../core/dom";
import { fmt, relative, utc, utcDate } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelHost, PanelResult } from "../core/panel";
import { openReader } from "../core/reader";
import { hoverLayer, placeLabels, svgRoot, type HoverPoint, type LabelCandidate } from "../viz/chart";
import { skyBase, skyFrame, sunGlyph } from "../viz/sky";

const TYPES: Record<GcnEventType, { label: string; plural: string; color: string }> = {
  grb: { label: "Gamma-ray burst", plural: "Gamma-ray bursts", color: "var(--series-1)" },
  neutrino: { label: "High-energy neutrino", plural: "Neutrino alerts", color: "var(--series-3)" },
  gw: { label: "Gravitational waves", plural: "GW candidates", color: "var(--series-7)" },
};

type Filter = "all" | GcnEventType;

/** 0.00075° → "2.7″", 0.05° → "3.0′", 4.2° → "4.2°". */
export function errText(deg: number | null): string {
  if (deg === null) return "error not stated";
  if (deg < 1 / 60) return `${fmt.sig(deg * 3600, 2)}″`;
  if (deg < 1) return `${fmt.sig(deg * 60, 2)}′`;
  return `${fmt.sig(deg, 2)}°`;
}

const when = (e: GcnEvent) => (e.triggerTime ? utc(e.triggerTime) : `${utcDate(e.date)} (time n/a)`);
const whenMs = (e: GcnEvent) => Date.parse(e.triggerTime ?? `${e.date}T12:00:00Z`);

function positionText(e: GcnEvent): string {
  if (e.type === "gw") {
    const g = e.gw;
    return g?.areaDeg2 ? `sky map, 90% area ${fmt.int(g.areaDeg2)} deg²` : "sky map (area not stated)";
  }
  return e.position ? `${errText(e.position.errDeg)} · ${e.position.from}` : "no position read yet";
}

function readEvent(e: GcnEvent, circularId?: number) {
  const items = e.circulars.map((c) => ({ id: c.id, subject: c.subject }));
  const idx = circularId ? Math.max(0, items.findIndex((c) => c.id === circularId)) : 0;
  openReader(e.name, items, idx);
}

function tipFor(e: GcnEvent) {
  const rows: [string, string][] = [["Time", when(e)]];
  if (e.position) {
    rows.push(["RA, Dec", `${formatRa(e.position.ra)}, ${formatDec(e.position.dec)}`]);
    rows.push(["Error (90%)", errText(e.position.errDeg)]);
    rows.push(["From", `${e.position.from} · GCN ${e.position.circularId}`]);
  }
  rows.push(["Circulars", String(e.circulars.length)]);
  return { title: `${e.name} · ${TYPES[e.type].label}`, rows, note: "Click to read the circulars." };
}

function drawMap(el: HTMLElement, events: GcnEvent[], width: number, selected: string | null, onPick: (e: GcnEvent) => void) {
  const f = skyFrame(width, 4);
  const svg = svgRoot(width, f.height, "All-sky map (equatorial coordinates) of recent gamma-ray bursts and neutrino alerts with their error regions");
  svg.append(skyBase(f));
  const [sra, sdec] = sunPosition(Date.now());
  svg.append(sunGlyph(f, sra, sdec));
  const points: HoverPoint[] = [];
  const labels: LabelCandidate[] = [];
  // Big error regions first so precise positions stay on top.
  const placed = events.filter((e) => e.position).sort((a, b) => (b.position!.errDeg ?? 0) - (a.position!.errDeg ?? 0));
  for (const e of placed) {
    const p = e.position!;
    const color = TYPES[e.type].color;
    const [x, y] = f.project(p.ra, p.dec);
    const hot = e.name === selected;
    const g = s("g");
    const err = p.errDeg ?? 0;
    // Draw the error region when it's visible at this scale (> ~1.5 px).
    const pxPerDeg = f.width / 360;
    if (err * pxPerDeg > 1.5) {
      const ring = f.polyline(smallCircle(p.ra, p.dec, Math.min(err, 60), 96), true);
      g.append(s("path", { d: ring.d, fill: ring.wraps ? "none" : color, "fill-opacity": hot ? 0.22 : 0.1, stroke: color, "stroke-width": hot ? 2 : 1.25, "stroke-opacity": 0.9 }));
    }
    const dot = s("circle", { cx: x, cy: y, r: hot ? 5.5 : 4, fill: color, stroke: "var(--panel)", "stroke-width": 1.5 });
    g.append(dot);
    svg.append(g);
    points.push({ x, y, tip: tipFor(e), mark: dot, onSelect: () => onPick(e) });
  }
  // Label the newest few (and the selected one).
  const newest = [...placed].sort((a, b) => whenMs(b) - whenMs(a)).slice(0, width < 520 ? 2 : 4);
  for (const e of new Set([...placed.filter((x) => x.name === selected), ...newest])) {
    const [x, y] = f.project(e.position!.ra, e.position!.dec);
    const right = x < width - 110;
    labels.push({ x: right ? x + 8 : x - 8, y: y - 6, text: e.name, anchor: right ? "start" : "end" });
  }
  const lg = s("g");
  placeLabels(lg, labels);
  svg.append(lg);
  if (!placed.length) {
    svg.append(s("text", { class: "ref-label", x: width / 2, y: f.height / 2 + 30, "text-anchor": "middle" }, "No positions in this selection"));
  }
  hoverLayer(svg, points, { x: 0, y: 0, w: width, h: f.height }, 22);
  el.replaceChildren(svg);
}

function eventItem(e: GcnEvent, now: number, selected: boolean, onPick: (e: GcnEvent) => void): HTMLElement {
  const t = TYPES[e.type];
  const latest = e.circulars[0];
  const read = h("button", { class: "btn btn-small", type: "button" }, icon(ICONS.doc), e.circulars.length > 1 ? `Read ${e.circulars.length} circulars` : "Read circular");
  read.addEventListener("click", () => readEvent(e));
  const extra: HTMLElement[] = [];
  if (e.type === "gw" && e.gw) {
    extra.push(h("a", { class: "btn btn-small btn-quiet", href: safeUrl(e.gw.skymapUrl) ?? "#", target: "_blank", rel: "noopener" }, "Sky map on GraceDB", icon(ICONS.external)));
  }
  const list = h(
    "ol",
    { class: "circ-list" },
    e.circulars.map((c) => {
      const b = h("button", { type: "button", class: "linklike" }, c.subject);
      b.addEventListener("click", () => readEvent(e, c.id));
      return h("li", null, h("span", { class: "mono" }, String(c.id)), b);
    }),
  );
  const li = h(
    "li",
    { class: `event${selected ? " is-selected" : ""}`, "data-event": e.name },
    h(
      "div",
      { class: "event-head" },
      h("span", { class: "status-tag", style: `--tag:${t.color}` }, h("button", { type: "button", class: "linklike event-name" }, e.name)),
      h("span", { class: "event-when", title: e.triggerTime ?? e.date }, `${when(e)} · ${relative(e.triggerTime ?? `${e.date}T12:00:00Z`, now)}`),
    ),
    h(
      "div",
      { class: "event-sub" },
      `${t.label}${e.aliases.length ? ` · also ${e.aliases.join(", ")}` : ""} · `,
      positionText(e),
      e.gw?.classification ? ` · ${e.gw.classification}` : "",
    ),
    latest ? h("div", { class: "event-latest", title: latest.subject }, `Latest: ${latest.subject}`) : null,
    h("div", { class: "event-actions" }, read, ...extra),
    e.circulars.length > 1 ? h("details", { class: "event-circs" }, h("summary", null, `All ${e.circulars.length} circulars`), list) : null,
  );
  li.querySelector(".event-name")!.addEventListener("click", () => onPick(e));
  return li;
}

function table(events: GcnEvent[]): HTMLElement {
  return h(
    "details",
    { class: "table-toggle" },
    h("summary", null, "Show all events as a table"),
    h(
      "div",
      { class: "data-table-wrap" },
      h(
        "table",
        { class: "data-table" },
        h("thead", null, h("tr", null, ["Event", "Type", "Time (UTC)", "RA", "Dec", "Error", "Position from", "Circulars"].map((c, i) => h("th", i >= 5 && i !== 6 ? { class: "num" } : null, c)))),
        h(
          "tbody",
          null,
          events.map((e) =>
            h(
              "tr",
              null,
              h("td", null, e.name),
              h("td", null, TYPES[e.type].label),
              h("td", null, when(e)),
              h("td", { class: "num" }, e.position ? formatRa(e.position.ra) : "—"),
              h("td", { class: "num" }, e.position ? formatDec(e.position.dec) : "—"),
              h("td", { class: "num" }, e.position ? errText(e.position.errDeg) : e.gw?.areaDeg2 ? `${fmt.int(e.gw.areaDeg2)} deg²` : "—"),
              h("td", null, e.position ? `${e.position.from} (GCN ${e.position.circularId})` : e.type === "gw" ? "sky map" : "—"),
              h("td", { class: "num" }, String(e.circulars.length)),
            ),
          ),
        ),
      ),
    ),
  );
}

export const gcnPanel: PanelDefinition<GcnData> = {
  id: "gcn",
  title: "Cosmic explosions",
  subtitle: "Gamma-ray bursts, gravitational-wave candidates and high-energy neutrinos reported in NASA GCN Circulars",
  icon: ICONS.burst,
  span: "span-12",
  source: { name: "NASA GCN Circulars", url: "https://gcn.nasa.gov/circulars" },
  live: [{ label: "GCN circulars", everyMs: 10 * 60_000 }],

  controls(host: PanelHost<GcnData>) {
    const wrap = h("div", { class: "segmented", role: "group", "aria-label": "Time range" });
    const sync = () => wrap.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.days === (host.params.days ?? "7"))));
    for (const [d, label] of [["3", "3 d"], ["7", "7 d"], ["14", "14 d"]]) {
      const b = h("button", { type: "button", "data-days": d! }, label!);
      b.addEventListener("click", () => {
        host.params.days = d!;
        sync();
        void host.refresh();
      });
      wrap.append(b);
    }
    host.params.days = host.result ? String(host.result.data.days) : "7";
    host.onChange(() => {
      if (host.result && !host.busy) host.params.days = String(host.result.data.days);
      sync();
    });
    sync();
    return wrap;
  },

  async load(signal, params): Promise<PanelResult<GcnData>> {
    const env = await fetchSource("gcn", params.days ? { days: params.days } : {}, signal);
    return { data: env.data, fetchedAt: env.fetchedAt, upstream: env.upstream, notices: env.notices };
  },

  render(root, { data }) {
    const now = Date.now();
    const events = data.events;
    const count = (t: GcnEventType) => events.filter((e) => e.type === t).length;
    const precise = events.filter((e) => e.position?.errDeg !== null && e.position?.errDeg !== undefined).sort((a, b) => a.position!.errDeg! - b.position!.errDeg!)[0];
    const stat = (label: string, value: string, detail: string, color?: string) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label" }, color ? h("span", { class: "swatch", style: `--c:${color}` }) : null, label), h("div", { class: "stat-value" }, value), h("div", { class: "stat-detail", title: detail }, detail));

    root.append(
      h(
        "div",
        { class: "stats" },
        stat(`Events · ${data.days} d`, String(events.length), `from ${fmt.int(data.totalCirculars)} circulars`),
        stat(TYPES.grb.plural, String(count("grb")), "prompt γ-ray flashes", TYPES.grb.color),
        stat(TYPES.neutrino.plural, String(count("neutrino")), "IceCube / KM3NeT", TYPES.neutrino.color),
        stat(TYPES.gw.plural, String(count("gw")), count("gw") ? "LIGO / Virgo / KAGRA" : "none circulated in this window", TYPES.gw.color),
        stat("Sharpest position", precise ? errText(precise.position!.errDeg) : "—", precise ? `${precise.name} · ${precise.position!.from}` : "no positions yet"),
      ),
    );

    let filter: Filter = "all";
    let selected: string | null = null;
    const map = h("div", { class: "chart" });
    const list = h("ol", { class: "event-list", "aria-label": "Events" });
    const filters = h("div", { class: "segmented", role: "group", "aria-label": "Event type" });
    const visible = () => events.filter((e) => filter === "all" || e.type === filter);
    let width = 0;

    const pick = (e: GcnEvent) => {
      selected = e.name;
      redraw();
      const item = list.querySelector<HTMLElement>(`[data-event="${CSS.escape(e.name)}"]`);
      item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      readEvent(e, e.position?.circularId);
    };
    const redraw = () => {
      const v = visible();
      if (width) drawMap(map, v, width, selected, pick);
      list.replaceChildren(...(v.length ? v.map((e) => eventItem(e, now, e.name === selected, (x) => {
        selected = x.name;
        redraw();
      })) : [h("li", { class: "footnote" }, "No events of this type in the window.")]));
    };
    const opts: [Filter, string][] = [["all", `All ${events.length}`], ["grb", `GRB ${count("grb")}`], ["neutrino", `Neutrino ${count("neutrino")}`], ["gw", `GW ${count("gw")}`]];
    for (const [k, label] of opts) {
      const b = h("button", { type: "button", "aria-pressed": String(k === filter) }, label);
      b.addEventListener("click", () => {
        filter = k;
        filters.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        redraw();
      });
      filters.append(b);
    }

    const placed = events.filter((e) => e.position).length;
    root.append(
      h(
        "div",
        { class: "gcn-layout" },
        h(
          "div",
          { class: "chart-block" },
          h("div", { class: "chart-head" }, h("h3", null, "Where on the sky"), filters),
          map,
          h(
            "ul",
            { class: "legend" },
            h("li", null, h("span", { class: "swatch", style: `--c:${TYPES.grb.color}` }), "Gamma-ray burst"),
            h("li", null, h("span", { class: "swatch", style: `--c:${TYPES.neutrino.color}` }), "Neutrino"),
            h("li", null, h("span", { class: "swatch ring", style: `--c:var(--ink-3)` }), "90% error region (when larger than a dot)"),
            h("li", null, h("span", { class: "swatch line", style: "--c:var(--ink-3)" }), "Milky Way plane"),
          ),
          h("p", { class: "footnote" }, `${placed} of ${events.length} events placed. Equatorial coordinates (RA increases to the left). Gravitational-wave candidates are localized by probability sky maps covering hundreds of square degrees, so they are listed rather than drawn.`),
        ),
        h("div", { class: "chart-block" }, h("div", { class: "chart-head" }, h("h3", null, "Events, newest first"), h("p", null, "Click a name to highlight it on the map")), list),
      ),
      table(events),
      h(
        "p",
        { class: "footnote" },
        `Positions are read automatically from the circulars’ text: the smallest stated 90% error wins, and a position is only used if it agrees with the coarser ones. This refresh read ${data.bodiesRead} circular texts — at most 40 per refresh (the free plan’s request limit), most informative first, so with many events some may show “no position read yet”. Always check the circular before relying on a position.`,
      ),
    );
    const off = onResize(map, (w) => {
      width = w;
      redraw();
    });
    redraw();
    const shown = JSON.stringify(events);
    return {
      destroy: off,
      // Live mode: nothing new → keep the view (open lists, selection) as it is.
      update: (result) => JSON.stringify(result.data.events) === shown && result.data.days === data.days,
    };
  },

  summarize({ data }) {
    const e = data.events[0];
    return {
      label: "Cosmic explosions",
      icon: ICONS.burst,
      value: `${data.events.length} event${data.events.length === 1 ? "" : "s"} · ${data.days} d`,
      detail: e ? `latest ${e.name} · ${relative(e.triggerTime ?? `${e.date}T12:00:00Z`)}` : "no events in this window",
    };
  },
};
