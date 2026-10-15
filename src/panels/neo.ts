import { scaleLog, scaleSqrt, scaleUtc } from "d3-scale";
import type { CloseApproach, NeoData } from "../../shared/contract";
import { fetchSource } from "../core/api";
import { h, icon, onResize, s, safeUrl } from "../core/dom";
import { fmt, metres, relative, sizeAnalogy, utc } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelResult } from "../core/panel";
import { hoverLayer, placeLabels, svgRoot, timeAxis, yAxis, type HoverPoint } from "../viz/chart";
import { hideTip, showTipAt } from "../viz/tooltip";

const GEO_LD = 42_164 / 384_400; // geostationary orbit radius in lunar distances

/** Best single size estimate in km: measured diameter, else geometric mean of the H-based range. */
function sizeKm(a: CloseApproach): number | null {
  if (a.diameterKm) return a.diameterKm;
  if (a.estDiameterKm) return Math.sqrt(a.estDiameterKm.min * a.estDiameterKm.max);
  return null;
}

function sizeText(a: CloseApproach): string {
  if (a.diameterKm) return `${metres(a.diameterKm)} (measured)`;
  if (a.estDiameterKm) return `${metres(a.estDiameterKm.min)}–${metres(a.estDiameterKm.max)}`;
  return "unknown";
}

function tip(a: CloseApproach, now: number) {
  const km = sizeKm(a);
  return {
    title: a.name.replace(/^\((.*)\)$/, "$1"),
    rows: [
      ["Closest", `${utc(a.time)} (${relative(a.time, now)})`],
      ["Distance", `${fmt.fixed(a.distLd, 2)} LD · ${fmt.int(a.distKm)} km`],
      ["Speed", `${fmt.fixed(a.vRelKms, 1)} km/s`],
      ["Size", `${sizeText(a)}${km ? ` · ${sizeAnalogy(km * 1000)}` : ""}`],
      ["Time ±", a.timeSigma || "—"],
    ] as [string, string][],
    note: a.pha ? "Potentially hazardous asteroid (orbit can come within 0.05 au and H ≤ 22). Not a threat on this pass." : undefined,
  };
}

function drawChart(el: HTMLElement, data: NeoData, width: number) {
  const now = Date.now();
  const narrow = width < 520;
  const height = Math.round(Math.min(380, Math.max(260, width * 0.48)));
  const m = { top: 24, right: narrow ? 12 : 20, bottom: 30, left: 50 };
  const svg = svgRoot(width, height, "Asteroid close approaches: time versus distance from Earth");
  const g = s("g");
  svg.append(g);

  // Inner padding = the largest dot radius, so no dot is clipped at the top or
  // spills over the axis labels at the left/right edges.
  const r = scaleSqrt().domain([5, 600]).range([3.5, 12]).clamp(true);
  const pad = 13;
  const x = scaleUtc().domain([new Date(data.windowStart), new Date(data.windowEnd)]).range([m.left + pad, width - m.right - pad]);
  const minD = Math.min(...data.approaches.map((a) => a.distLd), 1);
  const y = scaleLog()
    .domain([Math.min(0.1, minD * 0.7), 20])
    .range([height - m.bottom - pad, m.top + pad]);

  timeAxis(g, x, height - m.bottom, m.top, Math.floor((width - m.left - m.right) / (narrow ? 70 : 90)));
  const ticks = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20].filter((t) => t >= y.domain()[0]! && t <= 20);
  const yLabels = yAxis(g, y, ticks, (v) => `${v} LD`, m.left, width - m.right);

  // Reference distances (labels are lifted above the dots further down).
  const overlay: SVGElement[] = [yLabels];
  const refs: [number, string][] = [[1, "Moon’s distance"]];
  if (y.domain()[0]! < GEO_LD) refs.push([GEO_LD, "Geostationary satellites"]);
  for (const [v, label] of refs) {
    const py = Math.round(y(v)) + 0.5;
    g.append(s("line", { class: "ref-line", x1: m.left, x2: width - m.right, y1: py, y2: py }));
    overlay.push(s("text", { class: "ref-label halo", x: width - m.right - 4, y: py - 5, "text-anchor": "end" }, label));
  }

  // "Now" marker; its label sits above the plot area, clear of the data.
  const nx = Math.round(x(new Date(now))) + 0.5;
  g.append(s("line", { class: "now-line", x1: nx, x2: nx, y1: m.top - 4, y2: height - m.bottom }));
  overlay.push(s("text", { class: "ref-label halo", x: nx, y: m.top - 9, "text-anchor": "middle" }, "now"));

  // Marks: largest first so small ones stay on top.
  const sorted = [...data.approaches].sort((a, b) => (sizeKm(b) ?? 0) - (sizeKm(a) ?? 0));
  const points: HoverPoint[] = [];
  const marks = s("g");
  for (const a of sorted) {
    const t = new Date(a.time).getTime();
    const cx = x(new Date(t));
    const cy = y(a.distLd);
    const past = t < now;
    const color = a.pha ? "var(--series-2)" : "var(--series-1)";
    const c = s("circle", {
      "data-des": a.des,
      cx, cy, r: r((sizeKm(a) ?? 0.01) * 1000),
      fill: color, "fill-opacity": past ? 0.3 : 0.9,
      stroke: "var(--panel)", "stroke-width": 2,
    });
    marks.append(c);
    points.push({ x: cx, y: cy, tip: tip(a, now), mark: c, href: a.sbdbUrl });
  }
  g.append(marks);
  // Axis, reference and "now" labels go on top of the dots so they always stay readable.
  g.append(...overlay);

  // Direct labels: the three closest upcoming approaches only.
  const upcoming = data.approaches.filter((a) => new Date(a.time).getTime() >= now).sort((a, b) => a.distLd - b.distLd).slice(0, narrow ? 2 : 4);
  placeLabels(
    g,
    upcoming.map((a) => {
      const cx = x(new Date(a.time));
      const right = cx < width - 150;
      return { x: cx + (right ? 10 : -10), y: y(a.distLd) + 4, text: a.name.replace(/^\((.*)\)$/, "$1"), anchor: right ? "start" : "end" };
    }),
  );

  hoverLayer(svg, points, { x: m.left, y: m.top, w: width - m.left - m.right, h: height - m.top - m.bottom });
  el.replaceChildren(svg);
}

/** Ask the 3D Solar System panel to show an object; it sets `found` if it could. */
function showIn3d(des: string, status: HTMLElement) {
  const detail = { des, found: false };
  window.dispatchEvent(new CustomEvent("astro:show-in-3d", { detail }));
  status.textContent = detail.found ? "" : "The 3D Solar System has no orbit for this object yet — refresh that panel first.";
}

function closestList(data: NeoData, now: number, status: HTMLElement): HTMLElement {
  const upcoming = data.approaches.filter((a) => new Date(a.time).getTime() >= now).sort((a, b) => a.distLd - b.distLd).slice(0, 6);
  if (!upcoming.length) return h("p", { class: "footnote" }, "No upcoming approaches within 0.05 au in this window.");
  return h(
    "ol",
    { class: "rank-list" },
    upcoming.map((a) => {
      const km = sizeKm(a);
      const name = a.name.replace(/^\((.*)\)$/, "$1");
      const in3d = h("button", { type: "button", class: "btn btn-icon btn-quiet btn-3d", title: `Show ${name} in the 3D Solar System`, "aria-label": `Show ${name} in the 3D Solar System` }, icon(ICONS.orbit));
      in3d.addEventListener("click", () => showIn3d(a.des, status));
      return h(
        "li",
        null,
        h("span", { class: "name" }, h("a", { href: safeUrl(a.sbdbUrl) ?? "#", target: "_blank", rel: "noopener" }, name),
          a.pha ? h("span", { class: "status-tag", style: "--tag:var(--series-2);margin-left:8px" }, "PHA") : null, in3d),
        h("span", { class: "sub" }, `${relative(a.time, now)} · ${utc(a.time)}${km ? ` · ${sizeAnalogy(km * 1000)}` : ""}`),
        h("span", { class: "value" }, `${fmt.fixed(a.distLd, 2)} LD`, h("small", null, `${fmt.compact(a.distKm)} km`)),
      );
    }),
  );
}

function table(data: NeoData): HTMLElement {
  const rows = data.approaches.map((a) =>
    h(
      "tr",
      null,
      h("td", null, a.name.replace(/^\((.*)\)$/, "$1")),
      h("td", null, utc(a.time)),
      h("td", { class: "num" }, fmt.fixed(a.distLd, 2)),
      h("td", { class: "num" }, fmt.int(a.distKm)),
      h("td", { class: "num" }, fmt.fixed(a.vRelKms, 1)),
      h("td", { class: "num" }, a.h === null ? "—" : fmt.fixed(a.h, 1)),
      h("td", null, sizeText(a)),
      h("td", null, a.pha ? "Yes" : ""),
    ),
  );
  return h(
    "details",
    { class: "table-toggle" },
    h("summary", null, `Show all ${data.approaches.length} approaches as a table`),
    h(
      "div",
      { class: "data-table-wrap" },
      h(
        "table",
        { class: "data-table" },
        h("thead", null, h("tr", null, ["Object", "Closest approach", "LD", "km", "km/s", "H", "Size", "PHA"].map((t, i) => h("th", i >= 2 && i <= 5 ? { class: "num", scope: "col" } : { scope: "col" }, t)))),
        h("tbody", null, rows),
      ),
    ),
  );
}

export const neoPanel: PanelDefinition<NeoData> = {
  id: "neo",
  title: "Asteroid close approaches",
  subtitle: "Near-Earth objects passing within 0.05 au (19.5 lunar distances), past week to two months ahead",
  icon: ICONS.asteroid,
  span: "span-7",
  source: { name: "JPL SSD/CNEOS Close Approach Data API", url: "https://ssd-api.jpl.nasa.gov/doc/cad.html" },

  async load(signal): Promise<PanelResult<NeoData>> {
    const env = await fetchSource("neo", {}, signal);
    return { data: env.data, fetchedAt: env.fetchedAt, upstream: env.upstream, notices: env.notices };
  },

  render(root, { data }) {
    const now = Date.now();
    const future = data.approaches.filter((a) => new Date(a.time).getTime() >= now);
    const next30 = future.filter((a) => new Date(a.time).getTime() < now + 30 * 86_400_000);
    const closest = [...future].sort((a, b) => a.distLd - b.distLd)[0];
    const fastest = [...future].sort((a, b) => b.vRelKms - a.vRelKms)[0];
    const largest = [...future].sort((a, b) => (sizeKm(b) ?? 0) - (sizeKm(a) ?? 0))[0];
    const phas = data.approaches.filter((a) => a.pha);
    const nm = (a: CloseApproach) => a.name.replace(/^\((.*)\)$/, "$1");

    const stat = (label: string, value: Node | string, detail: string) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, value), h("div", { class: "stat-detail", title: detail }, detail));

    root.append(
      h(
        "div",
        { class: "stats" },
        stat("Next 30 days", String(next30.length), "approaches within 0.05 au"),
        closest ? stat("Closest upcoming", `${fmt.fixed(closest.distLd, 2)} LD`, `${nm(closest)} · ${relative(closest.time, now)}`) : null,
        fastest ? stat("Fastest upcoming", `${fmt.fixed(fastest.vRelKms, 1)} km/s`, nm(fastest)) : null,
        largest && sizeKm(largest) ? stat("Largest upcoming", `~${metres(sizeKm(largest)!)}`, `${nm(largest)} · ${sizeAnalogy(sizeKm(largest)! * 1000)}`) : null,
        stat("Potentially hazardous", String(phas.length), phas.length ? phas.map(nm).join(", ") : "none in this window"),
      ),
    );

    const chart = h("div", { class: "chart" });
    const linkStatus = h("p", { class: "footnote", role: "status" });
    root.append(
      h(
        "div",
        { class: "neo-layout" },
        h(
          "div",
          { class: "chart-block" },
          h("div", { class: "chart-head" }, h("h3", null, "When and how close"), h("p", null, "Lower = closer to Earth · dot size ≈ diameter · hover for details")),
          chart,
          h(
            "ul",
            { class: "legend" },
            h("li", null, h("span", { class: "swatch", style: "--c:var(--series-1)" }), "Asteroid"),
            h("li", null, h("span", { class: "swatch", style: "--c:var(--series-2)" }), "Potentially hazardous (PHA)"),
            h("li", null, h("span", { class: "swatch", style: "--c:var(--series-1);opacity:.35" }), "Already passed"),
          ),
        ),
        h("div", null, h("h3", { class: "section-title" }, "Closest upcoming"), closestList(data, now, linkStatus), linkStatus),
      ),
      table(data),
      h("p", { class: "footnote" }, "Sizes are estimated from brightness (absolute magnitude H) for albedos 0.05–0.25 unless measured. 1 LD = 384,400 km. Times are TDB (within ~70 s of UTC)."),
    );

    if (!data.approaches.length) {
      chart.append(h("p", { class: "footnote" }, "No close approaches in this window."));
      return;
    }
    // The 3D Solar System's "Show in close-approach chart": scroll here and point at the dot.
    let linkTimer = 0;
    const onShowInNeo = (ev: Event) => {
      const detail = (ev as CustomEvent<{ des: string; found: boolean }>).detail;
      const a = data.approaches.find((x) => x.des === detail.des);
      const mark = chart.querySelector<SVGElement>(`circle[data-des="${CSS.escape(detail.des)}"]`);
      if (!a || !mark) return;
      detail.found = true;
      chart.querySelectorAll(".is-linked").forEach((el) => el.classList.remove("is-linked"));
      mark.classList.add("is-linked", "is-hot");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      chart.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      // Show the tooltip once scrolling has finished (any scroll hides tooltips).
      window.clearTimeout(linkTimer);
      const show = () => {
        window.clearTimeout(linkTimer);
        window.removeEventListener("scrollend", show);
        if (mark.isConnected) showTipAt(tip(a, Date.now()), mark);
      };
      window.addEventListener("scrollend", show, { once: true });
      linkTimer = window.setTimeout(show, reduce ? 50 : 1200);
      window.setTimeout(() => {
        mark.classList.remove("is-linked", "is-hot");
        hideTip();
      }, 5000);
    };
    window.addEventListener("astro:show-in-neo", onShowInNeo);
    const stop = onResize(chart, (w) => drawChart(chart, data, w));
    return () => {
      stop();
      window.clearTimeout(linkTimer);
      window.removeEventListener("astro:show-in-neo", onShowInNeo);
    };
  },

  summarize({ data }) {
    const now = Date.now();
    const next = data.approaches.find((a) => new Date(a.time).getTime() >= now);
    if (!next) return null;
    const km = sizeKm(next);
    return {
      label: "Next asteroid flyby",
      icon: ICONS.asteroid,
      value: next.name.replace(/^\((.*)\)$/, "$1"),
      detail: `${relative(next.time, now)} · ${fmt.fixed(next.distLd, 2)} LD${km ? ` · ${sizeAnalogy(km * 1000)}` : ""}`,
    };
  },
};
