import type { GcnCircular, GcnData, GcnEvent, GcnEventType, GcnPosition } from "../../shared/contract";
import { angularSeparation } from "../../shared/astro";
import { extractPositions } from "../lib/coords";
import { SourceError, type Upstream } from "../lib/upstream";
import { intParam, readParams } from "../lib/params";
import { addDays, isoDate } from "../lib/util";
import type { SourceModule } from "./types";

/**
 * NASA GCN Circulars, read from the public archive at gcn.nasa.gov (no account, no Kafka).
 *
 * - The archive list (newest first, filtered by date) comes from the archive page's own
 *   JSON data route; if that ever changes, the same list is read from the page's HTML.
 * - Each circular's text comes from its official JSON export: /circulars/<id>.json.
 *
 * The list has IDs and subjects only, so events are grouped by the designation in the
 * subject, and positions are read from a budgeted number of circular texts per refresh
 * (the free Workers plan allows 50 upstream requests per request).
 */
export const GCN_BASE = "https://gcn.nasa.gov";
const LIST_LIMIT = 100;
const MAX_PAGES = 5;
const BODY_BUDGET = 40;

interface ListItem {
  circularId: number;
  subject: string;
}

/* ------------------------------------------------------------------ */
/* Event designations in subjects                                      */
/* ------------------------------------------------------------------ */

interface Designation {
  type: GcnEventType;
  name: string;
  /** Other designations of the same event mentioned in the subject (e.g. "EP261007a"). */
  aliases: string[];
  date: string | null;
}

const yymmdd = (s: string): string | null => {
  const y = Number(s.slice(0, 2)), m = Number(s.slice(2, 4)), d = Number(s.slice(4, 6));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `20${String(y).padStart(2, "0")}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
};

/**
 * Recognise the event a subject is about. GW and neutrino designations take precedence:
 * a subject like "LIGO/Virgo/KAGRA S251105aj: … GRB …" is about the GW candidate.
 */
export function designation(subject: string): Designation | null {
  const s = subject.replace(/\s+/g, " ");
  const aliasOf = (exclude: string) => {
    const out: string[] = [];
    for (const m of s.matchAll(/\bEP ?(\d{6}[a-z])\b/g)) out.push(`EP${m[1]}`);
    for (const m of s.matchAll(/\bGRB ?(\d{6}[A-Z])\b/g)) out.push(`GRB ${m[1]}`);
    return [...new Set(out)].filter((a) => a !== exclude);
  };

  // LVK superevents ("S251117dq") are unambiguous; confirmed names ("GW250114") need LVK context.
  const superevent = /\b(S\d{6}[a-z]{1,3})\b/.exec(s);
  const confirmed = /\bGW ?(\d{6}(?:_\d{6})?)\b/.exec(s);
  if (superevent || (confirmed && /LIGO|Virgo|KAGRA|LVK/i.test(s))) {
    const name = superevent ? superevent[1]! : `GW${confirmed![1]}`;
    return { type: "gw", name, aliases: [], date: yymmdd(name.replace(/^\D+/, "")) };
  }

  const nu =
    /\bIceCube(?:[- ](?:Cascade|Alert))?[- ]?(\d{6}[A-Z])\b/i.exec(s) ??
    /\bIC ?(\d{6}[A-Z])\b/.exec(s) ??
    /\bKM3(?:NeT)?[- ]?(\d{6}[A-Z])\b/i.exec(s);
  if (nu) {
    const isKm3 = /KM3/i.test(nu[0]);
    const name = isKm3 ? `KM3NeT-${nu[1]}` : `IceCube-${nu[1]}`;
    return { type: "neutrino", name, aliases: [], date: yymmdd(nu[1]!) };
  }

  const grb = /\bGRB ?(\d{6}[A-Z])\b/.exec(s);
  if (grb) {
    const name = `GRB ${grb[1]}`;
    return { type: "grb", name, aliases: aliasOf(name), date: yymmdd(grb[1]!) };
  }
  // Preliminary trigger names from SVOM/MAXI/Fermi alerts: "GRB261012.23".
  const pre = /\bGRB ?(\d{6}\.\d{2})\b/.exec(s);
  if (pre) return { type: "grb", name: `GRB ${pre[1]}`, aliases: [], date: yymmdd(pre[1]!) };
  return null;
}

/* ------------------------------------------------------------------ */
/* Which circulars to read                                              */
/* ------------------------------------------------------------------ */

/** How likely a circular is to contain the event's best position (higher = read first). */
export function positionScore(subject: string, type: GcnEventType): number {
  const s = subject.toLowerCase();
  if (type === "gw") return /identification|update|sky locali[sz]ation|retraction/.test(s) ? 9 : 1;
  if (type === "neutrino") return /icecube observation|track-like|cascade event|km3net detection|neutrino candidate/.test(s) ? 9 : 1;
  if (/enhanced swift-xrt position/.test(s)) return 12;
  if (/xrt afterglow|uvot|xrt detection|fxt detection/.test(s)) return 11;
  if (/afterglow detection|counterpart detection|optical afterglow|optical counterpart|confirmation of the optical/.test(s)) return 10;
  if (/swift detection|svom detection|bat refined|einstein probe detection|ep-wxt|fxt|maxi.*detection|ipn/.test(s)) return 8;
  if (/locali[sz]ation|position|gbm/.test(s)) return 7;
  if (/detection|observation/.test(s)) return 3;
  return 1;
}

/** Where a position came from, for the UI ("Swift-XRT", "Fermi GBM", …). */
export function positionOrigin(subject: string): string {
  const pairs: [RegExp, string][] = [
    [/xrt/i, "Swift-XRT"], [/uvot/i, "Swift-UVOT"], [/\bbat\b|swift detection/i, "Swift-BAT"],
    [/svom|eclairs|mxt/i, "SVOM"], [/einstein probe|ep-wxt|ep-fxt|\bfxt\b/i, "Einstein Probe"],
    [/gbm/i, "Fermi GBM"], [/\blat\b/i, "Fermi LAT"], [/maxi/i, "MAXI"], [/ipn/i, "IPN"],
    [/icecube/i, "IceCube"], [/km3net/i, "KM3NeT"], [/optical|afterglow|counterpart/i, "optical afterglow"],
  ];
  for (const [re, label] of pairs) if (re.test(subject)) return label;
  return "circular";
}

export interface EventDraft {
  type: GcnEventType;
  name: string;
  aliases: Set<string>;
  date: string | null;
  items: ListItem[];
}

/** Group archive items into events. Aliases (GRB ↔ EP) merge into the GRB name. */
export function groupEvents(items: ListItem[]): { events: EventDraft[]; other: number } {
  const byName = new Map<string, EventDraft>();
  const aliasTo = new Map<string, string>();
  const parsed = items.map((it) => ({ it, d: designation(it.subject) }));
  // First pass: learn aliases ("GRB 261007A / EP261007a").
  for (const { d } of parsed) if (d) for (const a of d.aliases) if (d.type === "grb" && !a.startsWith("GRB")) aliasTo.set(a, d.name);
  let other = 0;
  for (const { it, d } of parsed) {
    if (!d) {
      // "EP261007a: …" without a GRB in the subject: only counted if a GRB alias is known.
      const ep = /\bEP ?(\d{6}[a-z])\b/.exec(it.subject);
      const target = ep ? aliasTo.get(`EP${ep[1]}`) : undefined;
      const ev = target ? byName.get(target) : undefined;
      if (ev) ev.items.push(it);
      else other++;
      continue;
    }
    const name = aliasTo.get(d.name) ?? d.name;
    let ev = byName.get(name);
    if (!ev) {
      ev = { type: d.type, name, aliases: new Set(), date: d.date, items: [] };
      byName.set(name, ev);
    }
    for (const a of d.aliases) if (a !== name) ev.aliases.add(a);
    ev.items.push(it);
  }
  // Items were seen newest first; a late EP-only circular may precede the alias — re-attach is
  // handled above because aliases were collected in the first pass.
  return { events: [...byName.values()], other };
}

/** Pick which circular texts to read: best-scoring per event first, round-robin, newest events first. */
export function chooseBodies(events: EventDraft[], budget: number): number[] {
  const queues = events
    .map((ev) => {
      const sorted = [...ev.items].sort((a, b) => positionScore(b.subject, ev.type) - positionScore(a.subject, ev.type) || b.circularId - a.circularId);
      // Also read the earliest circular (it states the trigger time) once the best one is taken.
      const earliest = ev.items.reduce((m, it) => (it.circularId < m.circularId ? it : m), ev.items[0]!);
      const q = [sorted[0]!, earliest, ...sorted.slice(1)].filter((x, i, arr) => arr.findIndex((y) => y.circularId === x.circularId) === i);
      return { newest: Math.max(...ev.items.map((i) => i.circularId)), q: q.slice(0, 4) };
    })
    .sort((a, b) => b.newest - a.newest);
  const out: number[] = [];
  for (let round = 0; round < 4 && out.length < budget; round++) {
    for (const { q } of queues) {
      const it = q[round];
      if (it && out.length < budget) out.push(it.circularId);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading circular texts                                               */
/* ------------------------------------------------------------------ */

interface RawCircular {
  circularId: number;
  subject: string;
  eventId?: string | null;
  submitter?: string;
  createdOn?: number;
  body?: string;
}

/** Trigger time stated in a circular for an event on `date` (YYYY-MM-DD). */
export function triggerTime(body: string, date: string | null): string | null {
  if (!date) return null;
  const t = body.replace(/\s+/g, " ");
  const iso = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(t);
  const cand: string[] = [];
  if (iso) cand.push(`${iso[1]}T${iso[2]}Z`);
  const ut = /\b(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(?:UT|UTC)\b/.exec(t);
  if (ut) cand.push(`${date}T${ut[1]}:${ut[2]}:${ut[3]}Z`);
  for (const c of cand) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime()) && Math.abs(d.getTime() - new Date(`${date}T12:00:00Z`).getTime()) <= 36 * 3600_000) return d.toISOString();
  }
  return null;
}

/** LVK: "the 90% credible region is 1701 deg2" and "classification … is BBH (>99%), …". */
export function gwInfo(body: string): { areaDeg2: number | null; classification: string | null } {
  const t = body.replace(/\s+/g, " ");
  const areas = [...t.matchAll(/90% credible region is (\d+(?:\.\d+)?) deg2/gi)].map((m) => Number(m[1]));
  const cls = /classification of the GW signal, in order of descending probability, is ([^.]+?)\./i.exec(t);
  const first = cls ? /^(BNS|NSBH|BBH|Terrestrial)\s*\(([^)]+)\)/i.exec(cls[1]!.trim()) : null;
  return { areaDeg2: areas.length ? areas[areas.length - 1]! : null, classification: first ? `${first[1]} (${first[2]})` : null };
}

/**
 * Best position for an event from the positions found in its circulars. Prefers the smallest
 * stated error; a precise position is only accepted if it lies inside the coarser error
 * circles of the same event (guards against a circular that lists some other source).
 */
export function bestPosition(cands: GcnPosition[]): GcnPosition | null {
  if (!cands.length) return null;
  const withErr = cands.filter((c) => c.errDeg !== null).sort((a, b) => a.errDeg! - b.errDeg!);
  for (const c of withErr) {
    const consistent = withErr.every((o) => o === c || o.errDeg! <= c.errDeg! || angularSeparation(c.ra, c.dec, o.ra, o.dec) <= 3 * o.errDeg! + 0.5);
    if (consistent) return c;
  }
  // No stated errors: use the first position of the highest-priority circular (already ordered).
  return withErr[0] ?? cands[0]!;
}

export function stripEmail(submitter: string): string {
  return submitter.replace(/\s*<[^>]*>/g, "").replace(/\S+@\S+/g, "").trim();
}

export function normalizeCircular(raw: RawCircular): GcnCircular {
  return {
    id: raw.circularId,
    subject: (raw.subject ?? "").trim(),
    eventId: raw.eventId ?? null,
    submitter: stripEmail(raw.submitter ?? ""),
    createdOn: typeof raw.createdOn === "number" ? new Date(raw.createdOn).toISOString() : null,
    body: raw.body ?? "",
    url: `${GCN_BASE}/circulars/${raw.circularId}`,
  };
}

/* ------------------------------------------------------------------ */
/* Archive list                                                         */
/* ------------------------------------------------------------------ */

export function parseListJson(raw: unknown): { items: ListItem[]; totalPages: number; totalItems: number } {
  const r = raw as { items?: { circularId?: unknown; subject?: unknown }[]; totalPages?: unknown; totalItems?: unknown };
  if (!r || !Array.isArray(r.items)) throw new SourceError("parse", "The GCN archive list had an unexpected format.");
  const items = r.items
    .map((i) => ({ circularId: Number(i.circularId), subject: String(i.subject ?? "").replace(/\s+/g, " ").trim() }))
    .filter((i) => Number.isInteger(i.circularId) && i.circularId > 0);
  return { items, totalPages: Number(r.totalPages) || 1, totalItems: Number(r.totalItems) || items.length };
}

/** Fallback: the archive page's HTML list (<a href="/circulars/45943">subject</a>). */
export function parseListHtml(html: string): ListItem[] {
  const out: ListItem[] = [];
  for (const m of html.matchAll(/<a[^>]*href="\/circulars\/(\d+)"[^>]*>([^<]{3,300})<\/a>/g)) {
    out.push({ circularId: Number(m[1]), subject: m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() });
  }
  return out;
}

async function loadList(upstream: Upstream, startDate: string): Promise<{ items: ListItem[]; total: number }> {
  const base = `${GCN_BASE}/circulars?startDate=${startDate}&limit=${LIST_LIMIT}`;
  try {
    const first = parseListJson(await upstream.json("GCN archive list", `${base}&_data=routes%2Fcirculars._archive._index`, { timeoutMs: 15_000 }));
    const items = [...first.items];
    const pages = Math.min(first.totalPages, MAX_PAGES);
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) =>
        upstream.json(`GCN archive list p${i + 2}`, `${base}&page=${i + 2}&_data=routes%2Fcirculars._archive._index`, { timeoutMs: 15_000 }).then(parseListJson),
      ),
    );
    for (const r of rest) items.push(...r.items);
    return { items, total: first.totalItems };
  } catch (err) {
    // The data route is part of the archive website, not a documented API: fall back to its HTML.
    const html = await upstream.text("GCN archive page", base, { timeoutMs: 15_000 }).catch(() => {
      throw err;
    });
    const items = parseListHtml(html);
    if (!items.length) throw err;
    return { items, total: items.length };
  }
}

export async function fetchCircular(upstream: Upstream, id: number): Promise<GcnCircular> {
  const raw = await upstream.json<RawCircular>(`GCN Circular ${id}`, `${GCN_BASE}/circulars/${id}.json`, { timeoutMs: 12_000 });
  if (!raw || typeof raw.body !== "string" || Number(raw.circularId) !== id) {
    throw new SourceError("parse", `GCN Circular ${id} had an unexpected format.`);
  }
  return normalizeCircular(raw);
}

/* ------------------------------------------------------------------ */
/* Assemble                                                             */
/* ------------------------------------------------------------------ */

const MISSION_SUBJECT = /Swift|XRT|UVOT|\bBAT\b|SVOM|ECLAIRs|MXT|Einstein Probe|\bEP-|WXT|FXT|Fermi|GBM|\bLAT\b|MAXI|IceCube|KM3NeT|INTEGRAL|\bIPN\b|Konus|AstroSat|GECAM|GRID|Glowbug|AGILE|Insight-HXMT|CALET/i;

/**
 * Preliminary names like "GRB 261007.23" (SVOM/MAXI alerts, day fraction .23 ≈ 05:31 UT)
 * usually refer to a burst that later got a letter. Merge one into the same-day lettered
 * GRB whose stated trigger time is within 20 minutes; otherwise keep it as its own event.
 */
export function mergePreliminary(events: GcnEvent[]): GcnEvent[] {
  const out = events.filter((e) => !/^GRB \d{6}\.\d{2}$/.test(e.name));
  for (const pre of events.filter((e) => /^GRB \d{6}\.\d{2}$/.test(e.name))) {
    const frac = Number(pre.name.slice(-3));
    const t = Date.parse(`${pre.date}T00:00:00Z`) + frac * 86_400_000;
    const host = out.find((e) => e.type === "grb" && e.date === pre.date && e.triggerTime && Math.abs(Date.parse(e.triggerTime) - t) <= 20 * 60_000);
    if (host) {
      host.aliases = [...new Set([...host.aliases, pre.name])];
      host.circulars = [...host.circulars, ...pre.circulars].sort((a, b) => b.id - a.id);
    } else {
      // The day fraction is the alert time; a time found in the text may be an observation time.
      out.push({ ...pre, triggerTime: Number.isFinite(t) ? new Date(t).toISOString() : pre.triggerTime });
    }
  }
  return out;
}

export function buildEvents(drafts: EventDraft[], bodies: Map<number, GcnCircular>): GcnEvent[] {
  const built = drafts
    .map((ev) => {
      const read = ev.items
        .map((it) => bodies.get(it.circularId))
        .filter((c): c is GcnCircular => !!c)
        .sort((a, b) => positionScore(b.subject, ev.type) - positionScore(a.subject, ev.type));
      const cands: GcnPosition[] = [];
      let trig: string | null = null;
      let gw: GcnEvent["gw"] = null;
      for (const c of [...read].sort((a, b) => a.id - b.id)) trig ??= triggerTime(c.body, ev.date);
      if (ev.type === "gw") {
        // GW localizations are probability sky maps, not points: report area and class instead.
        let area: number | null = null, cls: string | null = null;
        for (const c of [...read].sort((a, b) => a.id - b.id)) {
          const g = gwInfo(c.body);
          area = g.areaDeg2 ?? area;
          cls = g.classification ?? cls;
        }
        gw = { areaDeg2: area, classification: cls, skymapUrl: `https://gracedb.ligo.org/superevents/${encodeURIComponent(ev.name)}/view/` };
      } else {
        for (const c of read) {
          // Neutrinos: only the detector team's own circulars (others discuss nearby sources).
          if (ev.type === "neutrino" && positionScore(c.subject, "neutrino") < 9) continue;
          // Every position with a stated error (Swift reports BAT, XRT and UVOT in one circular),
          // plus the first one without; bestPosition() then discards inconsistent ones.
          const found = extractPositions(c.body);
          const use = found.filter((p, i) => p.errDeg !== null || i === 0);
          // Instrument names in a mission's own circular identify the position (BAT/XRT/UVOT);
          // in a ground-based follow-up they are just citations, so label by the subject.
          const mission = MISSION_SUBJECT.test(c.subject);
          for (const p of use) {
            cands.push({ ra: round(p.ra, 5), dec: round(p.dec, 5), errDeg: p.errDeg, circularId: c.id, from: (mission && p.instrument) || positionOrigin(c.subject) });
          }
        }
      }
      const circulars = [...ev.items]
        .sort((a, b) => b.circularId - a.circularId)
        .map((it) => ({ id: it.circularId, subject: it.subject, createdOn: bodies.get(it.circularId)?.createdOn ?? null }));
      return {
        name: ev.name,
        type: ev.type,
        aliases: [...ev.aliases],
        date: ev.date ?? "",
        triggerTime: trig,
        position: ev.type === "gw" ? null : bestPosition(cands),
        gw,
        circulars,
      } satisfies GcnEvent;
    });
  return mergePreliminary(built).sort(
    (a, b) => (b.triggerTime ?? `${b.date}T00`).localeCompare(a.triggerTime ?? `${a.date}T00`) || b.circulars[0]!.id - a.circulars[0]!.id,
  );
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Query parameters this source reads (also its cache key, see lib/params.ts). */
const PARAMS = { days: intParam(1, 30, 7) };

export const gcnSource: SourceModule<"gcn"> = {
  id: "gcn",
  title: "Cosmic explosions",
  provider: "NASA GCN Circulars",
  docsUrl: "https://gcn.nasa.gov/circulars",
  maxAge: 300, // ~130 circulars a week; live mode polls every 10 min
  params: PARAMS,
  async load({ upstream, params, now, notices }) {
    const { days } = readParams(PARAMS, params);
    const start = addDays(now, -days);
    const { items, total } = await loadList(upstream, isoDate(start));
    const { events: drafts } = groupEvents(items);
    // Events older than the window (follow-ups of old bursts) are kept only if dated in it.
    const startDay = isoDate(addDays(start, -1));
    const inWindow = drafts.filter((d) => !d.date || d.date >= startDay);
    const ids = chooseBodies(inWindow, BODY_BUDGET);
    const bodies = new Map<number, GcnCircular>();
    const settled = await Promise.allSettled(ids.map((id) => fetchCircular(upstream, id)));
    let failed = 0;
    for (const r of settled) {
      if (r.status === "fulfilled") bodies.set(r.value.id, r.value);
      else failed++;
    }
    if (ids.length && failed === ids.length) {
      notices.push({ level: "warning", text: "The circular texts could not be read, so positions are missing. The event list itself is complete." });
    } else if (failed) {
      notices.push({ level: "info", text: `${failed} circular${failed > 1 ? "s" : ""} could not be read this time; some positions may be missing.` });
    }
    return {
      days,
      windowStart: start.toISOString(),
      totalCirculars: total,
      bodiesRead: bodies.size,
      events: buildEvents(inWindow, bodies),
    } satisfies GcnData;
  },
};
