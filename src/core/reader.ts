import type { GcnCircular } from "../../shared/contract";
import { ApiError, fetchCircular } from "./api";
import { h, icon, safeUrl } from "./dom";
import { utc } from "./format";
import { ICONS } from "./icons";

/**
 * Reader for GCN Circulars: a modal dialog that fetches one circular (through the Worker)
 * when it is opened, with navigation within the event. Circulars are numbered in the order
 * they were issued (1 = first report), so the counter, Older/Newer and the arrow keys all
 * point the same way. Circulars are plain text; URLs in them become links, nothing else is
 * interpreted.
 */

export interface ReaderItem {
  id: number;
  subject: string;
  createdOn?: string | null;
}

const cache = new Map<number, GcnCircular>();
let dialog: HTMLDialogElement | null = null;

/** Plain text with http(s) links made clickable (text nodes only — never parsed as HTML). */
function linkify(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:]/g)) {
    out.push(document.createTextNode(text.slice(last, m.index)));
    const href = safeUrl(m[0]);
    out.push(href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, m[0]) : document.createTextNode(m[0]));
    last = m.index! + m[0].length;
  }
  out.push(document.createTextNode(text.slice(last)));
  return out;
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  dialog = h("dialog", { class: "reader", "aria-labelledby": "reader-title" });
  dialog.addEventListener("click", (ev) => {
    // Click on the backdrop closes.
    if (ev.target === dialog) dialog!.close();
  });
  document.body.append(dialog);
  return dialog;
}

/** Short end-of-list label for position `i` of `n` ("first report", "newest"). */
export function endLabel(i: number, n: number): string | null {
  if (n <= 1) return null;
  if (i === 0) return "first report";
  if (i === n - 1) return "newest";
  return null;
}

/** Open the reader on `items[index]` (items: the event's circulars, oldest first). */
export function openReader(eventName: string, items: ReaderItem[], index: number) {
  const dlg = ensureDialog();
  const n = items.length;
  let controller: AbortController | null = null;
  let pos = Math.max(0, Math.min(n - 1, index));
  const many = n >= 3;

  const head = h("div", { class: "reader-head" });
  const body = h("div", { class: "reader-body", tabindex: 0 });
  const jump = h("div", { class: "reader-jump", hidden: true });
  const nav = h("div", { class: "reader-nav" });
  const closeBtn = h("button", { class: "btn btn-icon btn-quiet", type: "button", "aria-label": "Close" }, icon(ICONS.close));
  closeBtn.addEventListener("click", () => dlg.close());

  const dateOf = (it: ReaderItem) => it.createdOn ?? cache.get(it.id)?.createdOn ?? null;

  const btn = (cls: string, label: string, onClick: () => void, ...children: (Node | string)[]) => {
    const b = h("button", { class: `btn ${cls}`, type: "button", "aria-label": label, title: label }, ...children);
    b.addEventListener("click", onClick);
    return b;
  };
  const go = (i: number) => {
    const next = Math.max(0, Math.min(n - 1, i));
    setJump(false);
    if (next === pos) return;
    pos = next;
    void show();
  };
  const firstBtn = btn("btn-icon reader-end", "First report", () => go(0), icon(ICONS.first));
  const olderBtn = btn("reader-step", "Older circular", () => go(pos - 1), icon(ICONS.prev), h("span", { class: "reader-step-label" }, "Older"));
  const newerBtn = btn("reader-step", "Newer circular", () => go(pos + 1), h("span", { class: "reader-step-label" }, "Newer"), icon(ICONS.next));
  const lastBtn = btn("btn-icon reader-end", "Newest circular", () => go(n - 1), icon(ICONS.last));
  const posBtn = h("button", { class: "btn reader-pos", type: "button", "aria-haspopup": "true", "aria-expanded": "false", title: "Jump to a circular" });
  posBtn.addEventListener("click", () => setJump(posBtn.getAttribute("aria-expanded") !== "true"));

  const setJump = (open: boolean) => {
    if (!many || open === (posBtn.getAttribute("aria-expanded") === "true")) return;
    jump.hidden = !open;
    body.hidden = open;
    posBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      renderJump();
      const cur = jump.querySelector<HTMLElement>("[aria-current]");
      cur?.scrollIntoView({ block: "center" });
      cur?.focus();
    } else if (jump.contains(document.activeElement)) {
      posBtn.focus();
    }
  };

  const renderJump = () => {
    const undated = items.some((it) => !dateOf(it));
    jump.replaceChildren(
      undated ? h("p", { class: "jump-note" }, "Dates show for circulars whose text has been loaded; GCN numbers run in order of issue.") : "",
      h(
        "ol",
        { class: "jump-list", "aria-label": `${eventName}: all ${n} circulars, first report first` },
        items.map((it, i) => {
          const d = dateOf(it);
          const end = endLabel(i, n);
          const b = h(
            "button",
            { type: "button", class: "jump-item", "aria-current": i === pos ? "true" : null },
            h("span", { class: "jump-num mono" }, String(i + 1)),
            h("span", { class: "jump-main" }, h("span", { class: "jump-subject" }, it.subject), h("span", { class: "jump-meta mono" }, [`GCN ${it.id}`, d ? ` · ${utc(d)}` : "", end ? ` · ${end}` : ""])),
          );
          b.addEventListener("click", () => {
            go(i);
            body.focus();
          });
          return h("li", null, b);
        }),
      ),
    );
  };

  const kicker = () => {
    const end = n === 1 ? "the only circular" : endLabel(pos, n);
    return `${eventName} · Circular ${pos + 1} of ${n}${end ? ` · ${end}` : ""}`;
  };

  const show = async () => {
    controller?.abort();
    controller = new AbortController();
    const item = items[pos]!;
    head.replaceChildren(
      h("div", { class: "reader-kicker" }, kicker()),
      h("h2", { id: "reader-title" }, item.subject),
      h("div", { class: "reader-meta" }, `GCN Circular ${item.id}`),
    );
    updateNav();
    let c = cache.get(item.id);
    if (!c) {
      body.replaceChildren(h("p", { class: "reader-loading" }, "Loading the circular from gcn.nasa.gov…"));
      try {
        c = await fetchCircular(item.id, controller.signal);
        cache.set(item.id, c);
      } catch (err) {
        if (controller.signal.aborted) return;
        const retry = h("button", { class: "btn", type: "button" }, icon(ICONS.refresh), "Try again");
        retry.addEventListener("click", () => void show());
        body.replaceChildren(
          h("div", { class: "error-state inline", role: "alert" }, h("div", null, h("h3", null, "Couldn’t load this circular."), h("p", null, err instanceof ApiError ? err.message : "Network error."), h("div", { class: "error-actions" }, retry))),
        );
        return;
      }
      if (items[pos]!.id !== item.id) return;
    }
    head.querySelector(".reader-meta")!.replaceChildren(
      `GCN Circular ${c.id}`,
      c.createdOn ? ` · ${utc(c.createdOn)}` : "",
      c.submitter ? ` · from ${c.submitter}` : "",
    );
    body.replaceChildren(h("pre", { class: "reader-text" }, linkify(c.body)));
    body.scrollTop = 0;
  };

  const ext = h("a", { class: "btn btn-quiet reader-ext", target: "_blank", rel: "noopener" }, "Open on gcn.nasa.gov", icon(ICONS.external));
  const updateNav = () => {
    const focused = document.activeElement;
    olderBtn.disabled = pos <= 0;
    newerBtn.disabled = pos >= n - 1;
    firstBtn.disabled = pos <= 0;
    lastBtn.disabled = pos >= n - 1;
    posBtn.replaceChildren(icon(ICONS.list), h("span", null, `${pos + 1} / ${n}`));
    posBtn.setAttribute("aria-label", `Circular ${pos + 1} of ${n}. Show all circulars`);
    ext.href = `https://gcn.nasa.gov/circulars/${items[pos]!.id}`;
    // Keep keyboard focus on a usable control when the focused one has just become unavailable.
    if (focused instanceof HTMLButtonElement && focused.disabled) {
      (focused === olderBtn || focused === firstBtn ? newerBtn : olderBtn).focus();
    }
  };
  const controls = n === 1 ? [] : many ? [firstBtn, olderBtn, posBtn, newerBtn, lastBtn] : [olderBtn, newerBtn];
  nav.replaceChildren(controls.length ? h("div", { class: "reader-controls" }, controls) : "", ext);

  dlg.replaceChildren(h("div", { class: "reader-top" }, head, closeBtn), jump, body, nav);
  dlg.onclose = () => controller?.abort();
  dlg.oncancel = (ev) => {
    // Escape closes the jump list first, then the reader.
    if (!jump.hidden) {
      ev.preventDefault();
      setJump(false);
    }
  };
  dlg.onkeydown = (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const inList = jump.contains(ev.target as Node);
    if (ev.key === "ArrowLeft" && !inList) go(pos - 1);
    else if (ev.key === "ArrowRight" && !inList) go(pos + 1);
    else if (inList && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      const all = [...jump.querySelectorAll<HTMLElement>(".jump-item")];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[Math.max(0, Math.min(all.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)))]?.focus();
      ev.preventDefault();
    }
  };
  if (!dlg.open) dlg.showModal();
  void show();
  closeBtn.focus();
}
