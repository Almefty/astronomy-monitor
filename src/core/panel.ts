import type { Notice, UpstreamCall } from "../../shared/contract";
import { ApiError } from "./api";
import { clear, h, icon } from "./dom";
import { age, localTime } from "./format";
import { ICONS } from "./icons";
import { load, save } from "./storage";

export interface PanelResult<D> {
  data: D;
  fetchedAt: string;
  upstream: UpstreamCall[];
  notices: Notice[];
}

export interface Summary {
  label: string;
  icon: string;
  value: string;
  detail: string;
}

export interface AppContext {
  env: "development" | "production";
}

export interface ErrorAction {
  label: string;
  /** Loads alternative data (e.g. a saved sample) for this panel. */
  params: Record<string, string>;
}

/**
 * Everything a dashboard panel needs. To add a panel (v2: GCN all-sky map, JWST/HST
 * targets, live GOES X-rays, 3D solar system) implement this interface in
 * src/panels/<name>.ts and register it in src/panels/index.ts. Heavy panels can
 * lazy-load their libraries inside render() with a dynamic import().
 */
export interface PanelDefinition<D> {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  span: "span-12" | "span-7" | "span-5";
  source: { name: string; url: string };
  /** Fetch fresh data. Called only when the user presses a refresh button. */
  load(signal: AbortSignal, params: Record<string, string>): Promise<PanelResult<D>>;
  /** Draw into `root`. Return an optional cleanup (observers, listeners). */
  render(root: HTMLElement, result: PanelResult<D>, ctx: AppContext): void | (() => void);
  /** One-line readout for the "Right now" strip. */
  summarize?(result: PanelResult<D>): Summary | null;
  /** Panel-specific controls rendered in the header (e.g. a time-range switch). */
  controls?(host: PanelHost<D>): HTMLElement | null;
  /** Extra buttons offered when the panel fails, e.g. a dev-only saved sample. */
  errorActions?(err: ApiError, ctx: AppContext): ErrorAction[];
  /** Whether to keep the last result in localStorage (default true). */
  persist?: boolean;
}

type Listener = () => void;

export class PanelHost<D = unknown> {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private stamp: HTMLElement;
  private foot: HTMLElement;
  private refreshBtn: HTMLButtonElement;
  private cleanup: (() => void) | null = null;
  private controller: AbortController | null = null;
  private listeners: Listener[] = [];
  result: PanelResult<D> | null = null;
  params: Record<string, string> = {};
  busy = false;

  constructor(
    readonly def: PanelDefinition<D>,
    private ctx: AppContext,
  ) {
    this.refreshBtn = h(
      "button",
      { class: "btn btn-icon btn-quiet", type: "button", title: `Refresh ${def.title}`, "aria-label": `Refresh ${def.title}` },
      icon(ICONS.refresh),
    );
    this.refreshBtn.addEventListener("click", () => void this.refresh());
    this.stamp = h("div", { class: "panel-stamp", "aria-live": "polite" }, "No data yet");
    this.body = h("div", { class: "panel-body" });
    this.foot = h("div", { class: "panel-foot" }, `Source: ${def.source.name}`);
    const svg = icon(def.icon);
    this.el = h(
      "section",
      { class: `panel ${def.span}`, id: `panel-${def.id}`, "aria-labelledby": `panel-${def.id}-title` },
      h("div", { class: "loading-bar", "aria-hidden": "true" }),
      h(
        "header",
        { class: "panel-head" },
        h("div", { class: "panel-title" }, h("h2", { id: `panel-${def.id}-title` }, svg, def.title), h("p", null, def.subtitle)),
        h("div", { class: "panel-tools" }, def.controls?.(this) ?? null, this.stamp, this.refreshBtn),
      ),
      this.body,
      this.foot,
    );
    this.renderEmpty();
    if (def.persist !== false) {
      const snap = load<PanelResult<D>>(`snap:${def.id}`);
      if (snap) this.show(snap, true);
    }
    setInterval(() => this.updateStamp(), 60_000);
  }

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  async refresh(extraParams: Record<string, string> = {}): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setBusy(true);
    try {
      const result = await this.def.load(controller.signal, { ...this.params, ...extraParams });
      if (controller.signal.aborted) return;
      this.show(result, false);
      if (this.def.persist !== false && !extraParams.sample) save(`snap:${this.def.id}`, result);
    } catch (err) {
      if (controller.signal.aborted) return;
      this.showError(err);
    } finally {
      if (this.controller === controller) {
        this.setBusy(false);
        this.controller = null;
      }
    }
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.el.classList.toggle("is-loading", busy);
    this.refreshBtn.classList.toggle("is-busy", busy);
    this.refreshBtn.disabled = busy;
    this.el.setAttribute("aria-busy", String(busy));
    if (busy) this.stamp.textContent = "Fetching…";
    else if (this.result && !this.body.querySelector(".error-state")) this.updateStamp();
    this.emit();
  }

  private updateStamp() {
    if (this.busy) return;
    if (!this.result) {
      if (!this.body.querySelector(".error-state")) this.stamp.textContent = "No data yet";
      return;
    }
    const at = this.result.fetchedAt;
    const ageMs = Date.now() - new Date(at).getTime();
    this.stamp.textContent = `Updated ${localTime(at)} · ${age(at)} ago`;
    this.stamp.classList.toggle("is-stale", ageMs > 6 * 3600_000);
    this.stamp.title = new Date(at).toString();
  }

  private renderEmpty() {
    clear(this.body);
    this.body.append(
      h(
        "div",
        { class: "empty-state" },
        h("div", null, icon(this.def.icon), h("p", null, "Nothing loaded yet."), h("p", null, "Press “Refresh all” at the top, or this panel’s refresh button.")),
      ),
    );
  }

  /** Render a result. Rendering errors are contained to this panel. */
  show(result: PanelResult<D>, restored: boolean) {
    this.cleanup?.();
    this.cleanup = null;
    this.result = result;
    clear(this.body);
    const content = h("div", { class: "panel-content" });
    const notices = [...result.notices];
    if (restored) notices.unshift({ level: "info", text: `Showing the last data you loaded (${age(result.fetchedAt)} old). Refresh for current data.` });
    if (notices.length) {
      content.append(h("div", { class: "panel-notices" }, notices.map((n) => h("div", { class: "panel-notice", role: "status" }, n.text))));
    }
    const root = h("div");
    content.append(root);
    this.body.append(content);
    try {
      this.cleanup = this.def.render(root, result, this.ctx) ?? null;
    } catch (err) {
      console.error(`[${this.def.id}] render failed`, err);
      root.replaceChildren(this.errorBox("This panel couldn’t draw its data.", "The data loaded, but a display error occurred. Other panels are unaffected.", null));
    }
    this.renderFoot(result.upstream);
    this.updateStamp();
    this.emit();
  }

  private showError(err: unknown) {
    const apiErr = err instanceof ApiError ? err : null;
    const message = apiErr?.message ?? (err as Error)?.message ?? "Unknown error.";
    const hint = apiErr?.body?.error.hint ?? null;
    clear(this.body);
    const box = this.errorBox(`Couldn’t load ${this.def.title.toLowerCase()}.`, message, hint);
    const actions = apiErr ? (this.def.errorActions?.(apiErr, this.ctx) ?? []) : [];
    const btns = h("div", { class: "error-actions" });
    const retry = h("button", { class: "btn", type: "button" }, icon(ICONS.refresh), "Try again");
    retry.addEventListener("click", () => void this.refresh());
    btns.append(retry);
    for (const a of actions) {
      const b = h("button", { class: "btn", type: "button" }, a.label);
      b.addEventListener("click", () => void this.refresh(a.params));
      btns.append(b);
    }
    box.append(btns);
    this.body.append(box);
    if (this.result) {
      const keep = h("button", { class: "btn btn-quiet", type: "button" }, `Show previous data (${age(this.result.fetchedAt)} old)`);
      const prev = this.result;
      keep.addEventListener("click", () => this.show(prev, true));
      btns.append(keep);
    }
    this.renderFoot(apiErr?.body?.upstream ?? []);
    this.stamp.textContent = "Failed — see details";
    this.emit();
  }

  private errorBox(title: string, message: string, hint: string | null): HTMLElement {
    return h("div", { class: "error-state", role: "alert" }, h("div", null, h("h3", null, title), h("p", null, message), hint ? h("p", { class: "hint" }, hint) : null));
  }

  private renderFoot(calls: UpstreamCall[]) {
    clear(this.foot);
    const src = h("a", { href: this.def.source.url, target: "_blank", rel: "noopener" }, this.def.source.name);
    if (!calls.length) {
      this.foot.append("Source: ", src);
      return;
    }
    const slowest = Math.max(...calls.map((c) => c.ms));
    const failed = calls.filter((c) => !c.ok).length;
    const summary = h(
      "summary",
      null,
      h("span", null, "Source: ", src),
      h("span", null, `· ${calls.length} request${calls.length > 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""} · ${(slowest / 1000).toFixed(1)} s`),
    );
    const list = h(
      "ul",
      { class: "upstream-list" },
      calls.map((c) =>
        h(
          "li",
          null,
          h("span", { class: c.ok ? "dot-ok" : "dot-fail", "aria-label": c.ok ? "OK" : "Failed" }),
          h("span", null, c.name, h("code", null, c.url)),
          h("span", { class: "mono" }, `${c.status ?? "—"} · ${c.ms} ms`),
        ),
      ),
    );
    this.foot.append(h("details", null, summary, list));
  }
}
