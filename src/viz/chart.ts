import type { ScaleLinear, ScaleLogarithmic, ScaleTime } from "d3-scale";
import { s } from "../core/dom";
import { hideTip, showTip, showTipAt, type TipContent } from "./tooltip";

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function svgRoot(width: number, height: number, label: string): SVGSVGElement {
  return s("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": label });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Bottom time axis with day ticks (or hour ticks for spans under 3 days, UTC) and optional vertical gridlines. */
export function timeAxis(
  g: SVGGElement,
  x: ScaleTime<number, number>,
  y0: number,
  gridTop: number | null,
  maxTicks: number,
) {
  const ax = s("g", { class: "axis" });
  const ticks = x.ticks(Math.max(2, maxTicks));
  // Short spans (the live X-ray chart) get clock-time labels; days are marked at midnight.
  const [d0, d1] = x.domain() as [Date, Date];
  const hourly = d1.getTime() - d0.getTime() < 3 * 86_400_000;
  ax.append(s("line", { x1: x.range()[0], x2: x.range()[1], y1: y0 + 0.5, y2: y0 + 0.5 }));
  let labelled = 0;
  for (const t of ticks) {
    const px = Math.round(x(t)) + 0.5;
    if (gridTop !== null) g.append(s("line", { class: "gridline", x1: px, x2: px, y1: gridTop, y2: y0 }));
    ax.append(s("line", { x1: px, x2: px, y1: y0, y2: y0 + 4 }));
    const midnight = t.getUTCHours() === 0 && t.getUTCMinutes() === 0;
    const day = `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
    // Day-scale axes label only midnight ticks (a 12-hour tick would repeat the date).
    if (!hourly && !midnight) continue;
    const label = hourly
      ? midnight ? day : `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`
      : t.getUTCDate() === 1 || labelled === 0 ? day : String(t.getUTCDate());
    labelled++;
    ax.append(s("text", { x: px, y: y0 + 16, "text-anchor": "middle" }, label));
  }
  g.append(ax);
}

/** Left axis with horizontal gridlines for given tick values. */
export function yAxis(
  g: SVGGElement,
  y: ScaleLinear<number, number> | ScaleLogarithmic<number, number>,
  ticks: number[],
  format: (v: number) => string,
  x0: number,
  x1: number,
  opts: { side?: "left" | "right"; grid?: boolean } = {},
): SVGGElement {
  const ax = s("g", { class: "axis" });
  const side = opts.side ?? "left";
  for (const t of ticks) {
    const py = Math.round(y(t)) + 0.5;
    if (opts.grid !== false) g.append(s("line", { class: "gridline", x1: x0, x2: x1, y1: py, y2: py }));
    ax.append(
      s("text", { x: side === "left" ? x0 - 6 : x1 + 6, y: py + 3.5, "text-anchor": side === "left" ? "end" : "start" }, format(t)),
    );
  }
  g.append(ax);
  return ax;
}

export interface HoverPoint {
  x: number;
  y: number;
  tip: TipContent;
  /** Element to highlight while hovered. */
  mark?: SVGElement;
  href?: string;
  /** Action on click (mouse), second tap (touch) or Enter (keyboard); takes precedence over href. */
  onSelect?: () => void;
}

/**
 * Nearest-point hover layer: the hit target is the whole plot area, so small marks
 * are easy to hit on desktop and touch. Points are also keyboard-focusable.
 */
export function hoverLayer(svg: SVGSVGElement, points: HoverPoint[], area: { x: number; y: number; w: number; h: number }, maxDist = 40) {
  const rect = s("rect", { class: "hit", x: area.x, y: area.y, width: area.w, height: area.h });
  svg.append(rect);
  let hot: HoverPoint | null = null;

  const toLocal = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return { x: ((ev.clientX - r.left) / r.width) * vb.width, y: ((ev.clientY - r.top) / r.height) * vb.height };
  };
  const setHot = (p: HoverPoint | null) => {
    if (hot?.mark) hot.mark.classList.remove("is-hot");
    hot = p;
    if (p?.mark) p.mark.classList.add("is-hot");
  };
  const nearest = (lx: number, ly: number) => {
    let best: HoverPoint | null = null;
    let bd = maxDist * maxDist;
    for (const p of points) {
      const d = (p.x - lx) ** 2 + (p.y - ly) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };

  rect.addEventListener("pointermove", (ev) => {
    const { x, y } = toLocal(ev);
    const p = nearest(x, y);
    setHot(p);
    if (p) showTip(p.tip, ev.clientX, ev.clientY);
    else hideTip();
    rect.style.cursor = p?.href || p?.onSelect ? "pointer" : "default";
  });
  rect.addEventListener("pointerleave", () => {
    setHot(null);
    hideTip();
  });
  let tapped: HoverPoint | null = null;
  rect.addEventListener("click", (ev) => {
    const { x, y } = toLocal(ev);
    const p = nearest(x, y);
    const mouse = ev.pointerType === "mouse";
    // On touch, the first tap shows the tooltip; a second tap on the same point selects it.
    if (p?.onSelect && (mouse || tapped === p)) p.onSelect();
    else if (p?.href && mouse) window.open(p.href, "_blank", "noopener");
    tapped = p;
  });

  // Keyboard: each point gets an invisible focusable target.
  const kb = s("g", { "aria-label": "Data points" });
  for (const p of points) {
    const t = s("circle", { cx: p.x, cy: p.y, r: 6, fill: "transparent", style: "pointer-events:none", tabindex: 0, role: "img", "aria-label": `${p.tip.title}. ${(p.tip.rows ?? []).map((r) => r.join(": ")).join(", ")}` });
    t.addEventListener("focus", () => {
      setHot(p);
      showTipAt(p.tip, t);
    });
    t.addEventListener("blur", () => {
      setHot(null);
      hideTip();
    });
    t.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (p.onSelect) p.onSelect();
      else if (p.href) window.open(p.href, "_blank", "noopener");
    });
    kb.append(t);
  }
  svg.append(kb);
}

export interface LabelCandidate {
  x: number;
  y: number;
  text: string;
  anchor?: "start" | "middle" | "end";
}

/**
 * Greedy label placement: candidates are taken in priority order and dropped if
 * they would overlap a label already placed (approximate text box). Dropped
 * values remain available through tooltips and tables.
 */
export function placeLabels(g: SVGGElement, candidates: LabelCandidate[], charWidth = 6.6, lineHeight = 13) {
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const c of candidates) {
    const w = c.text.length * charWidth;
    const x0 = c.anchor === "end" ? c.x - w : c.anchor === "middle" ? c.x - w / 2 : c.x;
    const box = { x0: x0 - 2, x1: x0 + w + 2, y0: c.y - lineHeight + 3, y1: c.y + 3 };
    if (boxes.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
    boxes.push(box);
    g.append(s("text", { class: "mark-label", x: c.x, y: c.y, "text-anchor": c.anchor ?? "start" }, c.text));
  }
}
