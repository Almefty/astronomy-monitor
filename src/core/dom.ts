type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | number | null | undefined | false | Child[];

function apply(el: Element, attrs: Attrs | undefined) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      el.setAttribute("class", String(v));
    } else {
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
}

function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Create an HTML element. Text children are always inserted as text (never parsed as HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs ?? undefined);
  append(el, children);
  return el;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs ?? undefined);
  append(el, children);
  return el;
}

/** Parse a trusted, static SVG string (icons shipped with the app — never data). */
export function icon(svgMarkup: string): SVGSVGElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = svgMarkup.trim();
  const svg = tpl.content.firstElementChild as SVGSVGElement;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

/** Re-render a chart whenever its container width changes. */
export function onResize(el: Element, fn: (width: number) => void): () => void {
  let last = -1;
  let raf = 0;
  const ro = new ResizeObserver((entries) => {
    const w = Math.round(entries[0]?.contentRect.width ?? 0);
    if (w === last || w === 0) return;
    last = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => fn(w));
  });
  ro.observe(el);
  return () => ro.disconnect();
}

/** Only allow http(s) links from data into href/src attributes. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
