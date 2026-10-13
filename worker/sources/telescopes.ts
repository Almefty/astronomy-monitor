import type { PositionSource, ScheduledObservation, TelescopeData, TelescopeId, TelescopeSchedule } from "../../shared/contract";
import { angularSeparation, sunPosition } from "../../shared/astro";
import { positionFromName, resolverName } from "../lib/coords";
import { SourceError, type Upstream } from "../lib/upstream";
import { addDays } from "../lib/util";
import type { SourceModule } from "./types";

/**
 * What Webb and Hubble are observing, from STScI's published weekly schedules. There is no
 * API, so the text reports are parsed defensively: columns are located from each report's
 * own header and dashed separator line, every row is validated, and a report that doesn't
 * look exactly as expected is rejected with an explanation instead of being half-read.
 *
 * The reports name targets but give no coordinates. Positions come from, in order:
 *   1. MAST (the STScI archive): planned JWST observations carry their pointing; for Hubble,
 *      earlier observations of the same target in the same program;
 *   2. coordinates encoded in the target name ("J095236+405249");
 *   3. the CDS Sesame name resolver for catalog names ("NGC 855", "TOI-1774").
 * Every position is then checked against the telescope's Sun-angle limits at the time of the
 * observation; impossible ones are dropped.
 */
export const JWST_INDEX = "https://www.stsci.edu/jwst/science-execution/observing-schedules";
const JWST_FILES = "https://www.stsci.edu/files/live/sites/www/files/home/jwst/science-execution/observing-schedules/_documents/";
export const HST_DIR = "https://www.stsci.edu/ftp/observing/weekly_timeline/";
const MAST_API = "https://mast.stsci.edu/api/v0/invoke";
const SESAME = "https://cds.unistra.fr/cgi-bin/nph-sesame/-o/SNV";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class FormatError extends Error {}

/* ------------------------------------------------------------------ */
/* Fixed-width columns from a dashed separator line                     */
/* ------------------------------------------------------------------ */

/** Column start offsets from a separator like "-------- -------- --------  -------". */
export function columnStarts(separator: string): number[] {
  const starts: number[] = [];
  for (const m of separator.matchAll(/-+/g)) starts.push(m.index!);
  return starts;
}

/** Cut a line into fields: each field runs from its column start to the next column's start. */
export function cut(line: string, starts: number[]): string[] {
  return starts.map((s, i) => line.slice(s, i + 1 < starts.length ? starts[i + 1] : undefined).trim());
}

/** Check that each expected header word sits at the start of its column. */
function expectHeader(header: string, starts: number[], expected: [number, string][], what: string) {
  for (const [col, word] of expected) {
    const s = starts[col];
    if (s === undefined || !header.slice(Math.max(0, s - 2), s + word.length + 3).toUpperCase().includes(word.toUpperCase())) {
      throw new FormatError(`${what}: expected column “${word}” was not found where the report's header puts it.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* JWST weekly report                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedRow {
  id: string;
  program: string;
  start: number;
  end: number;
  target: string;
  instrument: string;
  category: string | null;
  keywords: string | null;
  pi: string | null;
  title: string | null;
  kind: ScheduledObservation["kind"] | "internal";
}

/** Report files linked from the JWST schedules page, latest report per week. */
export function jwstReports(indexHtml: string): { week: string; url: string; name: string }[] {
  // The page is ~250 KB and lists reports newest first: scan with indexOf (cheap on CPU) and
  // stop after the first dozen links.
  const byWeek = new Map<string, string>();
  const re = /^(\d{8})_report_\d{8}\.txt/;
  for (let i = indexHtml.indexOf("_documents/"), n = 0; i >= 0 && n < 12; i = indexHtml.indexOf("_documents/", i + 11)) {
    const m = re.exec(indexHtml.slice(i + 11, i + 40));
    if (!m) continue;
    n++;
    const [name, week] = [m[0], m[1]!];
    const prev = byWeek.get(week);
    if (!prev || name > prev) byWeek.set(week, name);
  }
  return [...byWeek.entries()]
    .map(([week, name]) => ({ week: `${week.slice(0, 4)}-${week.slice(4, 6)}-${week.slice(6, 8)}`, url: JWST_FILES + name, name }))
    .sort((a, b) => b.week.localeCompare(a.week));
}

export function parseJwst(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => /VISIT ID/.test(l) && /SCHEDULED START TIME/.test(l) && /TARGET NAME/.test(l));
  if (hi < 0 || !/^-{5,}/.test(lines[hi + 1] ?? "")) throw new FormatError("JWST report: the column header line was not found.");
  const starts = columnStarts(lines[hi + 1]!);
  if (starts.length < 8) throw new FormatError("JWST report: fewer columns than expected.");
  expectHeader(lines[hi]!, starts, [[0, "VISIT ID"], [2, "VISIT TYPE"], [3, "SCHEDULED START"], [4, "DURATION"], [5, "SCIENCE INSTRUMENT"], [6, "TARGET NAME"], [7, "CATEGORY"]], "JWST report");

  const rows: ParsedRow[] = [];
  let prime = 0;
  for (const line of lines.slice(hi + 2)) {
    const f = cut(line, starts);
    const [id, , type, start, dur, inst, target, category, keywords] = f as (string | undefined)[];
    if (!id || !/^\d+:\d+:\d+$/.test(id) || !type?.startsWith("PRIME")) continue;
    prime++;
    const t0 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(start ?? "") ? Date.parse(start!) : NaN;
    const d = /^(\d{2})\/(\d{2}):(\d{2}):(\d{2})$/.exec(dur ?? "");
    if (Number.isNaN(t0) || !d) continue;
    const ms = ((Number(d[1]) * 24 + Number(d[2])) * 60 + Number(d[3])) * 60_000 + Number(d[4]) * 1000;
    const cat = category || null;
    const kind: ParsedRow["kind"] =
      /UNTARGETED/.test(type) || !target ? "internal" : /MOVING/.test(type) || /solar system/i.test(cat ?? "") ? "moving" : /WFSC|CALIBRATION/.test(type) || cat === "Calibration" ? "calibration" : "science";
    rows.push({ id, program: id.split(":")[0]!, start: t0, end: t0 + ms, target: target ?? "", instrument: inst ?? "", category: cat, keywords: keywords || null, pi: null, title: null, kind });
  }
  if (prime < 5) throw new FormatError(`JWST report: only ${prime} prime visits found — the format may have changed.`);
  if (rows.length < prime * 0.9) throw new FormatError(`JWST report: ${prime - rows.length} of ${prime} visits had unreadable times or durations.`);
  return rows.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* HST weekly timeline                                                  */
/* ------------------------------------------------------------------ */

/** "timeline_10_12_26" → 2026-10-12. Newest first. */
export function hstTimelines(dirHtml: string): { date: string; url: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const m of dirHtml.matchAll(/href="(timeline_(\d{2})_(\d{2})_(\d{2}))"/g)) {
    const [, name, mm, dd, yy] = m as unknown as string[];
    seen.set(`20${yy}-${mm}-${dd}`, name!);
  }
  return [...seen.entries()].map(([date, name]) => ({ date, name, url: HST_DIR + name })).sort((a, b) => b.date.localeCompare(a.date));
}

const HST_INTERNAL = /^(DARK|BIAS|WAVE|TUNGSTEN|DEUTERIUM|INTFLAT|KSPOT|EARTH|NONE|ANY|FLAT|LAMP|ORBIT|CCDFLAT|UVFLAT|VISFLAT|IRFLAT|DARK-NM)/;
const SOLAR_SYSTEM = /^(OFFSET-)?(MERCURY|VENUS|MARS|JUPITER|SATURN|URANUS|NEPTUNE|PLUTO|MOON|IO|EUROPA|GANYMEDE|CALLISTO|TITAN|ENCELADUS|TRITON|CHARON|CERES|VESTA|PALLAS|COMET)|^\d{4}[A-Z]{2}\d{0,4}$|^C-?\d{4}|^\d{1,4}P-/;

/** Year.dayOfYear + "HH:MM:SS" → epoch ms. */
function doyTime(year: number, doy: number, hms: string): number {
  const [h, m, s] = hms.split(":").map(Number) as [number, number, number];
  return Date.UTC(year, 0, 1) + (doy - 1) * DAY + ((h * 60 + m) * 60 + s) * 1000;
}

export function parseHst(text: string, window?: { from: number; to: number }): { rows: ParsedRow[]; coverage: { start: number; end: number } } {
  const lines = text.split(/\r?\n/);
  const sms = /SMS Start:\s*(\d{4})\.(\d{3}):(\d{2}:\d{2}:\d{2}).*?End:\s*(\d{4})\.(\d{3}):(\d{2}:\d{2}:\d{2})/.exec(text);
  if (!sms) throw new FormatError("Hubble timeline: the “SMS Start … End” coverage line was not found.");
  const coverage = { start: doyTime(Number(sms[1]), Number(sms[2]), sms[3]!), end: doyTime(Number(sms[4]), Number(sms[5]), sms[6]!) };
  if (!(coverage.end > coverage.start && coverage.end - coverage.start < 15 * DAY)) throw new FormatError("Hubble timeline: the coverage dates don't make sense.");

  const hi = lines.findIndex((l) => /Begin UT/.test(l) && /SU Id/.test(l) && /Target/.test(l));
  if (hi < 0 || !/^-{5,}/.test(lines[hi + 1] ?? "")) throw new FormatError("Hubble timeline: the column header line was not found.");
  const starts = columnStarts(lines[hi + 1]!);
  if (starts.length < 10) throw new FormatError("Hubble timeline: fewer columns than expected.");
  expectHeader(lines[hi]!, starts, [[3, "SU Id"], [4, "Investigat"], [6, "Target"], [7, "Instrume"]], "Hubble timeline");

  // Proposal titles (end of the report) — optional, but checked when present.
  const titles = new Map<string, { pi: string; title: string }>();
  const ti = lines.findIndex((l) => /Proposal\s+Titles/.test(l));
  if (ti >= 0) {
    const th = lines.findIndex((l, i) => i > ti && /^\s*-{4,}\s+-{3,}/.test(l));
    if (th > 0) {
      const ts = columnStarts(lines[th]!);
      for (const l of lines.slice(th + 1)) {
        const [prop, , pi, title] = cut(l, ts);
        if (prop && /^\d{4,5}$/.test(prop)) titles.set(prop, { pi: pi ?? "", title: title ?? "" });
      }
    }
  }

  // Rows outside the display window are counted but not cut into columns (saves Worker CPU).
  const dayKey = (t: number) => {
    const d = new Date(t);
    const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
    return `${d.getUTCFullYear()}.${String(doy).padStart(3, "0")}`;
  };
  const fromKey = window ? dayKey(window.from - DAY) : "";
  const toKey = window ? dayKey(window.to + DAY) : "9999";
  const exposures: ParsedRow[] = [];
  let seen = 0, skipped = 0;
  for (const line of lines) {
    if (line.startsWith("-") || !/^\d{4}\.\d{3} /.test(line)) continue;
    if (line.length < starts[7]!) continue;
    seen++;
    const k = line.slice(0, 8);
    if (k < fromKey || k > toKey) {
      skipped++;
      continue;
    }
    const [date, begin, end, su, pi, , target, inst] = cut(line, starts) as string[];
    const dm = /^(\d{4})\.(\d{3})$/.exec(date!);
    if (!dm || !/^\d{2}:\d{2}:\d{2}$/.test(begin!) || !/^\d{2}:\d{2}:\d{2}$/.test(end!) || !/^\d{5}[0-9A-Z]{2}$/.test(su!)) continue;
    const t0 = doyTime(Number(dm[1]), Number(dm[2]), begin!);
    let t1 = doyTime(Number(dm[1]), Number(dm[2]), end!);
    if (t1 < t0) t1 += DAY;
    const program = su!.slice(0, 5);
    const name = target!;
    const internal = HST_INTERNAL.test(name) || inst === "S/C" || !name;
    const info = titles.get(program);
    exposures.push({
      id: `${program} ${su!.slice(5)}`,
      program,
      start: t0,
      end: t1,
      target: name,
      instrument: inst!,
      category: null,
      keywords: null,
      pi: info?.pi || pi || null,
      title: info?.title || null,
      kind: internal ? "internal" : SOLAR_SYSTEM.test(name) ? "moving" : "science",
    });
  }
  if (seen < 20) throw new FormatError(`Hubble timeline: only ${seen} observation rows found — the format may have changed.`);
  if (exposures.length < (seen - skipped) * 0.9) throw new FormatError(`Hubble timeline: ${seen - skipped - exposures.length} of ${seen - skipped} rows were unreadable.`);
  const outside = exposures.filter((e) => e.start < coverage.start - DAY || e.start > coverage.end + DAY).length;
  if (outside > exposures.length * 0.05) throw new FormatError("Hubble timeline: observation dates fall outside the report's own date range.");
  return { rows: mergeVisits(exposures), coverage };
}

/** Merge consecutive exposures of the same visit and target into one block. */
export function mergeVisits(rows: ParsedRow[]): ParsedRow[] {
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const open = new Map<string, ParsedRow>();
  const out: ParsedRow[] = [];
  for (const r of sorted) {
    const key = `${r.id}|${r.target}`;
    const cur = open.get(key);
    if (cur && r.start - cur.end < 2 * HOUR) {
      cur.end = Math.max(cur.end, r.end);
      if (!cur.instrument.split(", ").includes(r.instrument)) cur.instrument += `, ${r.instrument}`;
      continue;
    }
    const copy = { ...r };
    open.set(key, copy);
    out.push(copy);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Positions                                                            */
/* ------------------------------------------------------------------ */

type Pos = { ra: number; dec: number; source: PositionSource; approx: boolean };
const key = (program: string, target: string) => `${program}|${target}`;

interface MastRow {
  proposal_id?: string;
  target_name?: string;
  s_ra?: number | null;
  s_dec?: number | null;
  calib_level?: number;
}

export function mastPositions(raw: unknown): Map<string, Pos> {
  const out = new Map<string, Pos>();
  const data = (raw as { data?: MastRow[] })?.data;
  if (!Array.isArray(data)) throw new SourceError("parse", "MAST returned an unexpected format.");
  for (const r of data) {
    if (typeof r.s_ra !== "number" || typeof r.s_dec !== "number" || !r.proposal_id || !r.target_name) continue;
    const k = key(String(r.proposal_id), r.target_name);
    const planned = r.calib_level === -1;
    const prev = out.get(k);
    if (!prev || (planned && prev.source !== "mast-planned")) out.set(k, { ra: r.s_ra, dec: r.s_dec, source: planned ? "mast-planned" : "mast", approx: false });
  }
  return out;
}

async function queryMast(upstream: Upstream, telescope: TelescopeId, rows: ParsedRow[]): Promise<Map<string, Pos>> {
  const programs = [...new Set(rows.map((r) => r.program))];
  const targets = [...new Set(rows.map((r) => r.target))];
  if (!programs.length) return new Map();
  const filters: { paramName: string; values: unknown[] }[] = [
    { paramName: "obs_collection", values: [telescope] },
    { paramName: "proposal_id", values: programs },
    { paramName: "target_name", values: targets },
  ];
  // JWST: planned observations (calibration level −1) carry the scheduled pointing.
  if (telescope === "JWST") filters.push({ paramName: "calib_level", values: [-1] });
  const request = { service: "Mast.Caom.Filtered", format: "json", pagesize: 5000, page: 1, params: { columns: "proposal_id,target_name,s_ra,s_dec,calib_level", filters } };
  const raw = await upstream.json(`MAST positions (${telescope})`, MAST_API, { form: { request: JSON.stringify(request) }, timeoutMs: 25_000 });
  return mastPositions(raw);
}

/** Names worth asking the resolver about: catalog designations and Bayer star names. */
export function resolvable(target: string): boolean {
  if (/^-[A-Z]{2,4}\d{0,2}-[A-Z]{3}$/.test(target)) return true;
  return /^(NGC|IC|UGC|UGCA|PGC|ESO|HD|HIP|HR|GJ|LHS|WD|TOI|TIC|KOI|KIC|K2|WASP|HAT-P|HATS|KELT|XO|TRES|COROT|KEPLER|QATAR|TYC|BD|CD|GRW|LP|PSR|SN|LTT|ROSS|WOLF|GLIESE|LSPM|EPIC|GAIA|M|MESSIER|ABELL|MRK|MARKARIAN|ARP|NSV|V\d|AG|TW|AU|GD|EG|HZ|FEIGE|BPM|LDS|PG|SDSS)[- +]?\d/i.test(target);
}

/** Sesame text output: "# NAME\t#Q…" then "%J ra dec = …" (or "#! … Nothing found"). */
export function parseSesame(text: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^# (.+?)\t#Q/.exec(line);
    if (head) {
      current = head[1]!.trim();
      continue;
    }
    const j = /^%J\s+([\d.]+)\s+([+-][\d.]+)/.exec(line);
    if (j && current && !out.has(current)) {
      const ra = Number(j[1]), dec = Number(j[2]);
      if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) out.set(current, [ra, dec]);
    }
  }
  return out;
}

async function querySesame(upstream: Upstream, names: string[]): Promise<Map<string, [number, number]>> {
  if (!names.length) return new Map();
  const url = `${SESAME}?${names.map((n) => encodeURIComponent(n)).join("&")}`;
  return parseSesame(await upstream.text("CDS Sesame name resolver", url, { timeoutMs: 12_000 }));
}

/** Sun-angle limits: JWST points 85–135° from the Sun; Hubble no closer than 50°. */
export function sunAngleOk(telescope: TelescopeId, ra: number, dec: number, at: number): boolean {
  const [sra, sdec] = sunPosition(at);
  const e = angularSeparation(ra, dec, sra, sdec);
  return telescope === "JWST" ? e >= 80 && e <= 140 : e >= 45;
}

/* ------------------------------------------------------------------ */
/* One telescope                                                        */
/* ------------------------------------------------------------------ */

async function loadSchedule(
  telescope: TelescopeId,
  upstream: Upstream,
  now: number,
  windowStart: number,
  windowEnd: number,
): Promise<TelescopeSchedule> {
  const sched: TelescopeSchedule = { telescope, error: null, files: [], coverageStart: null, coverageEnd: null, observations: [], internalCount: 0, positions: { found: 0, rejected: 0 } };
  const label = telescope === "JWST" ? "Webb" : "Hubble";
  let rows: ParsedRow[] = [];
  let covStart = Infinity, covEnd = -Infinity;
  try {
    if (telescope === "JWST") {
      const reports = jwstReports(await upstream.text("STScI JWST schedules page", JWST_INDEX, { timeoutMs: 20_000 }));
      if (!reports.length) throw new FormatError("The JWST schedules page no longer links any weekly reports in the expected form.");
      // Current week (newest starting ≤ now) plus next week if already published.
      const current = reports.find((r) => Date.parse(`${r.week}T00:00:00Z`) <= now);
      const next = reports.filter((r) => Date.parse(`${r.week}T00:00:00Z`) > now).pop();
      const chosen = [current, next].filter((r): r is NonNullable<typeof r> => !!r);
      for (const r of chosen) {
        const txt = await upstream.text(`JWST report ${r.name}`, r.url, { timeoutMs: 20_000 });
        const parsed = parseJwst(txt);
        rows.push(...parsed);
        covStart = Math.min(covStart, parsed[0]!.start);
        covEnd = Math.max(covEnd, ...parsed.map((p) => p.end));
        sched.files.push({ url: r.url, label: `Week of ${r.week}` });
      }
    } else {
      const files = hstTimelines(await upstream.text("STScI Hubble timeline directory", `${HST_DIR}?C=M;O=D`, { timeoutMs: 20_000 }));
      if (!files.length) throw new FormatError("The Hubble timeline directory no longer lists files in the expected form.");
      const current = files.find((f) => Date.parse(`${f.date}T00:00:00Z`) <= now);
      const next = files.filter((f) => Date.parse(`${f.date}T00:00:00Z`) > now).pop();
      for (const f of [current, next].filter((x): x is NonNullable<typeof x> => !!x)) {
        const txt = await upstream.text(`Hubble timeline ${f.name}`, f.url, { timeoutMs: 20_000 });
        const parsed = parseHst(txt, { from: windowStart, to: windowEnd });
        rows.push(...parsed.rows);
        covStart = Math.min(covStart, parsed.coverage.start);
        covEnd = Math.max(covEnd, parsed.coverage.end);
        sched.files.push({ url: f.url, label: `Week of ${f.date}` });
      }
    }
  } catch (err) {
    if (err instanceof FormatError) sched.error = { kind: "format", message: `${err.message} Not shown, to avoid displaying wrong data.` };
    else sched.error = { kind: "unreachable", message: (err as Error).message };
    return sched;
  }
  if (!rows.length) {
    sched.error = { kind: "stale", message: `No published ${label} schedule covers the current week yet.` };
    return sched;
  }
  sched.coverageStart = new Date(covStart).toISOString();
  sched.coverageEnd = new Date(covEnd).toISOString();
  if (covEnd < now) {
    sched.error = { kind: "stale", message: `The newest published ${label} schedule ended ${new Date(covEnd).toISOString().slice(0, 10)}; STScI hasn't published the next one yet.` };
    return sched;
  }

  // De-duplicate (a visit can appear in two overlapping reports) and keep the window.
  const uniq = new Map<string, ParsedRow>();
  for (const r of rows) uniq.set(`${r.id}|${r.target}|${r.start}`, r);
  const inWindow = [...uniq.values()].filter((r) => r.end >= windowStart && r.start <= windowEnd).sort((a, b) => a.start - b.start);
  sched.internalCount = inWindow.filter((r) => r.kind === "internal").length;
  const sky = inWindow.filter((r): r is ParsedRow & { kind: ScheduledObservation["kind"] } => r.kind !== "internal");

  // Positions: MAST → name → Sesame. Lookups are best-effort: a failure leaves positions empty.
  const fixed = sky.filter((r) => r.kind !== "moving");
  const pos = new Map<string, Pos>();
  try {
    for (const [k, v] of await queryMast(upstream, telescope, fixed)) pos.set(k, v);
  } catch {
    /* recorded in the upstream log; fall through to the other methods */
  }
  for (const r of fixed) {
    const k = key(r.program, r.target);
    if (pos.has(k)) continue;
    const p = positionFromName(r.target);
    if (p) pos.set(k, { ra: p.ra, dec: p.dec, source: "name", approx: p.approx });
  }
  const unresolved = [...new Set(fixed.filter((r) => !pos.has(key(r.program, r.target)) && resolvable(r.target)).map((r) => r.target))].slice(0, 40);
  if (unresolved.length) {
    try {
      const names = unresolved.map(resolverName);
      const found = await querySesame(upstream, names);
      unresolved.forEach((target, i) => {
        const hit = found.get(names[i]!);
        if (!hit) return;
        for (const r of fixed) if (r.target === target) pos.set(key(r.program, r.target), { ra: hit[0], dec: hit[1], source: "sesame", approx: false });
      });
    } catch {
      /* optional */
    }
  }

  for (const r of sky) {
    const p = r.kind === "moving" ? undefined : pos.get(key(r.program, r.target));
    let ok = !!p;
    if (p && !sunAngleOk(telescope, p.ra, p.dec, r.start)) {
      ok = false;
      sched.positions.rejected++;
    } else if (p) sched.positions.found++;
    sched.observations.push({
      id: r.id,
      program: r.program,
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
      target: r.target,
      instrument: r.instrument,
      category: r.category,
      keywords: r.keywords,
      pi: r.pi,
      title: r.title,
      kind: r.kind,
      ra: ok ? Math.round(p!.ra * 1e5) / 1e5 : null,
      dec: ok ? Math.round(p!.dec * 1e5) / 1e5 : null,
      posSource: ok ? p!.source : null,
      posApprox: ok ? p!.approx : false,
    });
  }
  return sched;
}

export const telescopeSource: SourceModule<"telescopes"> = {
  id: "telescopes",
  title: "Space telescopes",
  provider: "STScI (JWST & HST schedules), MAST, CDS Sesame",
  docsUrl: JWST_INDEX,
  async load({ upstream, now, params }) {
    const t = now.getTime();
    const windowStart = t - 6 * HOUR;
    const windowEnd = addDays(now, 7).getTime();
    // The browser asks for each telescope separately (in parallel): that keeps each request's
    // CPU time well inside the free plan's limit and isolates one schedule's failure.
    const only = params.get("telescope");
    const which: TelescopeId[] = only === "JWST" || only === "HST" ? [only] : ["JWST", "HST"];
    const schedules = await Promise.all(which.map((tel) => loadSchedule(tel, upstream, t, windowStart, windowEnd)));
    if (schedules.every((s) => s.error?.kind === "unreachable")) {
      throw new SourceError("unreachable", `STScI could not be reached: ${schedules[0]!.error!.message}`);
    }
    return { windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString(), schedules } satisfies TelescopeData;
  },
};
