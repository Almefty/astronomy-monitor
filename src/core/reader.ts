import type { GcnCircular } from "../../shared/contract";
import { ApiError, fetchCircular } from "./api";
import { h, icon, safeUrl } from "./dom";
import { utc } from "./format";
import { ICONS } from "./icons";

/**
 * Reader for GCN Circulars: a modal dialog that fetches one circular (through the Worker)
 * when it is opened, with older/newer navigation within the event. Circulars are plain
 * text; URLs in them become links, nothing else is interpreted.
 */

interface ReaderItem {
  id: number;
  subject: string;
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

/** Open the reader on `items[index]` (items: the event's circulars, newest first). */
export function openReader(eventName: string, items: ReaderItem[], index: number) {
  const dlg = ensureDialog();
  let controller: AbortController | null = null;
  let pos = Math.max(0, Math.min(items.length - 1, index));

  const head = h("div", { class: "reader-head" });
  const body = h("div", { class: "reader-body", tabindex: 0 });
  const nav = h("div", { class: "reader-nav" });
  const closeBtn = h("button", { class: "btn btn-icon btn-quiet", type: "button", "aria-label": "Close" }, icon(ICONS.close));
  closeBtn.addEventListener("click", () => dlg.close());

  const show = async () => {
    controller?.abort();
    controller = new AbortController();
    const item = items[pos]!;
    head.replaceChildren(
      h("div", { class: "reader-kicker" }, `${eventName} · Circular ${pos + 1} of ${items.length}`),
      h("h2", { id: "reader-title" }, item.subject),
      h("div", { class: "reader-meta" }, `GCN Circular ${item.id}`),
    );
    renderNav();
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

  const renderNav = () => {
    const older = h("button", { class: "btn", type: "button", disabled: pos >= items.length - 1 }, icon(ICONS.prev), "Older");
    const newer = h("button", { class: "btn", type: "button", disabled: pos <= 0 }, "Newer", icon(ICONS.next));
    older.addEventListener("click", () => {
      pos++;
      void show();
    });
    newer.addEventListener("click", () => {
      pos--;
      void show();
    });
    const item = items[pos]!;
    nav.replaceChildren(
      older,
      newer,
      h("a", { class: "btn btn-quiet reader-ext", href: `https://gcn.nasa.gov/circulars/${item.id}`, target: "_blank", rel: "noopener" }, "Open on gcn.nasa.gov", icon(ICONS.external)),
    );
  };

  dlg.replaceChildren(h("div", { class: "reader-top" }, head, closeBtn), body, nav);
  dlg.onclose = () => controller?.abort();
  dlg.onkeydown = (ev) => {
    if (ev.key === "ArrowLeft" && pos < items.length - 1) {
      pos++;
      void show();
    } else if (ev.key === "ArrowRight" && pos > 0) {
      pos--;
      void show();
    }
  };
  if (!dlg.open) dlg.showModal();
  void show();
  closeBtn.focus();
}
