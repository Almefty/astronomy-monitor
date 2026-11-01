import type { SatellitesData } from "../../shared/contract";
import {
  browserTimeZone, compassPoint, moonPhase, nightDate, nightEvents, PRESET_PLACES, roundCoordinate, skyPosition, SKY_PLANETS, timeZoneOffset,
  toObserver, type NightEvent, type Observer, type SkyPlanet,
} from "../../shared/sky";
import { ApiError, fetchSource, isRateLimited } from "../core/api";
import { clear, h, icon, s } from "../core/dom";
import { age, utc } from "../core/format";
import { ICONS } from "../core/icons";
import type { PanelDefinition, PanelResult, RenderContext } from "../core/panel";
import { load as loadStored, remove as removeStored, save as saveStored } from "../core/storage";
// Types only: satellite.js (inside passes.ts) is loaded with import() when there is something to predict.
import type { PassPrediction, VisiblePass } from "../viz/passes";
import {
  dayLabel, fmtMag, formatCoords, hhmm, LOCATION_KEY, parseCoordinate, parseLocation, passTimes, utcOffsetLabel, type SkyLocation,
  BODY_NAMES, computeTonight, DARK_SUN_ALT, domeAngle, domePoint, MIN_PLANET_ALT, moonLitBearing, NAKED_EYE_MAG, nightSentences,
  skyBearing, skyState, SKY_STATE_TEXT, whereInSky, type AltAz, type Interval, type PlanetTonight, type RiseSet, type Tonight,
} from "../viz/sky-model";
import { hideTip, showTip, showTipAt, type TipContent } from "../viz/tooltip";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** How many passes the list shows before "Show all". */
const PASSES_SHOWN = 6;

export interface SkyData {
  /** Spacecraft orbital elements (CelesTrak), or null until the visitor loads them. */
  satellites: SatellitesData | null;
  /** Why the last load of the elements failed (the rest of the panel keeps working). */
  error: { message: string; hint: string | null } | null;
}

/* ------------------------------------------------------------------ */
/* Location (kept in this browser only)                                */
/* ------------------------------------------------------------------ */

/** The location as stored: coordinates rounded to 0.01° (~1 km), nothing else about the visitor. */
function storeLocation(loc: SkyLocation | null) {
  if (!loc) removeStored(LOCATION_KEY);
  else saveStored(LOCATION_KEY, { ...loc, lat: roundCoordinate(loc.lat), lon: roundCoordinate(loc.lon) });
}

/* ------------------------------------------------------------------ */
/* View state (survives re-renders; not saved across visits)           */
/* ------------------------------------------------------------------ */

const view = {
  loc: parseLocation(loadStored(LOCATION_KEY)),
  /** The time the dome shows, or null to follow the clock. */
  ms: null as number | null,
  /** The night the dome shows ("YYYY-MM-DD"), or null for tonight. */
  domeNight: null as string | null,
  /** The selected pass: `${satId}:${start ms}`. */
  passKey: null as string | null,
  showAllPasses: false,
  pickerOpen: false,
};

const observerOf = (loc: SkyLocation): Observer => ({ lat: loc.lat, lon: loc.lon });
const zoneOf = (loc: SkyLocation): string => loc.timeZone ?? browserTimeZone();

/** tonight cache: computing a night takes ~15–20 ms, and the strip summary asks every minute. */
let tonightCache: { key: string; value: Tonight } | null = null;
function tonightFor(loc: SkyLocation, now: number): Tonight {
  const obs = observerOf(loc);
  const key = `${loc.lat},${loc.lon},${nightDate(now, obs)}`;
  if (tonightCache?.key !== key) {
    performance.mark("sky:tonight:start");
    tonightCache = { key, value: computeTonight(obs, now) };
    performance.measure("sky:tonight", "sky:tonight:start");
  }
  return tonightCache.value;
}

/** The last pass prediction (also read by the strip summary). */
let passCache: { key: string; prediction: PassPrediction } | null = null;
const passCacheKey = (loc: SkyLocation, fetchedAt: string, date: string) => `${loc.lat},${loc.lon}|${fetchedAt}|${date}`;
const passId = (p: VisiblePass) => `${p.satId}:${p.start.ms}`;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "rises 18:39, sets 02:10" in time order. */
function riseSetText(rs: RiseSet, tz: string, sep: string): string {
  const items: [number, string][] = [];
  if (rs.rise !== null) items.push([rs.rise, `rises ${hhmm(rs.rise, tz)}`]);
  if (rs.set !== null) items.push([rs.set, `sets ${hhmm(rs.set, tz)}`]);
  return items.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(sep);
}

function eventTime(e: NightEvent, tz: string): string {
  return e.state === "time" ? hhmm(e.ms, tz) : "—";
}

function intervalText([a, b]: Interval, tz: string): string {
  return `${hhmm(a, tz)}–${hhmm(b, tz)}`;
}

/* ------------------------------------------------------------------ */
/* SVG pieces                                                          */
/* ------------------------------------------------------------------ */

/**
 * The Moon's disk with its lit part: `illuminated` fraction, lit side pointing `rotate` degrees
 * clockwise from up. Drawn with the lit limb up, then rotated.
 */
export function moonGlyph(cx: number, cy: number, r: number, illuminated: number, rotate: number): SVGGElement {
  const g = s("g", { class: "sky-moon", transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rotate.toFixed(1)})` });
  g.append(s("circle", { r, class: "sky-moon-dark" }));
  const k = Math.max(0, Math.min(1, illuminated));
  if (k > 0.005) {
    const b = (r * Math.abs(2 * k - 1)).toFixed(2);
    // Lit limb: the upper semicircle; terminator: half an ellipse back, bulging down when gibbous.
    g.append(s("path", { class: "sky-moon-lit", d: `M${-r},0A${r},${r} 0 0 1 ${r},0A${r},${b} 0 0 ${k > 0.5 ? 1 : 0} ${-r},0Z` }));
  }
  g.append(s("circle", { r, class: "sky-moon-rim" }));
  return g;
}

function sunGlyph(x: number, y: number): SVGGElement {
  const g = s("g", { class: "sky-sun" });
  g.append(s("circle", { cx: x, cy: y, r: 7 }));
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    g.append(s("line", { x1: x + Math.cos(a) * 10, y1: y + Math.sin(a) * 10, x2: x + Math.cos(a) * 13, y2: y + Math.sin(a) * 13 }));
  }
  return g;
}

/** Dot radius on the dome for a magnitude (brighter = larger). */
const dotRadius = (mag: number | null) => Math.max(2.2, Math.min(6.5, 4.4 - 0.75 * (mag ?? 6)));

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

type PassesModule = typeof import("../viz/passes");
let passesModule: Promise<PassesModule> | null = null;
function loadPasses(): Promise<PassesModule> {
  passesModule ??= import("../viz/passes").catch((err) => {
    passesModule = null;
    throw err;
  });
  return passesModule;
}

function render(root: HTMLElement, result: PanelResult<SkyData>, ctx: RenderContext): () => void {
  const cleanups: (() => void)[] = [];
  const locRow = h("div", { class: "sky-loc" });
  const picker = h("div", { class: "sky-picker", id: "sky-picker" });
  const content = h("div", { class: "sky-content" });
  root.append(h("div", { class: "sky" }, locRow, picker, content));
  let token = 0;
  /** Redraws for the clock: the pass list (and dome) once passes are known, else the dome alone. */
  const ticker = { passes: null as (() => void) | null, dome: null as { draw(): void } | null };

  function setLocation(loc: SkyLocation | null) {
    view.loc = loc;
    view.ms = null;
    view.domeNight = null;
    view.passKey = null;
    view.showAllPasses = false;
    view.pickerOpen = false;
    storeLocation(loc);
    build();
    ctx.notify();
  }

  /* ---------- Location row and picker */

  function buildLocation() {
    const loc = view.loc;
    clear(locRow);
    if (loc) {
      const tz = zoneOf(loc);
      const off = utcOffsetLabel(Date.now(), tz);
      const zone = off === tz ? tz : `${tz} (${off})`;
      const zoneText = loc.timeZone ? `Times in ${zone}` : `Times in your browser’s time zone, ${zone}`;
      // A place far from the zone's own longitude: say so, the times are still right but may look odd.
      const solarOffsetH = loc.lon / 15 - timeZoneOffset(Date.now(), tz) / 60;
      const change = h(
        "button",
        { type: "button", class: "btn btn-small", "aria-expanded": String(view.pickerOpen), "aria-controls": "sky-picker" },
        icon(ICONS.pin),
        view.pickerOpen ? "Close" : "Change location",
      );
      change.addEventListener("click", () => {
        view.pickerOpen = !view.pickerOpen;
        buildLocation();
        buildPicker();
        if (view.pickerOpen) picker.querySelector<HTMLElement>("button, input")?.focus();
      });
      locRow.append(
        h(
          "div",
          { class: "sky-loc-text" },
          h("strong", null, loc.name ?? (loc.kind === "device" ? "Your location" : "Chosen coordinates")),
          h("span", { class: "mono" }, formatCoords(loc.lat, loc.lon)),
          h("span", null, zoneText),
          Math.abs(solarOffsetH) > 3 ? h("span", { class: "sky-zone-warn" }, "This place is far from that time zone; times are still shown in it.") : null,
        ),
        change,
      );
    } else {
      locRow.append(
        h(
          "div",
          { class: "sky-intro" },
          h("p", null, h("strong", null, "Where are you looking from? "), "Pick a place to see when it gets dark, the Moon, which planets are up and when the ISS, Tiangong and Hubble pass over."),
        ),
      );
    }
  }

  function buildPicker() {
    clear(picker);
    picker.hidden = !!view.loc && !view.pickerOpen;
    if (picker.hidden) return;
    const status = h("p", { class: "sky-picker-status", role: "status", "aria-live": "polite" });

    const geoBtn = h("button", { type: "button", class: "btn btn-small" }, icon(ICONS.pin), "Use my location");
    if (!("geolocation" in navigator) || !window.isSecureContext) {
      geoBtn.disabled = true;
      geoBtn.title = "Your browser doesn’t offer location here";
    }
    geoBtn.addEventListener("click", () => {
      geoBtn.disabled = true;
      geoBtn.classList.add("is-busy");
      status.textContent = "Asking your browser for your location…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const obs = toObserver(pos.coords.latitude, pos.coords.longitude);
          if (!obs) {
            status.textContent = "Your browser returned an unusable position.";
            return;
          }
          setLocation({ kind: "device", name: null, lat: obs.lat, lon: obs.lon, timeZone: null });
        },
        (err) => {
          geoBtn.disabled = false;
          geoBtn.classList.remove("is-busy");
          status.textContent =
            err.code === err.PERMISSION_DENIED
              ? "Location access was refused. Pick a city or enter coordinates instead."
              : err.code === err.TIMEOUT
                ? "Finding your location took too long. Try again, or pick a city or enter coordinates."
                : "Your device couldn’t determine its location. Pick a city or enter coordinates instead.";
        },
        { enableHighAccuracy: false, timeout: 20_000, maximumAge: 10 * MINUTE },
      );
    });

    const cities = h("div", { class: "sky-cities", role: "group", "aria-label": "Cities" });
    for (const p of PRESET_PLACES) {
      const b = h("button", { type: "button", class: "btn btn-small", "aria-pressed": String(view.loc?.kind === "preset" && view.loc.name === p.name) }, p.name);
      b.addEventListener("click", () => setLocation({ kind: "preset", name: p.name, lat: p.lat, lon: p.lon, timeZone: p.timeZone }));
      cities.append(b);
    }

    // Coordinates: a number plus a hemisphere, so phones' decimal keypads (no minus key) work.
    const cur = view.loc;
    const latIn = h("input", { type: "text", inputmode: "decimal", autocomplete: "off", id: "sky-lat", class: "sky-num", placeholder: "6.20", value: cur ? Math.abs(cur.lat).toFixed(2) : "" });
    const lonIn = h("input", { type: "text", inputmode: "decimal", autocomplete: "off", id: "sky-lon", class: "sky-num", placeholder: "106.80", value: cur ? Math.abs(cur.lon).toFixed(2) : "" });
    const hemi = (id: string, a: string, b: string, neg: boolean, label: string) => {
      const sel = h("select", { id, class: "sky-hemi", "aria-label": label }, h("option", { value: "1" }, a), h("option", { value: "-1" }, b));
      sel.value = neg ? "-1" : "1";
      return sel;
    };
    const latHemi = hemi("sky-lat-h", "N", "S", (cur?.lat ?? -1) < 0, "North or south");
    const lonHemi = hemi("sky-lon-h", "E", "W", (cur?.lon ?? 1) < 0, "East or west");
    const form = h(
      "form",
      { class: "sky-coords", novalidate: true },
      h("span", { class: "sky-coord-field" }, h("label", { for: "sky-lat" }, "Latitude"), h("span", { class: "sky-coord" }, latIn, latHemi)),
      h("span", { class: "sky-coord-field" }, h("label", { for: "sky-lon" }, "Longitude"), h("span", { class: "sky-coord" }, lonIn, lonHemi)),
      h("button", { type: "submit", class: "btn btn-small" }, "Show this place"),
    );
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const lat = parseCoordinate(latIn.value) * Number(latHemi.value);
      const lon = parseCoordinate(lonIn.value) * Number(lonHemi.value);
      if (!(Math.abs(lat) <= 90)) {
        status.textContent = "Latitude must be a number from 0 to 90 (degrees north or south).";
        latIn.focus();
        return;
      }
      if (!(Math.abs(lon) <= 180)) {
        status.textContent = "Longitude must be a number from 0 to 180 (degrees east or west).";
        lonIn.focus();
        return;
      }
      setLocation({ kind: "manual", name: null, lat: roundCoordinate(lat), lon: roundCoordinate(lon), timeZone: null });
    });

    picker.append(
      h("div", { class: "sky-picker-row" }, geoBtn, h("span", { class: "sky-picker-or" }, "or a city:"), cities),
      form,
      status,
      h(
        "p",
        { class: "sky-privacy" },
        "Your location stays in this browser: it isn’t sent to the server or put in the page link. It is saved here, rounded to 0.01° (about 1 km), so the panel remembers it.",
      ),
    );
    if (view.loc) {
      const forget = h("button", { type: "button", class: "linklike" }, "Forget my location");
      forget.addEventListener("click", () => setLocation(null));
      picker.lastElementChild!.append(" ", forget);
    }
  }

  /* ---------- Content */

  function build() {
    token++;
    ticker.passes = null;
    ticker.dome = null;
    hideTip();
    buildLocation();
    buildPicker();
    clear(content);
    const loc = view.loc;
    if (!loc) return;
    const now = Date.now();
    const obs = observerOf(loc);
    const tz = zoneOf(loc);
    let tonight: Tonight;
    try {
      tonight = tonightFor(loc, now);
    } catch (err) {
      console.error("[sky] computing tonight failed", err);
      content.append(h("div", { class: "error-state inline", role: "alert" }, h("p", null, "The night’s events couldn’t be computed for this place.")));
      return;
    }

    const sentences = nightSentences(tonight.events);
    if (sentences.length) content.append(h("p", { class: "sky-polar" }, sentences.join(" ")));
    content.append(statsRow(tonight, tz, obs, now));

    const domeBox = h("div", { class: "sky-dome-block" });
    const planetBox = h("section", { class: "sky-section", "aria-labelledby": "sky-planets-h" });
    const passBox = h("section", { class: "sky-section", "aria-labelledby": "sky-passes-h" });
    content.append(h("div", { class: "sky-layout" }, domeBox, h("div", { class: "sky-side" }, planetBox, passBox)));
    content.append(footnote());

    const dome = domeView(domeBox, tonight, obs, tz);
    ticker.dome = dome;
    planetList(planetBox, tonight, tz);
    passSection(passBox, tonight, obs, tz, dome);
  }

  function statsRow(t: Tonight, tz: string, obs: Observer, now: number): HTMLElement {
    const ev = t.events;
    const stat = (label: string, value: Node | string, detail: string, extra?: Node) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, extra ?? null, value), h("div", { class: "stat-detail", title: detail }, detail));
    const sunsetDetail =
      ev.sunset.state === "time" ? `Civil twilight ends ${eventTime(ev.civilDusk, tz)}` : ev.sunset.state === "always-above" ? "The Sun stays up (polar day)" : ev.sunset.state === "always-below" ? "The Sun stays down (polar night)" : "No sunset in this night";
    const sunriseDetail =
      ev.sunrise.state === "time" ? `Civil twilight begins ${eventTime(ev.civilDawn, tz)}` : ev.sunrise.state === "always-above" ? "The Sun stays up (polar day)" : ev.sunrise.state === "always-below" ? "The Sun stays down (polar night)" : "No sunrise in this night";
    let darkValue: string, darkDetail: string;
    if (t.fullDark.length) {
      const allNight = t.fullDark.length === 1 && t.fullDark[0]![0] === t.start && t.fullDark[0]![1] === t.end;
      darkValue = allNight ? "All day and night" : t.fullDark.map((iv) => intervalText(iv, tz)).join(", ");
      darkDetail = "Sun below −18° (no twilight left)";
    } else {
      darkValue = "Not tonight";
      darkDetail = t.dark.length ? `Twilight all night; darkest ${hhmm(darkest(t, obs), tz)}` : "The sky stays bright all night";
    }
    const mp = t.moon.phase;
    const rs = t.moon.rs;
    const moonRs = rs.state === "always-up" ? "Up all night" : rs.state === "never-up" ? "Below the horizon all night" : riseSetText(rs, tz, ", ");
    // The Moon as it looks in your sky (zenith up), at a moment it is up tonight (now if it is).
    const upNow = t.moon.up.find(([a, b]) => now >= a && now <= b);
    const at = upNow ? now : t.moon.up.length ? (t.moon.up[0]![0] + t.moon.up[0]![1]) / 2 : now;
    const glyph = s("svg", { class: "sky-moon-icon", viewBox: "-12 -12 24 24", width: 24, height: 24, "aria-hidden": "true" }, moonGlyph(0, 0, 10.5, mp.illuminated, moonLitBearing(obs, at)));
    return h(
      "div",
      { class: "stats sky-stats" },
      stat("Sunset", eventTime(ev.sunset, tz), sunsetDetail),
      stat("Dark sky", darkValue, darkDetail),
      stat("Sunrise", eventTime(ev.sunrise, tz), sunriseDetail),
      stat("Moon", h("span", null, pct(mp.illuminated), h("small", null, "lit")), `${mp.name} · ${moonRs}`, glyph),
    );
  }

  /** The darkest moment of a night without full darkness (the Sun's lowest point). */
  function darkest(t: Tonight, obs: Observer): number {
    let best = t.start, alt = 90;
    for (let x = t.start; x <= t.end; x += 10 * MINUTE) {
      const a = skyPosition("sun", x, obs).alt;
      if (a < alt) [best, alt] = [x, a];
    }
    return best;
  }

  function planetList(box: HTMLElement, t: Tonight, tz: string) {
    box.append(
      h("h3", { class: "section-title", id: "sky-planets-h" }, "Planets tonight"),
      h(
        "ul",
        { class: "rank-list sky-planets" },
        t.planets.map((p) => planetRow(p, tz)),
      ),
    );
  }

  function planetRow(p: PlanetTonight, tz: string): HTMLElement {
    const visible = p.status === "visible";
    const tag = h("span", { class: "status-tag", style: `--tag:${visible ? "var(--series-1)" : "var(--other)"}` }, visible ? "Visible" : "Not visible");
    const rs = p.rs.state === "always-up" ? "up all night" : p.rs.state === "never-up" ? "" : riseSetText(p.rs, tz, " · ");
    let sub: string;
    if (visible && p.best) {
      sub = `Best ${hhmm(p.best.ms, tz)}, ${whereInSky(p.best)} (${Math.round(p.best.alt)}°) · visible ${p.visible.map((iv) => intervalText(iv, tz)).join(", ")}`;
    } else {
      sub = p.reason + (rs ? ` · ${rs}` : "");
    }
    const faint = p.mag !== null && p.mag > NAKED_EYE_MAG;
    return h(
      "li",
      { class: visible ? "" : "is-dim" },
      h("span", { class: "name" }, p.name, " ", tag),
      h("span", { class: "sub" }, sub),
      h("span", { class: "value" }, p.mag === null ? "—" : fmtMag(p.mag), h("small", null, faint ? "mag · binoculars" : "mag")),
    );
  }

  /* ---------- Sky dome */

  interface Dome {
    /** Redraw for the current view state (time, pass selection). */
    draw(): void;
    setPasses(list: VisiblePass[]): void;
  }

  function domeView(box: HTMLElement, tonight: Tonight, obs: Observer, tz: string): Dome {
    const SIZE = 360, C = SIZE / 2, R = 150;
    let passes: VisiblePass[] = [];
    const heading = h("p", { class: "sky-dome-time mono" });
    const sunText = h("p", { class: "sky-dome-sun" });
    const svg = s("svg", { class: "sky-dome", viewBox: `0 0 ${SIZE} ${SIZE}`, role: "img" });
    const nowBtn = h("button", { type: "button", class: "btn btn-small", title: "Show the sky right now and follow the clock" }, icon(ICONS.now), "Now");
    const slider = h("input", { type: "range", class: "sky-slider", step: String(MINUTE), "aria-label": "Time shown on the sky dome" });
    const startLbl = h("span", { class: "mono" }), endLbl = h("span", { class: "mono" });
    const nowTick = h("span", { class: "sky-slider-now", "aria-hidden": "true" });
    box.append(
      h("div", { class: "chart-head" }, h("h3", null, "Your sky"), heading),
      svg,
      sunText,
      h(
        "div",
        { class: "sky-time" },
        nowBtn,
        h("div", { class: "sky-slider-wrap" }, h("div", { class: "sky-slider-track" }, slider, nowTick), h("div", { class: "sky-slider-ends" }, startLbl, endLbl)),
      ),
      h(
        "p",
        { class: "sky-dome-note" },
        "Zenith in the centre, horizon at the edge. North is up and east is on the left: the sky as you see it lying on your back with your head to the north. Dots are sized by brightness; open circles need binoculars. Drag the slider or use the arrow keys (Shift for 1-minute steps).",
      ),
    );

    let night = tonight;
    const nightFor = (date: string | null) => {
      if (!date || date === tonight.date) return tonight;
      const ev = nightEvents(obs, date);
      const start = ev.start, end = ev.end;
      return { ...tonight, date, start, end, events: ev, range: [ev.sunset.state === "time" ? ev.sunset.ms : start, ev.sunrise.state === "time" ? ev.sunrise.ms : end] as Interval };
    };

    const shownMs = () => view.ms ?? Date.now();
    const sync = () => {
      night = nightFor(view.domeNight);
      const [a, b] = night.range;
      slider.min = String(a);
      slider.max = String(b);
      const t = shownMs();
      slider.value = String(Math.min(b, Math.max(a, t)));
      slider.classList.toggle("is-outside", t < a || t > b);
      slider.setAttribute("aria-valuetext", `${hhmm(t, tz)}${night.date !== tonight.date ? `, ${dayLabel(t, tz)}` : ""}`);
      // Without a sunset or sunrise the slider runs noon to noon: name the days instead.
      const sunsetLbl = night.events.sunset.state === "time" ? "Sunset" : dayLabel(a, tz);
      const sunriseLbl = night.events.sunrise.state === "time" ? "Sunrise" : dayLabel(b, tz);
      startLbl.textContent = `${sunsetLbl} ${hhmm(a, tz)}`;
      endLbl.textContent = `${sunriseLbl} ${hhmm(b, tz)}`;
      const now = Date.now();
      nowTick.hidden = now < a || now > b;
      nowTick.style.left = `${((now - a) / (b - a)) * 100}%`;
      nowBtn.setAttribute("aria-pressed", String(view.ms === null));
    };

    slider.addEventListener("input", () => {
      view.ms = Number(slider.value);
      draw();
    });
    slider.addEventListener("keydown", (ev) => {
      const k = ev.key;
      if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "ArrowUp" && k !== "ArrowDown") return;
      ev.preventDefault();
      const dir = k === "ArrowLeft" || k === "ArrowDown" ? -1 : 1;
      const [a, b] = night.range;
      const base = Math.min(b, Math.max(a, shownMs()));
      view.ms = Math.min(b, Math.max(a, base + dir * (ev.shiftKey ? MINUTE : 10 * MINUTE)));
      draw();
    });
    nowBtn.addEventListener("click", () => {
      view.ms = null;
      view.domeNight = null;
      draw();
    });

    const mark = (p: AltAz, title: string, rows: [string, string][], node: SVGElement, hitR = 12) => {
      const [x, y] = domePoint(p, C, C, R);
      const hit = s("circle", { cx: x, cy: y, r: hitR, class: "sky-hit" });
      const tip: TipContent = { title, rows };
      hit.addEventListener("pointerenter", (ev) => showTip(tip, (ev as PointerEvent).clientX, (ev as PointerEvent).clientY));
      hit.addEventListener("pointermove", (ev) => showTip(tip, (ev as PointerEvent).clientX, (ev as PointerEvent).clientY));
      hit.addEventListener("pointerleave", hideTip);
      hit.addEventListener("click", () => showTipAt(tip, hit));
      const g = s("g", null, node, hit);
      return g;
    };

    /** Labels wanted this frame: placed together at the end so they avoid each other and the dots. */
    let labels: { x: number; y: number; r: number; text: string }[] = [];
    const label = (x: number, y: number, text: string, r = 6) => {
      labels.push({ x, y, r, text });
    };
    function placeLabels(): SVGElement[] {
      type Box = [number, number, number, number];
      const hit = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
      const dots: Box[] = labels.map(({ x, y, r }) => [x - r, y - r, x + r, y + r]);
      const placed: Box[] = [];
      const out: SVGElement[] = [];
      labels.forEach(({ x, y, r, text }, i) => {
        const w = text.length * 6.6 + 2, hgt = 13;
        const cands: [number, number, "start" | "end" | "middle"][] = [
          [x + r + 3, y + 4, "start"], [x - r - 3, y + 4, "end"], [x, y - r - 4, "middle"], [x, y + r + 12, "middle"],
          [x + r + 3, y + 16, "start"], [x - r - 3, y + 16, "end"], [x + r + 3, y - 8, "start"], [x - r - 3, y - 8, "end"],
          [x, y - r - 17, "middle"], [x, y + r + 25, "middle"], [x + r + 3, y + 28, "start"], [x - r - 3, y + 28, "end"],
          [x + r + 3, y - 20, "start"], [x - r - 3, y - 20, "end"],
        ];
        const boxOf = ([lx, ly, anchor]: (typeof cands)[number]): Box => {
          const x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
          return [x0, ly - 10, x0 + w, ly - 10 + hgt];
        };
        const inside = (b: Box) => b[0] >= 0 && b[2] <= SIZE && b[1] >= 0 && b[3] <= SIZE;
        const free = (b: Box) => inside(b) && !placed.some((p) => hit(p, b)) && !dots.some((d, j) => j !== i && hit(d, b));
        const pick = cands.find((c) => free(boxOf(c))) ?? cands.find((c) => inside(boxOf(c))) ?? cands[0]!;
        placed.push(boxOf(pick));
        out.push(s("text", { class: "sky-label", x: pick[0].toFixed(1), y: pick[1].toFixed(1), "text-anchor": pick[2] }, text));
      });
      return out;
    }

    function draw() {
      sync();
      labels = [];
      const t = shownMs();
      const sun = skyPosition("sun", t, obs);
      const state = skyState(sun.alt);
      svg.dataset.sky = state;
      heading.textContent = `${night.date !== tonight.date || Math.abs(t - Date.now()) > 20 * HOUR ? `${dayLabel(t, tz)} ` : ""}${hhmm(t, tz)}${view.ms === null ? " · now" : ""}`;
      sunText.textContent = `Sun ${sun.alt >= 0 ? "" : "−"}${Math.abs(Math.round(sun.alt))}° · ${SKY_STATE_TEXT[state]}${state === "day" || state === "civil" ? " — too bright for most of the sky" : ""}`;

      const parts: SVGElement[] = [];
      parts.push(s("circle", { cx: C, cy: C, r: R, class: "sky-horizon" }));
      for (const alt of [30, 60]) {
        const r = (R * (90 - alt)) / 90;
        parts.push(s("circle", { cx: C, cy: C, r, class: "sky-ring" }));
        parts.push(s("text", { class: "sky-ring-label", x: C + 3, y: C - r - 3 }, `${alt}°`));
      }
      parts.push(s("path", { class: "sky-ring", d: `M${C},${C - R}V${C + R}M${C - R},${C}H${C + R}` }));
      for (const [txt, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const) {
        const [x, y] = domePoint({ alt: -9, az }, C, C, R);
        parts.push(s("text", { class: "sky-compass", x, y: y + 5, "text-anchor": "middle" }, txt));
      }

      // Selected pass track (if it belongs to the night shown).
      const sel = passes.find((p) => passId(p) === view.passKey);
      if (sel && nightDate(sel.peak.ms, obs) === night.date) parts.push(passTrack(sel, t));

      const names: string[] = [];
      if (sun.apparentAlt > -0.8) {
        const [x, y] = domePoint({ alt: sun.apparentAlt, az: sun.az }, C, C, R);
        parts.push(mark({ alt: sun.apparentAlt, az: sun.az }, "Sun", [["Altitude", `${Math.round(sun.apparentAlt)}°`], ["Direction", compassPoint(sun.az)]], sunGlyph(x, y), 14));
        label(x, y, "Sun", 13);
        names.push("the Sun");
      }
      const moon = skyPosition("moon", t, obs);
      if (moon.apparentAlt > -0.8) {
        const mp = moonPhase(t, obs);
        const p = { alt: moon.apparentAlt, az: moon.az };
        const [x, y] = domePoint(p, C, C, R);
        const lit = domeAngle(p, skyBearing(moon, sun), C, C, R);
        parts.push(mark(p, "Moon", [["Altitude", `${Math.round(moon.apparentAlt)}°`], ["Direction", compassPoint(moon.az)], ["Lit", pct(mp.illuminated)]], moonGlyph(x, y, 8, mp.illuminated, lit), 13));
        label(x, y, "Moon", 9);
        names.push("the Moon");
      }
      for (const id of SKY_PLANETS) {
        const pos = skyPosition(id, t, obs);
        if (pos.apparentAlt < 0) continue;
        const info = tonight.planets.find((x) => x.id === id);
        const mag = info?.mag ?? null;
        const p = { alt: pos.apparentAlt, az: pos.az };
        const [x, y] = domePoint(p, C, C, R);
        const faint = mag !== null && mag > NAKED_EYE_MAG;
        const dot = s("circle", { cx: x, cy: y, r: dotRadius(mag), class: faint ? "sky-planet is-faint" : "sky-planet" });
        const rows: [string, string][] = [["Altitude", `${Math.round(pos.apparentAlt)}°`], ["Direction", compassPoint(pos.az)]];
        if (mag !== null) rows.push(["Magnitude", `${fmtMag(mag)}${faint ? " (binoculars)" : ""}`]);
        if (info && info.elongation < 10) rows.push(["Note", "Lost in the Sun’s glare"]);
        parts.push(mark(p, BODY_NAMES[id], rows, dot));
        label(x, y, BODY_NAMES[id], dotRadius(mag) + 1);
        names.push(BODY_NAMES[id]);
      }
      svg.replaceChildren(...parts, ...placeLabels());
      svg.setAttribute(
        "aria-label",
        `Sky dome at ${hhmm(t, tz)}: ${names.length ? `${listText(names)} above the horizon` : "no Sun, Moon or planet above the horizon"}. The planet and pass lists give the same information as text.`,
      );
    }

    function passTrack(p: VisiblePass, t: number): SVGGElement {
      const g = s("g", { class: "sky-pass" });
      const pts = p.track.map((q) => domePoint(q, C, C, R));
      g.append(s("path", { class: "sky-pass-line", d: pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("") }));
      const [sx, sy] = pts[0]!;
      g.append(s("circle", { class: "sky-pass-start", cx: sx, cy: sy, r: 3 }));
      // Arrowhead at the end, pointing along the last segment.
      if (pts.length >= 2) {
        const [x1, y1] = pts[pts.length - 2]!, [x2, y2] = pts[pts.length - 1]!;
        const a = Math.atan2(y2 - y1, x2 - x1);
        const tip = (d: number, da: number) => `${(x2 - d * Math.cos(a + da)).toFixed(1)},${(y2 - d * Math.sin(a + da)).toFixed(1)}`;
        g.append(s("path", { class: "sky-pass-arrow", d: `M${tip(8, 0.45)}L${x2.toFixed(1)},${y2.toFixed(1)}L${tip(8, -0.45)}` }));
      }
      label(sx, sy, p.name, 4);
      // Where it is at the time shown, if during the pass.
      if (t >= p.start.ms && t <= p.end.ms) {
        const k = p.track.findIndex((q) => q.ms >= t);
        const b = p.track[Math.max(0, k)]!, a = p.track[Math.max(0, k - 1)]!;
        const f = b.ms === a.ms ? 0 : (t - a.ms) / (b.ms - a.ms);
        const [ax, ay] = domePoint(a, C, C, R), [bx, by] = domePoint(b, C, C, R);
        g.append(s("circle", { class: "sky-pass-now", cx: ax + (bx - ax) * f, cy: ay + (by - ay) * f, r: 5 }));
      }
      return g;
    }

    // Opened in the afternoon: show the sky once it is dark (Now is one press away).
    if (view.ms === null && view.domeNight === null && Date.now() < tonight.range[0]) view.ms = tonight.dark[0]?.[0] ?? tonight.range[0];
    draw();
    return {
      draw,
      setPasses(list) {
        passes = list;
        draw();
      },
    };
  }

  /* ---------- Passes */

  function passSection(box: HTMLElement, tonight: Tonight, obs: Observer, tz: string, dome: Dome) {
    const head = h("div", { class: "chart-head" }, h("h3", { class: "section-title", id: "sky-passes-h" }, "Spacecraft passes"));
    const body = h("div", { class: "sky-passes" });
    box.append(head, body);
    const { satellites, error } = result.data;

    if (error) {
      const retry = h("button", { type: "button", class: "btn btn-small" }, icon(ICONS.refresh), "Try again");
      retry.addEventListener("click", () => ctx.refresh());
      body.append(
        h(
          "div",
          { class: "error-state inline sky-pass-error", role: "alert" },
          h("div", null, h("p", null, h("strong", null, "Spacecraft orbits couldn’t be loaded. "), error.message), error.hint ? h("p", { class: "hint" }, error.hint) : null, retry),
        ),
      );
      if (satellites) body.append(h("p", { class: "sky-note" }, `Showing passes from the orbits loaded ${age(result.fetchedAt)} ago.`));
    }
    if (!satellites) {
      if (!error) {
        const loadBtn = h("button", { type: "button", class: "btn btn-small" }, icon(ICONS.refresh), "Load spacecraft passes");
        loadBtn.addEventListener("click", () => ctx.refresh());
        body.append(
          h("p", { class: "sky-note" }, "Passes of the ISS, Tiangong and Hubble need their latest orbits from CelesTrak (a small download, only when you press a button). The Sun, Moon and planets above need nothing."),
          loadBtn,
        );
      }
      return;
    }
    if (!satellites.satellites.length) {
      body.append(h("p", { class: "sky-note" }, "No spacecraft orbits are available right now."));
      return;
    }

    const status = h("p", { class: "sky-note", role: "status" }, "Computing passes…");
    const list = h("div");
    body.append(status, list);
    const my = token;
    const key = passCacheKey(view.loc!, result.fetchedAt, tonight.date);

    const show = (pred: PassPrediction) => {
      if (my !== token) return;
      status.remove();
      const draw = () => {
        const now = Date.now();
        const upcoming = pred.passes.filter((p) => p.end.ms > now);
        dome.setPasses(upcoming);
        renderPasses(list, pred, upcoming, tonight, obs, tz, dome, draw);
      };
      draw();
      ticker.passes = draw;
    };

    if (passCache?.key === key) {
      show(passCache.prediction);
      return;
    }
    loadPasses()
      .then((mod) => {
        if (my !== token) return;
        const now = Date.now();
        performance.mark("sky:passes:start");
        const prediction = mod.predictPasses(satellites.satellites, obs, ...mod.passSearchWindow(now, obs));
        performance.measure("sky:passes", "sky:passes:start");
        passCache = { key, prediction };
        // Select tonight's first pass, so the dome shows a track.
        if (view.passKey === null) {
          const first = prediction.passes.find((p) => p.end.ms > now && nightDate(p.peak.ms, obs) === tonight.date);
          if (first) view.passKey = passId(first);
        }
        show(prediction);
        ctx.notify();
      })
      .catch((err) => {
        if (my !== token) return;
        console.error("[sky] pass prediction failed", err);
        status.textContent = "";
        const retry = h("button", { type: "button", class: "btn btn-small" }, icon(ICONS.refresh), "Try again");
        retry.addEventListener("click", () => build());
        status.replaceWith(h("div", { class: "error-state inline", role: "alert" }, h("div", null, h("p", null, "The pass predictor couldn’t start (its code didn’t load). Check your connection and try again; the rest of the panel works."), retry)));
      });
  }

  function renderPasses(list: HTMLElement, pred: PassPrediction, upcoming: VisiblePass[], tonight: Tonight, obs: Observer, tz: string, dome: Dome, redraw: () => void) {
    clear(list);
    const now = Date.now();
    for (const sat of pred.satellites) {
      if (sat.error) list.append(h("p", { class: "sky-note" }, `${sat.name}: ${sat.error}`));
    }
    const sats = result.data.satellites!;
    for (const u of sats.unavailable) list.append(h("p", { class: "sky-note" }, `${u.name}: ${u.reason}`));
    const names = listText(sats.satellites.map((x) => x.name));
    if (!upcoming.length) {
      list.append(
        h(
          "div",
          { class: "sky-empty" },
          h("p", null, h("strong", null, `No visible passes of ${names} in the next 4 nights.`)),
          h(
            "p",
            null,
            "A pass is visible only when the spacecraft is above 10°, still in sunlight, and your sky is dark (Sun below −6°). Passes come in spells of a few days, when the orbit lines up with dusk or dawn; check again in a few days. Spacecraft in low-inclination orbits (Hubble, 28.5°) never reach high latitudes.",
          ),
        ),
      );
      return;
    }
    const tonightPasses = upcoming.filter((p) => nightDate(p.peak.ms, obs) === tonight.date);
    if (!tonightPasses.length) {
      const next = upcoming[0]!;
      list.append(h("p", { class: "sky-note" }, h("strong", null, "No visible passes tonight. "), `Next: ${next.name} ${dayLabel(next.start.ms, tz)} at ${hhmm(next.start.ms, tz)}.`));
    }
    const shown = view.showAllPasses ? upcoming : upcoming.slice(0, PASSES_SHOWN);
    const brightest = shown.reduce((m, p) => (p.mag < m.mag ? p : m));
    const ul = h("ul", { class: "sky-pass-list" });
    for (const p of shown) {
      const id = passId(p);
      const isTonight = nightDate(p.peak.ms, obs) === tonight.date;
      const inProgress = p.start.ms <= now;
      const startText = p.start.cause === "shadow" ? "appears out of Earth’s shadow" : p.start.cause === "twilight" ? "visible once the sky darkens" : p.start.cause === "window" ? "already up" : "";
      const endText = p.end.cause === "shadow" ? "fades into Earth’s shadow" : p.end.cause === "twilight" ? "until dawn brightens the sky" : "";
      const path = `${compassPoint(p.start.az)} → ${Math.round(p.peak.alt)}° ${compassPoint(p.peak.az)} → ${compassPoint(p.end.az)}`;
      const btn = h(
        "button",
        { type: "button", class: "sky-pass", "aria-pressed": String(view.passKey === id), title: "Show this pass on the sky dome" },
        h("span", { class: "name" }, p.name, p === brightest && shown.length > 1 ? h("span", { class: "status-tag", style: "--tag:var(--series-1)" }, "Brightest") : null, inProgress ? h("span", { class: "status-tag", style: "--tag:var(--series-3)" }, "Now") : null),
        h("span", { class: "when mono" }, `${isTonight ? "Tonight" : dayLabel(p.start.ms, tz)} ${passTimes(p, tz)}`),
        h("span", { class: "sub" }, [path, startText, endText].filter(Boolean).join(" · ")),
        h("span", { class: "value" }, fmtMag(p.mag), h("small", null, "mag")),
      );
      btn.addEventListener("click", () => {
        if (view.passKey === id) {
          view.passKey = null;
        } else {
          view.passKey = id;
          view.ms = Math.max(p.start.ms, Math.min(p.end.ms, p.peak.ms));
          view.domeNight = nightDate(p.peak.ms, obs);
        }
        redraw();
      });
      ul.append(h("li", null, btn));
    }
    list.append(ul);
    if (upcoming.length > PASSES_SHOWN) {
      const more = h("button", { type: "button", class: "linklike" }, view.showAllPasses ? "Show fewer" : `Show all ${upcoming.length} passes`);
      more.addEventListener("click", () => {
        view.showAllPasses = !view.showAllPasses;
        redraw();
      });
      list.append(h("p", { class: "sky-more" }, more));
    }
    const epochs = sats.satellites.map((x) => Date.parse(x.epoch));
    list.append(
      h(
        "p",
        { class: "sky-note" },
        `Times are when each pass is visible (above 10°, sunlit, Sun below −6°). Orbits from CelesTrak, epochs ${utc(new Date(Math.min(...epochs)))}${epochs.length > 1 ? ` – ${utc(new Date(Math.max(...epochs)))}` : ""}.`,
      ),
    );
  }

  function footnote(): HTMLElement {
    return h(
      "p",
      { class: "footnote sky-honesty" },
      "Computed in your browser. Sun, Moon and planets from JPL’s planetary elements and Meeus’ solar and lunar theories: positions within about 0.1°, rise, set and twilight times within about 2 minutes. Planet brightness from the Astronomical Almanac’s model (Mallama & Hilton 2018). “Visible” planets are above ",
      `${MIN_PLANET_ALT}° while the Sun is below ${DARK_SUN_ALT}° and at least 10° from it. `,
      "Spacecraft passes are SGP4 predictions from CelesTrak’s orbital elements: usually within a minute while the elements are fresh, more after an orbit boost. Their brightness is a rough estimate (real spacecraft vary by a magnitude or more), and Earth’s shadow is modelled as a simple cylinder (entry and exit ± about 10 s).",
    );
  }

  /* ---------- Clock */

  const tick = () => {
    if (document.hidden || !view.loc) return;
    const now = Date.now();
    const obs = observerOf(view.loc);
    if (tonightCache && nightDate(now, obs) !== tonightCache.value.date) {
      build(); // a new night began (solar noon passed)
      return;
    }
    if (ticker.passes) ticker.passes();
    else ticker.dome?.draw();
  };
  const timer = setInterval(tick, MINUTE);
  const onVisible = () => !document.hidden && tick();
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  });

  build();
  return () => {
    token++;
    for (const fn of cleanups) fn();
    hideTip();
  };
}

function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Definition                                                          */
/* ------------------------------------------------------------------ */

function isSatellitesData(d: unknown): d is SatellitesData {
  if (!d || typeof d !== "object") return false;
  const x = d as Partial<SatellitesData>;
  return (
    Array.isArray(x.satellites) &&
    Array.isArray(x.unavailable) &&
    x.satellites.every((s) => !!s && typeof s.id === "number" && typeof s.name === "string" && typeof s.epoch === "string" && typeof s.stdMag === "number" && !!s.omm && typeof s.omm === "object")
  );
}

export const skyPanel: PanelDefinition<SkyData> = {
  id: "sky",
  title: "Sky tonight",
  subtitle: "When it gets dark where you are, the Moon, which planets are up, and visible passes of the ISS, Tiangong and Hubble",
  icon: ICONS.sky,
  span: "span-12",
  source: { name: "CelesTrak GP elements · JPL planetary elements", url: "https://celestrak.org/NORAD/documentation/gp-data-formats.php" },

  async load(signal, _params, prev): Promise<PanelResult<SkyData>> {
    try {
      const env = await fetchSource("satellites", {}, signal);
      return { data: { satellites: env.data, error: null }, fetchedAt: env.fetchedAt, upstream: env.upstream, notices: env.notices };
    } catch (err) {
      if (signal.aborted) throw err;
      // The orbits failed: keep the previous ones (if any) and let the panel say so inline, so the
      // Sun, Moon and planets stay on screen. "Refresh all" still counts this as a failure.
      const api = err instanceof ApiError ? err : null;
      const message = isRateLimited(err) ? "Too many requests to this site; try again in a minute." : (api?.message ?? (err as Error)?.message ?? "Unknown error.");
      const keep = prev?.data.satellites ? prev : null;
      return {
        data: { satellites: keep?.data.satellites ?? null, error: { message, hint: api?.body?.error.hint ?? null } },
        fetchedAt: keep?.fetchedAt ?? new Date().toISOString(),
        upstream: api?.body?.upstream ?? [],
        notices: keep?.notices ?? [],
        failed: "Spacecraft orbits failed — see below",
      };
    }
  },

  render,

  initial() {
    return {
      result: { data: { satellites: null, error: null }, fetchedAt: new Date().toISOString(), upstream: [], notices: [] },
      stamp: "Spacecraft orbits not loaded",
    };
  },

  restoredNotice(result) {
    return `Spacecraft orbits are from your last visit (${age(result.fetchedAt)} old); refresh for the latest. The Sun, Moon and planets are always computed for now.`;
  },

  migrate(snap) {
    const d = snap.data as Partial<SkyData> | null;
    if (!d || !isSatellitesData(d.satellites)) return null;
    return { ...snap, data: { satellites: d.satellites, error: null } };
  },

  summarize(result) {
    const loc = view.loc;
    if (!loc) return { label: "Sky tonight", icon: ICONS.sky, value: "Pick a location", detail: "Moon, planets and spacecraft passes for your sky" };
    const now = Date.now();
    const obs = observerOf(loc);
    const tz = zoneOf(loc);
    const t = tonightFor(loc, now);
    const sunAlt = skyPosition("sun", now, obs).alt;
    const dark = sunAlt < DARK_SUN_ALT;
    const planets = SKY_PLANETS.filter((id) => {
      const p = t.planets.find((x) => x.id === id)!;
      if (p.status !== "visible" || (p.mag ?? 9) > NAKED_EYE_MAG) return false;
      return dark ? skyPosition(id, now, obs).alt >= MIN_PLANET_ALT : true;
    }).map((id) => BODY_NAMES[id as SkyPlanet]);
    const moon = `Moon ${pct(t.moon.phase.illuminated)}`;
    const planetText = planets.length ? `${listText(planets)} ${dark ? "up" : "tonight"}` : dark ? "no bright planet up" : "no bright planet tonight";
    const where = loc.name ?? "your location";
    const pred = passCache && result.data.satellites && passCache.key === passCacheKey(loc, result.fetchedAt, t.date) ? passCache.prediction : null;
    const next = pred?.passes.find((p) => p.end.ms > now);
    if (next && next.start.ms - now < 2 * DAY) {
      const when = next.start.ms <= now ? "now" : `${nightDate(next.peak.ms, obs) === t.date ? "" : `${dayLabel(next.start.ms, tz)} `}${hhmm(next.start.ms, tz)}`;
      return { label: `Sky tonight · ${where}`, icon: ICONS.sky, value: `${next.name} ${when}`, detail: `Pass, mag ${fmtMag(next.mag)} · ${moon}, ${planetText}` };
    }
    return { label: `Sky tonight · ${where}`, icon: ICONS.sky, value: moon, detail: `${t.moon.phase.name} · ${planetText}` };
  },
};
