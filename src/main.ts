import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";

import { fetchStatus } from "./core/api";
import { h, icon } from "./core/dom";
import { age, localTime } from "./core/format";
import { ICONS } from "./core/icons";
import { LiveMode } from "./core/live";
import { PanelHost, type AppContext } from "./core/panel";
import { applyTheme, currentChoice, initTheme, type ThemeChoice } from "./core/theme";
import { PANELS } from "./panels/index";

initTheme();

const ctx: AppContext = { env: import.meta.env.DEV ? "development" : "production" };
const hosts = PANELS.map((def) => new PanelHost(def, ctx));
const live = new LiveMode(hosts);

/* ---------- Header */

const clock = h("div", { class: "clock", "aria-label": "Current time, UTC" });
const tickClock = () => {
  const d = new Date();
  clock.replaceChildren(
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`,
    h("small", null, `UTC · ${d.toISOString().slice(0, 10)}`),
  );
};
tickClock();
setInterval(tickClock, 1000);

const themeGroup = h("div", { class: "segmented theme-group", role: "group", "aria-label": "Colour theme" });
const themes: [ThemeChoice, string, string][] = [["auto", ICONS.auto, "Match system"], ["light", ICONS.sun, "Light"], ["dark", ICONS.moon, "Dark"]];
const themeCycle = h("button", { type: "button", class: "btn btn-icon theme-cycle" });
const syncTheme = () => {
  themeGroup.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === currentChoice())));
  const i = themes.findIndex(([c]) => c === currentChoice());
  const [, svg, label] = themes[i]!;
  const nextLabel = themes[(i + 1) % themes.length]![2];
  themeCycle.replaceChildren(icon(svg));
  themeCycle.setAttribute("aria-label", `Theme: ${label}. Switch to ${nextLabel}`);
  themeCycle.title = `Theme: ${label} (tap for ${nextLabel})`;
};
themeCycle.addEventListener("click", () => {
  const i = themes.findIndex(([c]) => c === currentChoice());
  applyTheme(themes[(i + 1) % themes.length]![0]);
  syncTheme();
});
for (const [choice, svg, label] of themes) {
  const b = h("button", { type: "button", "data-theme": choice, title: label, "aria-label": label }, icon(svg));
  b.addEventListener("click", () => {
    applyTheme(choice);
    syncTheme();
  });
  themeGroup.append(b);
}
syncTheme();

const refreshAllBtn = h(
  "button",
  { class: "btn btn-primary", type: "button", title: "Fetch fresh data for every panel (Shift+R)" },
  icon(ICONS.refresh),
  h("span", null, "Refresh", h("span", { class: "btn-label-long" }, " all")),
);
refreshAllBtn.querySelector("svg")?.classList.add("spin");

const lastAll = h(
  "div",
  { class: "intro-meta" },
  hosts.some((host) => host.result) ? "Showing data saved from your last visit — press Refresh all for live data" : "Press Refresh all to load live data",
);

/** The last "Refresh all": when it ran and which panels failed. */
let lastRefresh: { at: string; failed: string[] } | null = null;

/**
 * "Refreshed 14:20 · 7 of 7 panels loaded · oldest data 25 min old". A panel counts as loaded when
 * its request succeeded, even if Cloudflare answered from its cache; the age is that of the oldest
 * data on screen (each panel's own stamp shows its age), so it is recomputed as time passes.
 */
function renderLastAll() {
  if (!lastRefresh) return;
  const { at, failed } = lastRefresh;
  const parts = [`Refreshed ${localTime(at)}`, `${hosts.length - failed.length} of ${hosts.length} panels loaded`];
  if (failed.length) parts.push(`failed: ${failed.join(", ")}`);
  const oldest = hosts
    .filter((host) => !failed.includes(host.def.title))
    .map((host) => host.result?.fetchedAt)
    .filter((t): t is string => !!t)
    .sort()[0];
  if (oldest) parts.push(age(oldest) === "moments" ? "all data under a minute old" : `oldest data ${age(oldest)} old`);
  lastAll.textContent = parts.join(" · ");
}

async function refreshAll() {
  if (refreshAllBtn.disabled) return;
  refreshAllBtn.disabled = true;
  refreshAllBtn.classList.add("is-busy");
  const at = new Date().toISOString();
  const results = await Promise.allSettled(hosts.map((host) => host.refresh()));
  refreshAllBtn.disabled = false;
  refreshAllBtn.classList.remove("is-busy");
  const failed = hosts.filter((_, i) => {
    const r = results[i]!;
    return r.status !== "fulfilled" || !r.value;
  });
  lastRefresh = { at, failed: failed.map((host) => host.def.title) };
  renderLastAll();
}
hosts.forEach((host) => host.onChange(renderLastAll));
setInterval(renderLastAll, 60_000);
refreshAllBtn.addEventListener("click", () => void refreshAll());

/* ---------- Live mode (opt-in; off on every visit) */

const liveBtn = h(
  "button",
  { class: "btn live-toggle", type: "button", "aria-pressed": "false", title: "Live mode: refresh fast-changing data automatically while this page is visible" },
  h("span", { class: "live-dot", "aria-hidden": "true" }),
  h("span", null, "Live"),
);
const liveStatus = h("div", { class: "live-status", role: "status", hidden: true });
liveBtn.addEventListener("click", () => live.setEnabled(!live.enabled));
window.addEventListener("livechange", () => {
  const st = live.status();
  liveBtn.setAttribute("aria-pressed", String(st !== "off"));
  liveBtn.dataset.state = st;
  liveStatus.hidden = st === "off";
  liveStatus.replaceChildren(
    h("span", { class: "live-dot", "data-state": st, "aria-hidden": "true" }),
    h("strong", null, st === "paused" ? "Live mode paused" : "Live mode on"),
    h("span", null, st === "paused" ? (navigator.onLine ? " — this tab is hidden, so nothing is fetched." : " — you’re offline.") : ` — ${live.describe()}. Pauses while this tab is hidden.`),
  );
});
window.addEventListener("keydown", (ev) => {
  const target = ev.target as HTMLElement;
  if (ev.key === "R" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(target.tagName)) void refreshAll();
});

const topbar = h(
  "header",
  { class: "topbar" },
  h(
    "div",
    { class: "topbar-inner" },
    h("div", { class: "app-label" }, "Astronomy Monitor"),
    clock,
    h("div", { class: "topbar-actions" }, themeGroup, themeCycle, liveBtn, refreshAllBtn),
  ),
);

/* ---------- "Right now" strip */

const strip = h("nav", { class: "now-strip", "aria-label": "Right now — jump to a panel" });
function renderStrip() {
  strip.replaceChildren(
    ...hosts.map((host) => {
      const sum = host.result ? safeSummary(host) : null;
      return h(
        "a",
        { class: `readout${sum ? "" : " is-empty"}`, href: `#panel-${host.def.id}` },
        h("span", { class: "readout-label" }, icon(host.def.icon), sum?.label ?? host.def.title),
        h("span", { class: "readout-value" }, sum?.value ?? (host.busy ? "Loading…" : "—")),
        h("span", { class: "readout-detail" }, sum?.detail ?? (host.busy ? "" : "no data loaded")),
      );
    }),
  );
}
function safeSummary(host: PanelHost) {
  try {
    return host.def.summarize?.(host.result!) ?? null;
  } catch (err) {
    console.error(`[${host.def.id}] summary failed`, err);
    return null;
  }
}
hosts.forEach((host) => host.onChange(renderStrip));
renderStrip();
setInterval(renderStrip, 60_000);

/* ---------- Page */

const noticeSlot = h("div");
const grid = h("main", { class: "grid", id: "main" }, hosts.map((host) => host.el));

document.body.append(
  topbar,
  h(
    "div",
    { class: "shell" },
    noticeSlot,
    h(
      "section",
      { class: "intro", "aria-label": "Overview" },
      h("div", null, h("h1", null, "What’s happening up there"), h("p", null, "Asteroid flybys (also in a 3D Solar System), the Sun’s mood, cosmic explosions, what Webb and Hubble are looking at, newly found worlds and today’s sky picture — fetched live when you ask.")),
      lastAll,
    ),
    liveStatus,
    strip,
    grid,
    h(
      "footer",
      { class: "site-foot" },
      h("span", null, "Data: NASA/JPL SSD-CNEOS (close approaches, SBDB orbits, planetary elements) · NASA DONKI (CCMC) · NOAA SWPC · NASA GCN · STScI & MAST · CDS · NASA Exoplanet Archive (Caltech/IPAC) · NASA APOD. All times UTC unless noted."),
      h("span", null, "Data is fetched when you press a refresh button — or, only while Live mode is on and this tab is visible, automatically."),
    ),
  ),
);

/* ---------- Key notice (the key itself never reaches the browser) */

fetchStatus()
  .then((status) => {
    if (status.nasaKey !== "demo") return;
    const where =
      status.env === "development"
        ? "Paste your key into the .dev.vars file in the project folder and restart the dev server."
        : "Add it in the Cloudflare dashboard as a Worker secret named NASA_API_KEY.";
    noticeSlot.append(
      h(
        "div",
        { class: "notice-bar", role: "status" },
        icon(ICONS.key),
        h("span", null, h("strong", null, "Using NASA’s public DEMO_KEY. "), `Your NASA API key isn’t configured, so api.nasa.gov requests fall back to the shared, rate-limited demo key (currently only the APOD backup feed uses it). ${where}`),
      ),
    );
  })
  .catch(() => {
    /* status is informational only */
  });
