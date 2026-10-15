import type { OrbitsData } from "../../shared/contract";
import { earthPosition, jdTdb, KM_PER_AU, norm, sub, type PlanetId } from "../../shared/orbit";
import { fetchSource } from "../core/api";
import { h, icon, safeUrl } from "../core/dom";
import { fmt, metres, relative, utc } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelResult } from "../core/panel";
import { hideTip, showTip } from "../viz/tooltip";
import type { AsteroidOrbitLayer, Layers, Orrery, SceneState, ViewId } from "../viz/orrery3d";
import {
  agreement, asteroidPosition, asteroidsFrom, AU_PER_LD, BODIES, bodyPositions, earthDistance, fmtDistance, isBodyId, modelApproach,
  planetPeriodDays, TIME_MAX, TIME_MIN, type Asteroid, type BodyId,
} from "../viz/orrery-model";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SPEEDS: [number, string, string][] = [
  [1 / 24, "1 h/s", "1 hour per second"],
  [1, "1 d/s", "1 day per second"],
  [7, "1 wk/s", "1 week per second"],
  [30, "1 mo/s", "30 days per second"],
  [365.25, "1 yr/s", "1 year per second"],
];
const AST_ORBIT_LAYERS: [AsteroidOrbitLayer, string, string][] = [
  ["selected", "Selected", "Only the selected or hovered asteroid’s orbit"],
  ["upcoming", "Upcoming", "Orbits of asteroids whose closest approach is still ahead at the time shown"],
  ["all", "All", "Orbits of every asteroid in the list"],
];
const VIEWS: [ViewId, string, string][] = [
  ["inner", "Inner planets", "Sun to Mars"],
  ["outer", "Outer planets", "Out to Neptune"],
  ["earth", "Near Earth", "Follows Earth: the Moon’s orbit and asteroid flybys"],
];

/**
 * View state that survives a refresh or re-render (the time you were looking at, speed, view,
 * selection). Not saved across visits: every visit starts at "now".
 */
const sim = {
  ms: Date.now(),
  mode: "now" as "now" | "paused" | "playing",
  dir: 1 as 1 | -1,
  rate: 1,
  view: "inner" as ViewId,
  selected: null as string | null,
  layers: { astOrbits: "selected", planetOrbits: true, labels: true } as Layers,
};

function fullUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** "3 d 4 h from now", "2 yr 1 mo ago". */
function offsetText(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const a = Math.abs(diff);
  if (a < 60_000) return "now";
  const parts: string[] = [];
  const y = Math.floor(a / (365.25 * DAY));
  const mo = Math.floor((a - y * 365.25 * DAY) / (30.44 * DAY));
  const d = Math.floor(a / DAY);
  const hrs = Math.floor((a % DAY) / 3_600_000);
  const min = Math.floor((a % 3_600_000) / 60_000);
  if (y >= 1) parts.push(`${y} yr`, ...(mo ? [`${mo} mo`] : []));
  else if (d >= 60) parts.push(`${Math.round(a / (30.44 * DAY))} mo`);
  else if (d >= 1) parts.push(`${d} d`, ...(hrs ? [`${hrs} h`] : []));
  else parts.push(...(hrs ? [`${hrs} h`] : []), `${min} min`);
  return diff > 0 ? `${parts.join(" ")} from now` : `${parts.join(" ")} ago`;
}

function webgl2Available(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

function render(root: HTMLElement, result: PanelResult<OrbitsData>) {
  const { data } = result;
  const asteroids = asteroidsFrom(data);
  const byDes = new Map(asteroids.map((a) => [a.des, a]));
  if (sim.selected?.startsWith("a:") && !byDes.has(sim.selected.slice(2))) sim.selected = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cleanups: (() => void)[] = [];
  let orrery: Orrery | null = null;

  const state = (): SceneState => ({ ms: sim.ms, jd: jdTdb(sim.ms), selected: sim.selected?.startsWith("a:") ? sim.selected.slice(2) : null, view: sim.view, layers: sim.layers });

  /* ---------- Time bar */

  const dateText = h("div", { class: "orrery-date-main mono" });
  const dateSub = h("div", { class: "orrery-date-sub" });
  const announce = h("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const btn = (svg: string, label: string, extra = "") =>
    h("button", { type: "button", class: `btn btn-small ${extra}`, title: label, "aria-label": label }, icon(svg));
  const nowBtn = h("button", { type: "button", class: "btn btn-small", title: "Show the current time and follow the clock" }, icon(ICONS.now), "Now");
  const backBtn = btn(ICONS.reverse, "Play backward");
  const pauseBtn = btn(ICONS.pause, "Pause");
  const fwdBtn = btn(ICONS.play, "Play forward");
  const speedGroup = h("div", { class: "segmented orrery-speed", role: "group", "aria-label": "Playback speed" });
  for (const [rate, label, long] of SPEEDS) {
    const b = h("button", { type: "button", "data-rate": String(rate), title: long, "aria-label": long }, label);
    b.addEventListener("click", () => {
      sim.rate = rate;
      syncControls();
    });
    speedGroup.append(b);
  }
  // Phones: the same speeds as a compact dropdown, so Now, play and speed fit on one row.
  const speedSelect = h("select", { class: "orrery-speed-select", "aria-label": "Playback speed" });
  for (const [rate, label, long] of SPEEDS) {
    const o = h("option", { value: String(rate), title: long }, `${label}`);
    speedSelect.append(o);
  }
  speedSelect.addEventListener("change", () => {
    sim.rate = Number(speedSelect.value);
    syncControls();
  });
  // The date heading is the date picker (the native input sits underneath it, visually hidden).
  const dateInput = h("input", { type: "date", class: "orrery-date-input", min: "1900-01-01", max: "2049-12-31", tabindex: "-1", "aria-hidden": "true" });
  const dateBtn = h("button", { type: "button", class: "orrery-date-btn", "aria-label": "Choose the date to show (UTC)", title: "Choose a date" }, dateText, icon(ICONS.calendar));
  // Pointer taps land on the transparent input over the heading (the only way iOS WebKit opens its
  // picker). Desktop Chromium only opens it from its own icon, so ask for it explicitly; the button
  // underneath keeps keyboard focus and the accessible label (Enter/Space → showPicker).
  const openPicker = () => {
    try {
      dateInput.showPicker();
    } catch {
      /* not supported or not allowed: WebKit's own tap handling still opens it */
    }
  };
  dateInput.addEventListener("click", openPicker);
  dateBtn.addEventListener("click", openPicker);

  const scrub = h("input", { type: "range", class: "orrery-scrub", min: "0", max: "1000", step: "1", "aria-label": "Displayed time within the close-approach window" });
  const scrubMarker = h("span", { class: "orrery-scrub-marker", hidden: true, "aria-hidden": "true" });
  const winStart = new Date(data.windowStart).getTime(), winEnd = new Date(data.windowEnd).getTime();
  const scrubWrap = h(
    "div",
    { class: "orrery-scrub-wrap" },
    h("span", { class: "orrery-scrub-end mono" }, utc(data.windowStart, false)),
    h("div", { class: "orrery-scrub-track" }, scrub, scrubMarker, h("span", { class: "orrery-scrub-now", style: `left:${((Date.now() - winStart) / (winEnd - winStart)) * 100}%`, "aria-hidden": "true" })),
    h("span", { class: "orrery-scrub-end mono" }, utc(data.windowEnd, false)),
  );

  /* ---------- Stage */

  const viewport = h("div", { class: "orrery-viewport", role: "img", "aria-label": "3D view of the Solar System. Use the lists and buttons beside it to select objects and change the time." });
  const viewGroup = h("div", { class: "segmented orrery-views", role: "group", "aria-label": "Camera view" });
  for (const [id, label, long] of VIEWS) {
    const b = h("button", { type: "button", "data-view": id, title: long }, label);
    b.addEventListener("click", () => setView(id));
    viewGroup.append(b);
  }
  const scaleBar = h("div", { class: "orrery-scale", "aria-hidden": "true", hidden: true }, h("span", { class: "bar" }), h("span", { class: "txt" }));
  const hint = h(
    "div",
    { class: "orrery-hint" },
    h("span", { class: "long" }, "Drag to rotate · right-drag or shift+drag to pan (trackpad: two-finger click-drag) · scroll or pinch to zoom · click an object"),
    h("span", { class: "short" }, "One finger: rotate · two fingers: pan and pinch to zoom · tap an object"),
  );
  const status = h("div", { class: "orrery-status" }, h("p", null, "Preparing the 3D view…"));
  viewport.append(status);

  /* Layers: a small popover over the view (asteroid orbits, planet orbits, labels). */
  const layersBtn = h(
    "button",
    { type: "button", class: "btn btn-small orrery-layers-btn", "aria-expanded": "false", "aria-controls": "orrery-layers", title: "Choose what the view draws" },
    icon(ICONS.layers),
    h("span", { class: "txt" }, "Layers"),
  );
  const astOrbitGroup = h("div", { class: "segmented", role: "group", "aria-label": "Asteroid orbits" });
  for (const [id, label, long] of AST_ORBIT_LAYERS) {
    const b = h("button", { type: "button", "data-layer": id, title: long }, label);
    b.addEventListener("click", () => {
      sim.layers.astOrbits = id;
      syncControls();
      orrery?.invalidate();
    });
    astOrbitGroup.append(b);
  }
  const check = (text: string, key: "planetOrbits" | "labels") => {
    const input = h("input", { type: "checkbox" });
    input.checked = sim.layers[key];
    input.addEventListener("change", () => {
      sim.layers[key] = input.checked;
      orrery?.invalidate();
    });
    return h("label", { class: "orrery-check" }, input, text);
  };
  const layersPanel = h(
    "div",
    { class: "orrery-layers", id: "orrery-layers", role: "group", "aria-label": "Layers", hidden: true },
    h("div", { class: "orrery-layers-label" }, "Asteroid orbits"),
    astOrbitGroup,
    check("Planet orbits", "planetOrbits"),
    check("Labels", "labels"),
  );
  let layersOpen = false;
  const setLayersOpen = (open: boolean) => {
    layersOpen = open;
    layersPanel.hidden = !open;
    layersBtn.setAttribute("aria-expanded", String(open));
  };
  layersBtn.addEventListener("click", () => setLayersOpen(!layersOpen));
  const onDocDown = (ev: PointerEvent) => {
    if (layersOpen && !layersPanel.contains(ev.target as Node) && !layersBtn.contains(ev.target as Node)) setLayersOpen(false);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && layersOpen) {
      setLayersOpen(false);
      layersBtn.focus();
    }
  };
  document.addEventListener("pointerdown", onDocDown);
  document.addEventListener("keydown", onKey);
  cleanups.push(() => {
    document.removeEventListener("pointerdown", onDocDown);
    document.removeEventListener("keydown", onKey);
  });

  const recenterBtn = h("button", { type: "button", class: "btn btn-small orrery-recenter", hidden: true }, icon(ICONS.recenter), "Re-centre");
  recenterBtn.addEventListener("click", () => orrery?.recenter());
  viewport.append(recenterBtn);
  const tools = h("div", { class: "orrery-tools" }, layersBtn, layersPanel);
  const stage = h(
    "div",
    { class: "orrery-stage" },
    h("div", { class: "orrery-stage-top" }, viewGroup, tools),
    viewport,
    h("div", { class: "orrery-stage-bottom" }, scaleBar, hint),
  );

  /* ---------- Side: details + list */

  const details = h("div", { class: "orrery-details", "aria-live": "polite" });
  const list = h("ol", { class: "orrery-list", "aria-label": "Asteroids in the close-approach window, by date of closest approach" });
  const rows = new Map<string, { li: HTMLLIElement; now: HTMLElement; button: HTMLButtonElement }>();
  for (const a of [...asteroids].sort((x, y) => x.caMs - y.caMs)) {
    const now = h("small", null, "");
    const b = h(
      "button",
      { type: "button", class: "orrery-row", "aria-pressed": "false", disabled: !a.orbit },
      h("span", { class: "name" }, a.label, a.approach.pha ? h("span", { class: "status-tag", style: "--tag:var(--series-2)" }, "PHA") : null),
      h("span", { class: "sub" }, `${utc(new Date(a.caMs))} · ${relative(new Date(a.caMs).toISOString())}`),
      h("span", { class: "value" }, `${fmt.fixed(a.approach.distLd, 2)} LD`, now),
    );
    b.title = a.orbit ? `Select ${a.label}` : "No orbit available from JPL for this object";
    b.addEventListener("click", () => select(`a:${a.des}`));
    // Hovering a row previews its orbit (and near Earth, its path) in the view.
    b.addEventListener("pointerenter", (ev) => {
      if (ev.pointerType === "mouse" && a.orbit) orrery?.setHover(`a:${a.des}`);
    });
    b.addEventListener("pointerleave", () => orrery?.setHover(null));
    const li = h("li", null, b);
    list.append(li);
    rows.set(a.des, { li, now, button: b });
  }
  const placed = asteroids.filter((a) => a.orbit).length;
  const side = h(
    "aside",
    { class: "orrery-side" },
    details,
    h("h3", { class: "section-title" }, `Close-approach asteroids (${placed}${placed < asteroids.length ? ` of ${asteroids.length}` : ""})`),
    h("p", { class: "orrery-list-note" }, "Closest approach (official, CNEOS) · distance from Earth at the time shown (this view’s estimate)"),
    list,
  );

  root.append(
    h(
      "div",
      { class: "orrery" },
      h(
        "div",
        { class: "orrery-timebar" },
        h("div", { class: "orrery-date" }, h("div", { class: "orrery-date-pick" }, dateBtn, dateInput), dateSub),
        h(
          "div",
          { class: "orrery-transport" },
          h("div", { class: "orrery-group" }, nowBtn),
          h("div", { class: "orrery-group", role: "group", "aria-label": "Playback" }, backBtn, pauseBtn, fwdBtn, speedGroup, speedSelect),
        ),
      ),
      scrubWrap,
      h("div", { class: "orrery-layout" }, stage, side),
      h(
        "ul",
        { class: "legend" },
        h("li", null, h("span", { class: "swatch", style: "--c:var(--sun)" }), "Sun"),
        h("li", null, h("span", { class: "swatch", style: "--c:var(--series-3)" }), "Earth"),
        h("li", null, h("span", { class: "swatch", style: "--c:var(--ink-2)" }), "Planets, Moon"),
        h("li", null, h("span", { class: "swatch line thick", style: "--c:var(--ink-2)" }), "Planet orbit"),
        h("li", null, h("span", { class: "swatch small", style: "--c:var(--series-1)" }), "Asteroid, approaching"),
        h("li", null, h("span", { class: "swatch small", style: "--c:var(--series-2)" }), "Potentially hazardous (PHA)"),
        h("li", null, h("span", { class: "swatch small", style: "--c:var(--series-1);opacity:.4" }), h("span", { class: "swatch small", style: "--c:var(--series-2);opacity:.4" }), "Closest approach already passed (at the time shown)"),
        h("li", null, h("span", { class: "swatch line", style: "--c:var(--series-1);opacity:.6" }), "Asteroid orbit (selected or hovered; more under Layers)"),
      ),
      h(
        "p",
        { class: "footnote orrery-honesty" },
        h("strong", null, "Distances are to scale; the dots are not. "),
        "At true size every planet would be far smaller than a pixel at these distances, so bodies are drawn as fixed-size dots; zoom in close (try Near Earth) and Earth, the Moon and the Sun appear as true-size spheres. ",
        h("strong", null, "Positions are computed in your browser and are approximate: "),
        "planets from JPL’s published Keplerian elements (Standish; fitted for 1800–2050, errors from about 1,000 km for Venus to ~3 million km for Saturn — far below a pixel here), the Moon from the main terms of Meeus’ lunar theory (~0.01°), asteroids as two-body orbits from JPL Small-Body Database elements (no planetary pulls). For close approaches the official CNEOS time and distance are always shown next to this view’s own estimate. In Near Earth view the dashed path is the selected (or hovered) asteroid’s motion relative to Earth (dots one day apart); the dashed ring is CNEOS’ 0.05 au (19.5 LD) close-approach limit.",
      ),
      announce,
    ),
  );

  /* ---------- Behaviour */

  function syncControls() {
    pauseBtn.disabled = sim.mode !== "playing";
    fwdBtn.setAttribute("aria-pressed", String(sim.mode === "playing" && sim.dir === 1));
    backBtn.setAttribute("aria-pressed", String(sim.mode === "playing" && sim.dir === -1));
    nowBtn.setAttribute("aria-pressed", String(sim.mode === "now"));
    for (const b of speedGroup.querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === sim.rate));
    speedSelect.value = String(sim.rate);
    for (const b of viewGroup.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.view === sim.view));
    for (const b of astOrbitGroup.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.layer === sim.layers.astOrbits));
  }

  let lastListUpdate = 0;
  function onTime(force = false) {
    sim.ms = Math.min(TIME_MAX, Math.max(TIME_MIN, sim.ms));
    dateText.textContent = fullUtc(sim.ms);
    const off = offsetText(sim.ms);
    const sub: Node[] = [sim.mode === "now" ? h("span", { class: "status-tag", style: "--tag:var(--good)" }, "Now · following the clock") : h("span", null, off)];
    if (sim.mode === "playing") sub.push(h("span", null, ` · playing ${sim.dir < 0 ? "backward" : "forward"} at ${SPEEDS.find(([r]) => r === sim.rate)?.[1] ?? ""}`));
    if (Math.abs(sim.ms - Date.now()) > 365 * DAY) sub.push(h("span", { class: "orrery-far" }, " · asteroid positions are rough this far from now"));
    dateSub.replaceChildren(...sub);
    if (force && document.activeElement !== dateInput) dateInput.value = new Date(sim.ms).toISOString().slice(0, 10);
    const k = (sim.ms - winStart) / (winEnd - winStart);
    scrub.value = String(Math.round(Math.min(1, Math.max(0, k)) * 1000));
    scrub.classList.toggle("is-outside", k < 0 || k > 1);
    const now = performance.now();
    if (force || now - lastListUpdate > 250) {
      lastListUpdate = now;
      const jd = jdTdb(sim.ms);
      const earth = earthPosition(jd);
      for (const a of asteroids) {
        const d = earthDistance(a, jd, earth);
        const row = rows.get(a.des)!;
        row.now.textContent = d === null ? "no orbit" : `${fmtDistance(d)} at time shown`;
        row.li.classList.toggle("is-past", a.caMs < sim.ms);
      }
      renderDetails();
    }
    orrery?.invalidate();
  }

  function say(text: string) {
    announce.textContent = text;
  }

  function setMode(mode: typeof sim.mode, dir: 1 | -1 = sim.dir) {
    sim.mode = mode;
    sim.dir = dir;
    if (mode === "now") sim.ms = Date.now();
    syncControls();
    onTime(true);
    if (mode === "playing") startPlayback();
    else say(`Showing ${fullUtc(sim.ms)}`);
  }

  function jumpTo(ms: number) {
    sim.mode = "paused";
    sim.ms = ms;
    syncControls();
    onTime(true);
    say(`Showing ${fullUtc(sim.ms)}`);
  }

  function setView(view: ViewId) {
    sim.view = view;
    syncControls();
    orrery?.goTo(view);
  }

  function select(id: string, opts: { scroll?: boolean } = {}) {
    sim.selected = id;
    for (const [des, r] of rows) {
      const on = id === `a:${des}`;
      r.button.setAttribute("aria-pressed", String(on));
      r.li.classList.toggle("is-selected", on);
      // Scroll only the list (scrollIntoView would also move the page).
      if (on && opts.scroll !== false) {
        const top = r.li.offsetTop; // the list is the offset parent (position: relative)
        if (top < list.scrollTop || top + r.li.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTo({ top: top - list.clientHeight / 2 + r.li.offsetHeight / 2, behavior: reducedMotion ? "auto" : "smooth" });
        }
      }
    }
    // Mark the selected asteroid's closest approach on the time slider.
    const sel = id.startsWith("a:") ? byDes.get(id.slice(2)) : undefined;
    const k = sel ? (sel.caMs - winStart) / (winEnd - winStart) : -1;
    scrubMarker.hidden = !(k >= 0 && k <= 1);
    scrubMarker.style.left = `${k * 100}%`;
    renderDetails();
    orrery?.invalidate();
  }

  /* Playback: one rAF loop that only runs while playing and visible. */
  let playRaf = 0, lastT = 0;
  function startPlayback() {
    if (playRaf || sim.mode !== "playing" || !visible) return;
    lastT = performance.now();
    const step = (t: number) => {
      playRaf = 0;
      if (sim.mode !== "playing" || !visible) return;
      const dt = Math.min(0.1, (t - lastT) / 1000); // a long gap (tab switch) doesn't jump ahead
      lastT = t;
      sim.ms += sim.dir * sim.rate * DAY * dt;
      if (sim.ms <= TIME_MIN || sim.ms >= TIME_MAX) {
        setMode("paused");
        say("Reached the end of the supported date range (1900–2049).");
        return;
      }
      onTime();
      playRaf = requestAnimationFrame(step);
    };
    playRaf = requestAnimationFrame(step);
  }
  function stopPlayback() {
    cancelAnimationFrame(playRaf);
    playRaf = 0;
  }

  nowBtn.addEventListener("click", () => setMode("now"));
  fwdBtn.addEventListener("click", () => setMode("playing", 1));
  backBtn.addEventListener("click", () => setMode("playing", -1));
  pauseBtn.addEventListener("click", () => setMode("paused"));
  dateInput.addEventListener("change", () => {
    const [y, m, d] = dateInput.value.split("-").map(Number);
    if (!y || !m || !d) return;
    jumpTo(Date.UTC(y, m - 1, d, 0, 0));
  });
  scrub.addEventListener("input", () => {
    sim.mode = "paused";
    sim.ms = winStart + (Number(scrub.value) / 1000) * (winEnd - winStart);
    syncControls();
    onTime();
  });
  scrub.addEventListener("change", () => say(`Showing ${fullUtc(sim.ms)}`));

  /* "Now" follows the clock (once a second is plenty: positions move < 1 px per minute). */
  const clock = window.setInterval(() => {
    if (sim.mode === "now" && visible) {
      sim.ms = Date.now();
      onTime();
    }
  }, 1000);
  cleanups.push(() => clearInterval(clock));

  /* ---------- Details card */

  function renderDetails() {
    const id = sim.selected;
    const jd = jdTdb(sim.ms);
    if (!id) {
      details.replaceChildren(h("p", { class: "orrery-empty" }, "Tap an asteroid or planet in the view, or pick an asteroid from the list, to see where it is and how close it comes."));
      return;
    }
    if (id.startsWith("a:")) {
      const a = byDes.get(id.slice(2));
      if (a) details.replaceChildren(asteroidCard(a, jd));
      return;
    }
    if (isBodyId(id)) details.replaceChildren(bodyCard(id, jd));
  }

  function row(k: string, v: Node | string) {
    return [h("dt", null, k), h("dd", null, v)];
  }

  function asteroidCard(a: Asteroid, jd: number): HTMLElement {
    const ap = a.approach;
    const m = modelApproach(a);
    const ag = agreement(m);
    const dNow = earthDistance(a, jd);
    const p = asteroidPosition(a, jd);
    const tag = ag === "good" ? ["var(--good)", "matches the official approach"] : ag === "fair" ? ["var(--warning)", "close to the official approach"] : ["var(--serious)", "differs from the official approach — rough only"];
    const epochAgeDays = a.orbit ? Math.abs(jd - a.orbit.epoch) : 0;
    const linkStatus = h("span", { class: "orrery-link-status", role: "status" });
    const jumpBtn = h("button", { type: "button", class: "btn btn-small" }, "Jump to closest approach");
    jumpBtn.addEventListener("click", () => {
      jumpTo(a.caMs);
      if (sim.view !== "earth") setView("earth");
    });
    const neoBtn = h("button", { type: "button", class: "btn btn-small" }, "Show in close-approach chart");
    neoBtn.addEventListener("click", () => {
      const detail = { des: a.des, found: false };
      window.dispatchEvent(new CustomEvent("astro:show-in-neo", { detail }));
      linkStatus.textContent = detail.found ? "" : "Not in the close-approach panel’s current data — refresh that panel first.";
    });
    const sbdb = safeUrl(ap.sbdbUrl);
    const size = ap.diameterKm ? `${metres(ap.diameterKm)} (measured)` : ap.estDiameterKm ? `${metres(ap.estDiameterKm.min)}–${metres(ap.estDiameterKm.max)} (from brightness)` : "unknown";
    return h(
      "div",
      { class: "orrery-card" },
      h("h3", null, a.label, ap.pha ? h("span", { class: "status-tag", style: "--tag:var(--series-2)" }, "PHA") : null),
      h(
        "dl",
        null,
        row("At the time shown", dNow === null || !p ? "no orbit available" : `${fmtDistance(dNow)} from Earth (${fmt.compact(dNow * KM_PER_AU)} km) · ${fmt.fixed(norm(p), 3)} au from the Sun`),
        row(
          "Closest approach",
          h(
            "span",
            null,
            `${utc(new Date(a.caMs))} (${relative(new Date(a.caMs).toISOString())}) · ${fmt.fixed(ap.distLd, 2)} LD (${fmt.compact(ap.distKm)} km) · ${fmt.fixed(ap.vRelKms, 1)} km/s`,
            h("small", null, `Official CNEOS values (full n-body orbit), time uncertainty ${ap.timeSigma ? ap.timeSigma.replace(/^(\d+)_/, "$1 d ") : "—"}`),
          ),
        ),
        m
          ? row(
              "This view’s estimate",
              h(
                "span",
                null,
                `${fmt.fixed(m.distAu / AU_PER_LD, 2)} LD, ${Math.abs(m.dtHours) < 1 / 60 ? "same minute" : `${fmtHours(Math.abs(m.dtHours))} ${m.dtHours > 0 ? "later" : "earlier"}`} `,
                h("span", { class: "status-tag", style: `--tag:${tag[0]}` }, tag[1]!),
              ),
            )
          : null,
        a.orbit
          ? row(
              "Orbit",
              `JPL solution ${a.orbit.orbitId || "—"} · condition code ${a.orbit.conditionCode ?? "—"} (0 = best, 9 = most uncertain) · ${a.orbit.dataArcDays === null ? "arc unknown" : `${fmt.int(a.orbit.dataArcDays)}-day arc`} · elements for ${utc(new Date(msFromJd(a.orbit.epoch)), false)} ${new Date(msFromJd(a.orbit.epoch)).getUTCFullYear()}`,
            )
          : null,
        row("Size", size),
      ),
      epochAgeDays > 365
        ? h("p", { class: "orrery-warn" }, "The time shown is more than a year from this orbit’s epoch; without planetary pulls the position is increasingly rough.")
        : null,
      h(
        "div",
        { class: "orrery-actions" },
        jumpBtn,
        neoBtn,
        sbdb ? h("a", { class: "btn btn-small btn-quiet", href: sbdb, target: "_blank", rel: "noopener" }, "JPL SBDB", icon(ICONS.external)) : null,
      ),
      linkStatus,
    );
  }

  function bodyCard(id: BodyId, jd: number): HTMLElement {
    const b = BODIES.find((x) => x.id === id)!;
    const pos = bodyPositions(jd);
    const fromSun = norm(pos[id]);
    const fromEarth = norm(sub(pos[id], pos.earth));
    const lightMin = (fromEarth * KM_PER_AU) / 299_792.458 / 60;
    const rowsOut: Node[][] = [];
    if (id !== "sun") rowsOut.push(row("From the Sun", `${fmt.fixed(fromSun, 3)} au (${fmt.compact(fromSun * KM_PER_AU)} km)`));
    if (id !== "earth") rowsOut.push(row("From Earth", id === "moon" ? `${fmt.int(fromEarth * KM_PER_AU)} km (${fmt.fixed(fromEarth / AU_PER_LD, 3)} LD)` : `${fmt.fixed(fromEarth, 3)} au · light takes ${lightMin < 60 ? `${fmt.fixed(lightMin, 1)} min` : `${fmt.fixed(lightMin / 60, 1)} h`}`));
    if (b.planet) rowsOut.push(row("Orbital period", `${fmt.int(planetPeriodDays(b.planet as PlanetId, jd))} days`));
    rowsOut.push(row("Radius", `${fmt.int(b.radiusKm)} km`));
    const note =
      id === "moon" ? "Main terms of Meeus’ lunar theory (~0.01°, a few dozen km)." : id === "sun" ? "The centre of the view’s frame (heliocentric, ecliptic J2000)." : "JPL approximate elements, Table 1 (valid 1800–2050).";
    return h("div", { class: "orrery-card" }, h("h3", null, b.name), h("dl", null, rowsOut), h("p", { class: "footnote" }, note));
  }

  /* ---------- Links with the close-approach panel */

  const onShowIn3d = (ev: Event) => {
    const des = (ev as CustomEvent<{ des: string; found?: boolean }>).detail.des;
    if (!byDes.get(des)?.orbit) return;
    (ev as CustomEvent<{ found?: boolean }>).detail.found = true;
    select(`a:${des}`);
    if (sim.view !== "earth") setView("earth");
    root.closest(".panel")?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  };
  window.addEventListener("astro:show-in-3d", onShowIn3d);
  cleanups.push(() => window.removeEventListener("astro:show-in-3d", onShowIn3d));

  /* ---------- Lazy 3D: load three.js only when the view is on screen; pause when hidden */

  let onScreen = false;
  let visible = false;
  let loading = false;
  function updateVisible() {
    const v = onScreen && !document.hidden;
    if (v === visible) return;
    visible = v;
    orrery?.setActive(v);
    if (v) {
      if (sim.mode === "now") {
        sim.ms = Date.now();
        onTime(true);
      }
      startPlayback();
      if (!orrery && !loading) void start3d();
    } else stopPlayback();
  }
  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    updateVisible();
  }, { rootMargin: "120px 0px" });
  io.observe(viewport);
  const onVis = () => updateVisible();
  document.addEventListener("visibilitychange", onVis);
  cleanups.push(() => {
    io.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    stopPlayback();
  });

  function showStatus(title: string, text: string, retry = false) {
    const p = h("div", null, h("p", { class: "orrery-status-title" }, title), h("p", null, text));
    if (retry) {
      const b = h("button", { type: "button", class: "btn btn-small" }, icon(ICONS.refresh), "Try again");
      b.addEventListener("click", () => void start3d());
      p.append(b);
    }
    status.replaceChildren(p);
    status.hidden = false;
    viewport.classList.add("is-fallback");
    viewGroup.hidden = true;
    tools.hidden = true;
  }

  async function start3d() {
    if (!webgl2Available()) {
      showStatus(
        "3D view unavailable on this device",
        "Your browser has WebGL 2 turned off or doesn’t support it, so the 3D view can’t be drawn. Everything else here still works: the time controls, the asteroid list and each object’s distances and closest approach.",
      );
      return;
    }
    loading = true;
    status.replaceChildren(h("p", null, "Loading the 3D view…"));
    status.hidden = false;
    try {
      const mod = await import("../viz/orrery3d");
      if (!root.isConnected) return;
      orrery = mod.createOrrery({
        container: viewport,
        asteroids,
        getState: state,
        reducedMotion,
        onPick: (id) => select(id),
        onHover: (id, x, y) => {
          if (!id) return hideTip();
          showTip(hoverTip(id), x, y);
        },
        onScale: (text, px) => {
          scaleBar.hidden = false;
          (scaleBar.firstChild as HTMLElement).style.width = `${Math.round(px)}px`;
          (scaleBar.lastChild as HTMLElement).textContent = `${text} (at the centre of view)`;
        },
        onPanChange: (panned) => {
          recenterBtn.hidden = !panned;
          const centre = sim.view === "earth" ? "Earth" : "the Sun";
          recenterBtn.title = `Pan back to ${centre} and follow it again`;
          if (panned) say(`Panned away from ${centre}. Use Re-centre to return.`);
        },
        onContextLost: () => {
          orrery?.destroy();
          orrery = null;
          scaleBar.hidden = true;
          recenterBtn.hidden = true;
          showStatus("The 3D view stopped", "The browser reclaimed the graphics context (this can happen on phones when memory runs low).", true);
        },
      });
      status.hidden = true;
      viewport.classList.remove("is-fallback");
      viewGroup.hidden = false;
      tools.hidden = false;
      orrery.goTo(sim.view, false);
      orrery.setActive(visible);
    } catch (err) {
      console.error("[solarsystem] 3D view failed", err);
      orrery = null;
      showStatus("The 3D view couldn’t start", "Its code didn’t load or the graphics driver refused. Check your connection and try again; the list and details still work.", true);
    } finally {
      loading = false;
    }
  }

  function hoverTip(id: string) {
    const jd = jdTdb(sim.ms);
    if (id.startsWith("a:")) {
      const a = byDes.get(id.slice(2))!;
      const d = earthDistance(a, jd);
      return {
        title: a.label,
        rows: [
          ["At time shown", d === null ? "—" : `${fmtDistance(d)} from Earth`],
          ["Closest", `${utc(new Date(a.caMs))} · ${fmt.fixed(a.approach.distLd, 2)} LD`],
        ] as [string, string][],
        note: "Click for details",
      };
    }
    const b = BODIES.find((x) => x.id === id)!;
    const pos = bodyPositions(jd);
    return { title: b.name, rows: [["From the Sun", `${fmt.fixed(norm(pos[b.id]), 3)} au`]] as [string, string][] };
  }

  const onTheme = () => orrery?.refreshTheme();
  window.addEventListener("themechange", onTheme);
  cleanups.push(() => window.removeEventListener("themechange", onTheme));

  syncControls();
  if (sim.selected) select(sim.selected, { scroll: false });
  if (sim.mode === "now") sim.ms = Date.now();
  dateInput.value = new Date(sim.ms).toISOString().slice(0, 10);
  onTime(true);

  return () => {
    for (const fn of cleanups) fn();
    hideTip();
    orrery?.destroy();
    orrery = null;
  };
}

function msFromJd(jd: number): number {
  return (jd - 2440587.5) * DAY;
}

function fmtHours(hrs: number): string {
  if (hrs < 1) return `${Math.round(hrs * 60)} min`;
  if (hrs < 48) return `${fmt.fixed(hrs, 1)} h`;
  return `${fmt.fixed(hrs / 24, 1)} d`;
}

export const solarSystemPanel: PanelDefinition<OrbitsData> = {
  id: "solarsystem",
  title: "Solar System in 3D",
  subtitle: "Sun, planets, the Moon and the close-approach asteroids at their computed positions — now, played forward or back, or on any date 1900–2049",
  icon: ICONS.orbit,
  span: "span-12",
  source: { name: "JPL SSD: planetary elements · SBDB orbits · CNEOS close approaches", url: "https://ssd.jpl.nasa.gov/planets/approx_pos.html" },

  async load(signal): Promise<PanelResult<OrbitsData>> {
    const env = await fetchSource("orbits", {}, signal);
    return { data: env.data, fetchedAt: env.fetchedAt, upstream: env.upstream, notices: env.notices };
  },

  render,

  summarize({ data }) {
    const now = Date.now();
    const jd = jdTdb(now);
    const earth = earthPosition(jd);
    let best: { a: Asteroid; d: number } | null = null;
    for (const a of asteroidsFrom(data)) {
      const d = earthDistance(a, jd, earth);
      if (d !== null && (!best || d < best.d)) best = { a, d };
    }
    if (!best) return null;
    return {
      label: "Nearest tracked asteroid now",
      icon: ICONS.orbit,
      value: best.a.label,
      detail: `${fmtDistance(best.d)} from Earth (two-body estimate) · closest ${relative(new Date(best.a.caMs).toISOString(), now)}`,
    };
  },
};

