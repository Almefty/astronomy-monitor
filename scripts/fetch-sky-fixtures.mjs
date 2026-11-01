#!/usr/bin/env node
/**
 * Builds test/fixtures/sky-reference.json for test/sky.test.ts from independent sources:
 *
 * - JPL Horizons API (observer tables, DE441): astrometric RA/Dec (ICRF), apparent airless az/el,
 *   visual magnitude and illuminated fraction for the Sun, Moon and planets at three observers.
 * - JPL Horizons, Sun elevation at 1-minute steps: the times it crosses −6°, −12° and −18°
 *   (linear interpolation between minutes), as the twilight reference.
 * - USNO Astronomical Applications API: one-day rise/set/transit/twilight tables and Moon phases.
 *
 * Run by hand (`node scripts/fetch-sky-fixtures.mjs`); the tests only read the saved file.
 */
import { writeFileSync } from "node:fs";

const OUT = new URL("../test/fixtures/sky-reference.json", import.meta.url);

/** Observers: lat, lon (east +), standard UTC offset used for USNO's local calendar day. */
const SITES = {
  jakarta: { lat: -6.2, lon: 106.8, tz: 7 },
  tromso: { lat: 69.65, lon: 18.96, tz: 1 },
  capetown: { lat: -33.92, lon: 18.42, tz: 2 },
};
const BODIES = { sun: "10", moon: "301", mercury: "199", venus: "299", mars: "499", jupiter: "599", saturn: "699", uranus: "799", neptune: "899" };
/** Position epochs (UT). */
const EPOCHS = ["2026-11-01T18:00:00Z", "2026-12-21T00:00:00Z", "2027-01-15T12:00:00Z", "2027-03-20T06:00:00Z", "2027-06-21T21:00:00Z", "2027-09-10T15:00:00Z"];
/** Local calendar days for rise/set (USNO) and twilight (Horizons). 2026-12-21 is polar night and
 *  2027-06-21 polar day at Tromsø. */
const DAYS = ["2026-11-01", "2026-12-21", "2027-03-20", "2027-06-21"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jd = (ms) => ms / 86_400_000 + 2440587.5;

async function get(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (attempt >= 3) throw new Error(`${res.status} ${url}`);
    await sleep(2000 * 2 ** attempt);
  }
}

function horizonsUrl(params) {
  const q = Object.entries({
    format: "json", EPHEM_TYPE: "OBSERVER", CENTER: "coord@399", COORD_TYPE: "GEODETIC", ANG_FORMAT: "DEG",
    CSV_FORMAT: "YES", OBJ_DATA: "NO", EXTRA_PREC: "YES", TIME_DIGITS: "SECONDS", ...params,
  }).map(([k, v]) => `${k}=${k === "format" ? v : encodeURIComponent(`'${v}'`)}`);
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${q.join("&")}`;
}

/** Rows between $$SOE and $$EOE, split on commas. */
async function horizonsRows(params) {
  const body = await (await get(horizonsUrl(params))).json();
  const r = body.result;
  const a = r.indexOf("$$SOE"), b = r.indexOf("$$EOE");
  if (a < 0 || b < 0) throw new Error(`Horizons: no table\n${r.slice(0, 2000)}`);
  return r.slice(a + 5, b).trim().split("\n").map((line) => line.split(",").map((s) => s.trim()));
}

function parseUt(s) {
  // "2026-Nov-01 18:00:00.000"
  const [d, t] = s.split(" ");
  const [y, mon, day] = d.split("-");
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(mon);
  const [hh, mm, ss] = t.split(":").map(Number);
  return Date.UTC(Number(y), m, Number(day), hh, mm, 0) + ss * 1000;
}

const num = (s) => (s === "n.a." || s === "" ? null : Number(s));

async function positions() {
  const out = {};
  const tlist = EPOCHS.map((e) => jd(Date.parse(e)).toFixed(6)).join(" ");
  for (const [site, s] of Object.entries(SITES)) {
    out[site] = {};
    for (const [body, id] of Object.entries(BODIES)) {
      const rows = await horizonsRows({ COMMAND: id, SITE_COORD: `${s.lon},${s.lat},0`, TLIST: tlist, QUANTITIES: "1,4,9,10" });
      out[site][body] = rows.map((c) => ({
        ms: parseUt(c[0]), ra: num(c[3]), dec: num(c[4]), az: num(c[5]), el: num(c[6]), mag: num(c[7]), illum: num(c[9]),
      }));
      await sleep(300);
    }
  }
  return out;
}

/** Sun elevation every minute from local noon to the next local noon; crossings of the twilight limits. */
async function twilight() {
  const out = {};
  for (const [site, s] of Object.entries(SITES)) {
    out[site] = {};
    for (const day of DAYS) {
      const start = Date.parse(`${day}T12:00:00Z`) - s.tz * 3_600_000;
      const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
      const rows = await horizonsRows({
        COMMAND: "10", SITE_COORD: `${s.lon},${s.lat},0`, START_TIME: fmt(start), STOP_TIME: fmt(start + 86_400_000), STEP_SIZE: "1m", QUANTITIES: "4",
      });
      const pts = rows.map((c) => [parseUt(c[0]), Number(c[4])]);
      const events = [];
      for (const limit of [-0.8333, -6, -12, -18]) {
        for (let k = 1; k < pts.length; k++) {
          const [t0, e0] = pts[k - 1], [t1, e1] = pts[k];
          if ((e0 - limit) * (e1 - limit) < 0) {
            events.push({ limit, kind: e1 > e0 ? "up" : "down", ms: Math.round(t0 + ((limit - e0) / (e1 - e0)) * (t1 - t0)) });
          }
        }
      }
      const els = pts.map((p) => p[1]);
      out[site][day] = { windowStart: start, minEl: Math.min(...els), maxEl: Math.max(...els), events: events.sort((a, b) => a.ms - b.ms) };
      await sleep(300);
    }
  }
  return out;
}

async function usno() {
  const out = {};
  for (const [site, s] of Object.entries(SITES)) {
    out[site] = {};
    for (const day of DAYS) {
      const body = await (await get(`https://aa.usno.navy.mil/api/rstt/oneday?date=${day}&coords=${s.lat},${s.lon}&tz=${s.tz}`)).json();
      const d = body.properties.data;
      const conv = (list) => list.map((e) => ({
        phen: e.phen,
        ms: e.time === null ? null : Date.parse(`${day}T${e.time}:00Z`) - s.tz * 3_600_000,
      }));
      out[site][day] = { tz: s.tz, sun: conv(d.sundata), moon: conv(d.moondata), fracillum: d.fracillum, curphase: d.curphase };
      await sleep(300);
    }
  }
  return out;
}

async function moonPhases() {
  const body = await (await get("https://aa.usno.navy.mil/api/moon/phases/date?date=2026-10-01&nump=24")).json();
  return body.phasedata.map((p) => ({
    phase: p.phase,
    ms: Date.UTC(p.year, p.month - 1, p.day, ...p.time.split(":").map(Number)),
  }));
}

const fixture = {
  note:
    `Captured ${new Date().toISOString().slice(0, 10)} by scripts/fetch-sky-fixtures.mjs. ` +
    "positions: JPL Horizons API observer tables (DE441), QUANTITIES='1,4,9,10' — astrometric RA/Dec (ICRF, deg), " +
    "apparent airless azimuth/elevation (deg), APmag, illuminated %. twilight: Horizons Sun elevation at 1-min steps from " +
    "local noon to local noon, linearly interpolated crossings. usno: aa.usno.navy.mil/api/rstt/oneday (times rounded to " +
    "the minute, converted to UTC ms from the site's standard offset). moonPhases: aa.usno.navy.mil/api/moon/phases/date (UT).",
  sites: SITES,
  positions: await positions(),
  twilight: await twilight(),
  usno: await usno(),
  moonPhases: await moonPhases(),
};
writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.log(`wrote ${OUT.pathname}`);
