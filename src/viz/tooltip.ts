import { h } from "../core/dom";

export interface TipContent {
  title: string;
  rows?: [string, string][];
  note?: string;
}

let el: HTMLDivElement | null = null;

function node(): HTMLDivElement {
  if (!el) {
    el = h("div", { class: "tooltip", role: "tooltip" });
    document.body.append(el);
  }
  return el;
}

export function showTip(content: TipContent, clientX: number, clientY: number) {
  const t = node();
  const parts: Node[] = [h("strong", null, content.title)];
  if (content.rows?.length) parts.push(h("dl", null, content.rows.map(([k, v]) => [h("dt", null, k), h("dd", null, v)])));
  if (content.note) parts.push(h("div", { style: "margin-top:4px;color:var(--ink-2)" }, content.note));
  t.replaceChildren(...parts);
  t.classList.add("is-visible");
  const pad = 14;
  const { width, height } = t.getBoundingClientRect();
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + width > window.innerWidth - 8) x = clientX - width - pad;
  if (y + height > window.innerHeight - 8) y = clientY - height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

/** Position next to an element (keyboard focus). */
export function showTipAt(content: TipContent, target: Element) {
  const r = target.getBoundingClientRect();
  showTip(content, r.right, r.top);
}

export function hideTip() {
  el?.classList.remove("is-visible");
}

window.addEventListener("scroll", hideTip, { passive: true });

let fromTrigger = false;

/** Explanatory tooltip on a small trigger element: shown on hover, keyboard focus or tap; hidden on leave/blur. */
export function attachTip(target: HTMLElement, content: TipContent) {
  const show = () => {
    showTipAt(content, target);
    fromTrigger = true;
  };
  target.classList.add("tip-trigger");
  target.addEventListener("mouseenter", show);
  target.addEventListener("focus", show);
  target.addEventListener("click", show);
  target.addEventListener("mouseleave", hideTip);
  target.addEventListener("blur", hideTip);
}

// A tap anywhere else closes a tooltip opened from a trigger (touch has no mouseleave).
document.addEventListener("pointerdown", (ev) => {
  if (fromTrigger && !(ev.target instanceof Element && ev.target.closest(".tip-trigger"))) {
    fromTrigger = false;
    hideTip();
  }
});
