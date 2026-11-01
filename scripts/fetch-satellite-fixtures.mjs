#!/usr/bin/env node
/**
 * Builds the fixtures for test/satellites.test.ts from independent sources:
 *
 * test/fixtures/satellites-reference.json
 * - CelesTrak GP data: the OMM JSON answers for the panel's spacecraft (exactly what the Worker
 *   receives), plus the ISS as a TLE from the same update, to check that both formats agree.
 * - JPL Horizons API: the ISS (target −125544, "TLE-based") as seen from four observers over four
 *   days — airless azimuth/elevation every minute to find the passes above 10°, then every 2 s
 *   around each pass for its 10° crossings and highest point.
 *
 * test/fixtures/sgp4-vallado.json (with --vallado)
 * - The SGP4 verification cases of Vallado, Crawford, Hujsak & Kelso (2006), "Revisiting
 *   Spacetrack Report #3", AIAA 2006-6753: SGP4-VER.TLE and the MATLAB reference output
 *   tmatverDec2015.out from https://celestrak.org/publications/AIAA/2006-6753/AIAA-2006-6753.zip
 *   (needs the `unzip` command).
 *
 * Run by hand: `NODE_USE_ENV_PROXY=1 node scripts/fetch-satellite-fixtures.mjs [--vallado]`
 * (Node's fetch ignores HTTPS_PROXY without it). The tests only read the saved files.
 * CelesTrak asks clients to download each update only once: this makes 4 small CelesTrak calls.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = new URL("../test/fixtures/satellites-reference.json", import.meta.url);
const OUT_VALLADO = new URL("../test/fixtures/sgp4-vallado.json", import.meta.url);

const SATELLITES = [25544, 48274, 20580];
/** Observers: lat, lon (east +). */
const SITES = {
  jakarta: { lat: -6.2, lon: 106.8 },
  tromso: { lat: 69.65, lon: 18.96 },
  capetown: { lat: -33.92, lon: 18.42 },
  london: { lat: 51.51, lon: -0.13 },
};
/** The comparison window (UTC): four days from the fixture date. */
const WINDOW_DAYS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { allow404 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": "astronomy-monitor fixture script (+https://github.com/Almefty/astronomy-monitor)" } });
    } catch (err) {
      if (attempt >= 6) throw err;
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.ok || (allow404 && res.status === 404)) return res;
    // CelesTrak: stop at the first non-200 answer (usage policy) rather than retrying.
    if (url.includes("celestrak.org") || attempt >= 3) throw new Error(`${res.status} ${url}`);
    await sleep(2000 * 2 ** attempt);
  }
}

/* ------------------------------------------------------------------ */
/* CelesTrak                                                           */
/* ------------------------------------------------------------------ */

async function celestrak() {
  const omm = {};
  for (const id of SATELLITES) {
    omm[id] = await (await get(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=JSON`)).json();
    await sleep(1000);
  }
  const tle = (await (await get("https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE")).text()).trim().split(/\r?\n/).map((l) => l.trimEnd());
  return { omm, tle: { 25544: tle } };
}

/* ------------------------------------------------------------------ */
/* JPL Horizons                                                        */
/* ------------------------------------------------------------------ */

function horizonsUrl(params) {
  const q = Object.entries({
    format: "json", COMMAND: "-125544", EPHEM_TYPE: "OBSERVER", CENTER: "coord@399", COORD_TYPE: "GEODETIC", ANG_FORMAT: "DEG",
    CSV_FORMAT: "YES", OBJ_DATA: "YES", EXTRA_PREC: "YES", TIME_DIGITS: "SECONDS", QUANTITIES: "4", ...params,
  }).map(([k, v]) => `${k}=${k === "format" ? v : encodeURIComponent(`'${v}'`)}`);
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${q.join("&")}`;
}

/** [ms, az, el] rows between $$SOE and $$EOE, and the header's "Revised" line. */
async function horizons(params) {
  const body = await (await get(horizonsUrl(params))).json();
  const r = body.result;
  const a = r.indexOf("$$SOE"), b = r.indexOf("$$EOE");
  if (a < 0 || b < 0) throw new Error(`Horizons: no table\n${r.slice(0, 2000)}`);
  const rows = r.slice(a + 5, b).trim().split("\n").map((line) => {
    const c = line.split(",").map((s) => s.trim());
    return [parseUt(c[0]), Number(c[3]), Number(c[4])];
  });
  return { rows, revised: /Revised:\s*([A-Za-z]{3} \d{1,2}, \d{4})/.exec(r)?.[1] ?? null };
}

function parseUt(s) {
  // "2026-Nov-01 18:00:00.000"
  const [d, t] = s.split(" ");
  const [y, mon, day] = d.split("-");
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(mon);
  const [hh, mm, ss] = t.split(":").map(Number);
  return Date.UTC(Number(y), m, Number(day), hh, mm, 0) + Math.round(ss * 1000);
}

const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Linear interpolation of the time `el` crosses `level` between two rows. */
const cross = (r0, r1, level) => Math.round(r0[0] + ((level - r0[2]) / (r1[2] - r0[2])) * (r1[0] - r0[0]));

async function issPasses(start) {
  const end = start + WINDOW_DAYS * 86_400_000;
  const out = {};
  let revised = null;
  for (const [name, s] of Object.entries(SITES)) {
    const site = `${s.lon},${s.lat},0`;
    const coarse = await horizons({ SITE_COORD: site, START_TIME: fmt(start), STOP_TIME: fmt(end), STEP_SIZE: "1m" });
    revised = coarse.revised;
    // Runs of minutes above 9° (a little margin, so a pass peaking between samples isn't missed).
    const runs = [];
    let open = null;
    coarse.rows.forEach((row, i) => {
      if (row[2] >= 9 && open === null) open = i;
      if ((row[2] < 9 || i === coarse.rows.length - 1) && open !== null) {
        runs.push([coarse.rows[Math.max(0, open - 1)][0], coarse.rows[i][0]]);
        open = null;
      }
    });
    const passes = [];
    for (const [a, b] of runs) {
      const t0 = a - 60_000, t1 = b + 60_000;
      if (t0 < start || t1 > end) continue; // keep only passes wholly inside the window
      const fine = await horizons({ SITE_COORD: site, START_TIME: fmt(t0), STOP_TIME: fmt(t1), STEP_SIZE: String(Math.round((t1 - t0) / 2000)) });
      await sleep(300);
      const rows = fine.rows;
      let k = 0;
      for (let i = 1; i < rows.length; i++) if (rows[i][2] > rows[k][2]) k = i;
      if (rows[k][2] < 10) continue;
      // Parabola through the highest sample and its neighbours.
      const [p, q, r] = [rows[k - 1], rows[k], rows[k + 1]];
      const denom = p[2] - 2 * q[2] + r[2];
      const off = denom === 0 ? 0 : (0.5 * (p[2] - r[2])) / denom;
      const peakMs = Math.round(q[0] + off * (q[0] - p[0]));
      const peakEl = q[2] - 0.25 * (p[2] - r[2]) * off;
      // Azimuth at the peak time, linear between the two samples around it (azimuth moves fastest here).
      const nb = off < 0 ? p : r;
      const dAz = ((nb[1] - q[1] + 540) % 360) - 180;
      const peakAz = (q[1] + Math.abs(off) * dAz + 360) % 360;
      let rise = null, set = null;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i - 1][2] < 10 && rows[i][2] >= 10 && rise === null) rise = { ms: cross(rows[i - 1], rows[i], 10), az: rows[i][1] };
        if (rows[i - 1][2] >= 10 && rows[i][2] < 10) set = { ms: cross(rows[i - 1], rows[i], 10), az: rows[i - 1][1] };
      }
      passes.push({ rise, peak: { ms: peakMs, el: Number(peakEl.toFixed(4)), az: Number(peakAz.toFixed(4)) }, set });
    }
    // A few raw rows (every 20 s of the first pass) for a direct az/el comparison.
    const first = passes[0];
    const samples = [];
    if (first) {
      const s0 = first.rise.ms - (first.rise.ms % 20_000) + 20_000;
      const tl = [];
      for (let t = s0; t < first.set.ms; t += 20_000) tl.push((t / 86_400_000 + 2440587.5).toFixed(9));
      const raw = await horizons({ SITE_COORD: site, TLIST: tl.join(" "), TLIST_TYPE: "JD", TIME_TYPE: "UT" });
      samples.push(...raw.rows.map(([ms, az, el]) => [Math.round(ms / 1000) * 1000, az, el]));
      await sleep(300);
    }
    out[name] = { ...s, passes, samples };
    await sleep(500);
  }
  return { revised, start, end, sites: out };
}

/* ------------------------------------------------------------------ */
/* Vallado's SGP4 verification set                                     */
/* ------------------------------------------------------------------ */

async function vallado() {
  const dir = mkdtempSync(join(tmpdir(), "sgp4-"));
  const zip = join(dir, "AIAA-2006-6753.zip");
  writeFileSync(zip, Buffer.from(await (await get("https://celestrak.org/publications/AIAA/2006-6753/AIAA-2006-6753.zip")).arrayBuffer()));
  const read = (path) => execFileSync("unzip", ["-p", zip, path], { encoding: "latin1", maxBuffer: 1 << 26 });
  const tleText = read("sgp4/mat/SGP4-VER.TLE");
  const outText = read("sgp4/mat/tmatverDec2015.out");
  // TLE pairs in file order; columns after 69 hold the case's start, stop and step (minutes).
  const tles = [];
  const lines = tleText.split(/\r?\n/).filter((l) => /^[12] /.test(l));
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const [startMin, stopMin] = lines[i + 1].slice(69).trim().split(/\s+/).map(Number);
    tles.push({ satnum: Number(lines[i + 1].slice(2, 7)), tle: [lines[i].slice(0, 69), lines[i + 1].slice(0, 69)], startMin, stopMin });
  }
  // Output cases come in the same order as the TLEs (20413 appears twice, with different ranges).
  const cases = [];
  let cur = null;
  for (const line of outText.split(/\r?\n/)) {
    const head = /^\s*(\d+) xx\s*$/.exec(line);
    if (head) {
      const t = tles[cases.length];
      if (!t || t.satnum !== Number(head[1])) throw new Error(`case ${cases.length}: ${head[1]} doesn't match the TLE order`);
      cur = { satnum: t.satnum, tle: t.tle, startMin: t.startMin, stopMin: t.stopMin, rows: [] };
      cases.push(cur);
      continue;
    }
    const f = line.trim().split(/\s+/).map(Number);
    // tsince (min), x y z (km), vx vy vz (km/s), TEME. Rows outside the case's range (a stray debug
    // line at the end of the file) are dropped.
    if (!cur || f.length < 7 || !f.slice(0, 7).every(Number.isFinite)) continue;
    const t = f[0];
    if (t === 0 || (t >= Math.min(cur.startMin, cur.stopMin) && t <= Math.max(cur.startMin, cur.stopMin))) cur.rows.push(f.slice(0, 7));
  }
  return {
    note:
      `Captured ${new Date().toISOString().slice(0, 10)} by scripts/fetch-satellite-fixtures.mjs --vallado from ` +
      "https://celestrak.org/publications/AIAA/2006-6753/AIAA-2006-6753.zip (Vallado, Crawford, Hujsak & Kelso 2006, " +
      "AIAA 2006-6753): sgp4/mat/SGP4-VER.TLE (lines cut to 69 columns) and sgp4/mat/tmatverDec2015.out. " +
      "rows: [minutes since epoch, x, y, z (km), vx, vy, vz (km/s)] in TEME, WGS-72, 'improved' (opsmode i).",
    cases,
  };
}

/* ------------------------------------------------------------------ */

if (process.argv.includes("--vallado")) {
  writeFileSync(OUT_VALLADO, JSON.stringify(await vallado()) + "\n");
  console.log(`wrote ${OUT_VALLADO.pathname}`);
} else {
  const fetchedAt = new Date().toISOString();
  const start = Date.parse(`${fetchedAt.slice(0, 10)}T06:00:00Z`);
  const fixture = {
    note:
      `Captured ${fetchedAt} by scripts/fetch-satellite-fixtures.mjs. celestrak.omm: CelesTrak GP answers ` +
      "(gp.php?CATNR=<id>&FORMAT=JSON), unmodified. celestrak.tle: the ISS as FORMAT=TLE from the same update. " +
      "horizons: JPL Horizons API observer tables for the ISS (COMMAND='-125544', a TLE-based trajectory; 'revised' is " +
      "Horizons' own element date), QUANTITIES='4' (apparent airless azimuth/elevation, degrees, UT). passes: every pass " +
      "above 10° wholly inside [start, end] (ms); rise/set = 10° crossings interpolated from 2-s steps, peak = parabola " +
      "through the highest 2-s samples (azimuth interpolated to that time). samples: [ms, az, el] every 20 s of each site's first pass.",
    fetchedAt,
    celestrak: await celestrak(),
    horizons: await issPasses(start),
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`wrote ${OUT.pathname}`);
}
