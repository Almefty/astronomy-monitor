import type { SatelliteElements, SatelliteOmm, SatellitesData } from "../../shared/contract";
import { SourceError, type Upstream } from "../lib/upstream";
import { num } from "../lib/util";
import type { SourceModule } from "./types";

const GP = "https://celestrak.org/NORAD/elements/gp.php";

/**
 * The spacecraft the "Sky tonight" panel predicts passes for. The one place to add or remove one.
 *
 * `stdMag` is the standard magnitude (1,000 km range, half illuminated) from Mike McCants' qs.mag
 * file, as carried in Stellarium's satellite catalogue (plugins/Satellites/resources/satellites.json,
 * updated 2026-06-24). These are rough: real brightness depends on attitude and solar panels, and
 * Tiangong's value may predate its 2022 modules (likely too faint).
 */
export const SATELLITE_LIST: readonly { id: number; name: string; stdMag: number }[] = [
  { id: 25544, name: "ISS", stdMag: -2.5 },
  { id: 48274, name: "Tiangong", stdMag: 1.87 },
  { id: 20580, name: "Hubble", stdMag: 1.5 },
];

/** Elements older than this are flagged: SGP4 errors grow to minutes within a week or two. */
export const STALE_AFTER_DAYS = 7;

/**
 * CelesTrak updates GP data every 2 hours and blocks clients that download the same data more often
 * (usage policy, https://celestrak.org/usage-policy.php, updated 2026-05-22). Cloudflare's cache
 * answers repeats for this long, so each data centre asks at most once per update.
 */
const MAX_AGE = 2 * 3600;
/**
 * Failed or partial answers (an HTTP error, a timeout) are cached for 10 minutes instead of not at all.
 * This is a deliberate exception to CLAUDE.md's "no-store for errors and partial failures": CelesTrak
 * asks clients to stop querying after a non-200 answer and firewalls those that don't, so an outage
 * must not turn every visitor's refresh into another request. Ten minutes keeps a fix from waiting long.
 */
export const FAILURE_MAX_AGE = 600;

/** CelesTrak's body for a catalog number without current GP data (sent with HTTP 404). */
const NO_DATA = /^\s*No GP data found/i;

const NUMERIC_FIELDS = [
  "NORAD_CAT_ID", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER",
  "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
] as const;

/** The epoch as UTC ms. OMM epochs carry no zone suffix but are UTC. */
export function ommEpochMs(epoch: string): number | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z?$/.test(epoch)) return null;
  const ms = Date.parse(epoch.endsWith("Z") ? epoch : `${epoch}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pick object `id` from a CelesTrak OMM JSON answer and keep only what SGP4 needs plus name, ID and
 * epoch. Returns null if the answer doesn't hold a usable element set for it.
 */
export function slimOmm(json: unknown, id: number): SatelliteOmm | null {
  if (!Array.isArray(json)) return null;
  const raw = json.find((r): r is Record<string, unknown> => !!r && typeof r === "object" && num((r as Record<string, unknown>).NORAD_CAT_ID) === id);
  if (!raw) return null;
  const n: Record<string, number> = {};
  for (const f of NUMERIC_FIELDS) {
    const v = num(raw[f]);
    if (v === null) return null;
    n[f] = v;
  }
  const epoch = typeof raw.EPOCH === "string" ? raw.EPOCH.trim() : "";
  if (ommEpochMs(epoch) === null) return null;
  // Earth orbiters only: SGP4 needs 0 ≤ e < 1 and a positive mean motion.
  if (!(n.MEAN_MOTION! > 0 && n.ECCENTRICITY! >= 0 && n.ECCENTRICITY! < 1)) return null;
  return {
    OBJECT_NAME: typeof raw.OBJECT_NAME === "string" ? raw.OBJECT_NAME.trim() : "",
    OBJECT_ID: typeof raw.OBJECT_ID === "string" ? raw.OBJECT_ID.trim() : "",
    NORAD_CAT_ID: n.NORAD_CAT_ID!,
    EPOCH: epoch,
    MEAN_MOTION: n.MEAN_MOTION!,
    ECCENTRICITY: n.ECCENTRICITY!,
    INCLINATION: n.INCLINATION!,
    RA_OF_ASC_NODE: n.RA_OF_ASC_NODE!,
    ARG_OF_PERICENTER: n.ARG_OF_PERICENTER!,
    MEAN_ANOMALY: n.MEAN_ANOMALY!,
    BSTAR: n.BSTAR!,
    MEAN_MOTION_DOT: n.MEAN_MOTION_DOT!,
    MEAN_MOTION_DDOT: n.MEAN_MOTION_DDOT!,
    ELEMENT_SET_NO: num(raw.ELEMENT_SET_NO) ?? 999,
  };
}

/** Age of an element set in days at `now` (negative if the epoch is in the future). */
export function epochAgeDays(epochMs: number, now: number): number {
  return (now - epochMs) / 86_400_000;
}

/**
 * Per-request timeout. CelesTrak was seen answering in 5–10 s per request (2026-11); the requests run in
 * parallel, so this bounds the whole load. Generous, because a timeout costs a 10-minute failure cache.
 */
export const REQUEST_TIMEOUT_MS = 25_000;

type Outcome =
  | { sat: (typeof SATELLITE_LIST)[number]; kind: "ok"; omm: SatelliteOmm }
  | { sat: (typeof SATELLITE_LIST)[number]; kind: "missing"; reason: string }
  | { sat: (typeof SATELLITE_LIST)[number]; kind: "error"; error: SourceError };

/** One object's elements; never throws (failures become an outcome). */
async function fetchOne(upstream: Upstream, sat: (typeof SATELLITE_LIST)[number]): Promise<Outcome> {
  const url = `${GP}?CATNR=${sat.id}&FORMAT=JSON`;
  let text: string;
  try {
    const res = await upstream.fetch(`CelesTrak GP elements (${sat.name})`, url, { acceptStatus: [404], timeoutMs: REQUEST_TIMEOUT_MS });
    text = await res.text();
    if (res.status === 404) {
      // CelesTrak's documented answer for an object without current elements: about that object, not a failure.
      if (!NO_DATA.test(text)) throw new SourceError("upstream", `CelesTrak GP elements (${sat.name}) answered HTTP 404: ${text.slice(0, 120).trim()}`);
      return { sat, kind: "missing", reason: "CelesTrak has no current elements for it." };
    }
  } catch (err) {
    return { sat, kind: "error", error: err instanceof SourceError ? err : new SourceError("upstream", String((err as Error)?.message ?? err)) };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // CelesTrak answers some bad queries with HTTP 200 and a plain-text message.
  }
  const omm = slimOmm(json, sat.id);
  if (!omm) return { sat, kind: "missing", reason: `CelesTrak's answer had no usable elements (starts with "${text.slice(0, 60).trim()}").` };
  return { sat, kind: "ok", omm };
}

export const satellitesSource: SourceModule<"satellites"> = {
  id: "satellites",
  title: "Sky tonight (spacecraft orbital elements)",
  provider: "CelesTrak · GP orbital data (US Space Force, via Space-Track.org)",
  docsUrl: "https://celestrak.org/NORAD/documentation/gp-data-formats.php",
  maxAge: MAX_AGE,
  failureMaxAge: FAILURE_MAX_AGE,

  async load({ upstream, now, notices }) {
    // CATNR takes one catalog number per query (a list is rejected), so one small call per object
    // (~420 bytes each). They run in parallel: CelesTrak can take 5–10 s per answer, and three in a row
    // took ~24 s in production. Any failure (non-200 other than "No GP data found", timeout, network
    // error) makes the whole answer a failure or a partial one, which is cached for FAILURE_MAX_AGE only,
    // so after an error no request goes to CelesTrak from that data centre for 10 minutes (its usage
    // policy asks clients to stop after a non-200). In parallel the other two calls are already on their
    // way when one fails: at most two extra requests per error, not a retry.
    const outcomes = await Promise.all(SATELLITE_LIST.map((sat) => fetchOne(upstream, sat)));
    const satellites: SatelliteElements[] = [];
    const unavailable: SatellitesData["unavailable"] = [];
    /** Objects CelesTrak answered for without usable elements (the same until its next update). */
    const missing: string[] = [];
    /** Objects whose request failed (non-200, timeout, network). */
    const failed: string[] = [];
    let firstError: SourceError | null = null;
    for (const o of outcomes) {
      if (o.kind === "ok") {
        satellites.push({ id: o.sat.id, name: o.sat.name, stdMag: o.sat.stdMag, epoch: new Date(ommEpochMs(o.omm.EPOCH)!).toISOString(), omm: o.omm });
      } else if (o.kind === "missing") {
        unavailable.push({ id: o.sat.id, name: o.sat.name, reason: o.reason });
        missing.push(o.sat.name);
      } else {
        unavailable.push({ id: o.sat.id, name: o.sat.name, reason: o.error.message });
        failed.push(o.sat.name);
        firstError ??= o.error;
      }
    }

    if (!satellites.length) {
      // Cached for FAILURE_MAX_AGE (see above), so an outage isn't re-requested by every visitor.
      throw firstError ?? new SourceError("parse", "CelesTrak returned no usable orbital elements.");
    }
    const names = (list: string[]) => list.join(" and ");
    if (failed.length) {
      // A warning: this partial answer is cached for FAILURE_MAX_AGE, not the full two hours.
      notices.push({ level: "warning", text: `Orbital elements for ${names(failed)} couldn’t be loaded from CelesTrak this time; no passes are predicted for ${failed.length > 1 ? "them" : "it"}.` });
    }
    // An object CelesTrak answered for but has no usable elements is the same on every request until
    // its next update, so it is "info" and the answer keeps the full cache lifetime: one persistently
    // missing object mustn't make every visitor re-ask CelesTrak for all of them.
    if (missing.length) {
      notices.push({ level: "info", text: `CelesTrak has no usable orbital elements for ${names(missing)} right now; no passes are predicted for ${missing.length > 1 ? "them" : "it"}.` });
    }

    // Stale elements are flagged as "info", not "warning": a warning would cut the cache lifetime to
    // FAILURE_MAX_AGE, and re-downloading can't make CelesTrak's elements newer (its policy asks for
    // one download per update). The panel also compares each epoch with the current time itself.
    const stale = satellites
      .map((s) => ({ s, age: epochAgeDays(Date.parse(s.epoch), now.getTime()) }))
      .filter(({ age }) => age > STALE_AFTER_DAYS);
    for (const { s, age } of stale) {
      notices.push({ level: "info", text: `${s.name}’s orbital elements are ${Math.floor(age)} days old, so its predicted passes may be off by minutes.` });
    }

    const data: SatellitesData = { satellites, unavailable, staleAfterDays: STALE_AFTER_DAYS };
    return data;
  },
};
