import type { GoesData, GoesFlare } from "../../shared/contract";
import { oneOf, readParams } from "../lib/params";
import { SourceError, type Upstream } from "../lib/upstream";
import type { SourceModule } from "./types";

/**
 * Real-time GOES X-ray flux from NOAA SWPC (primary GOES satellite, 1-minute averages,
 * updated every minute; responses are cacheable for 60 s). Two channels:
 * 0.1–0.8 nm (the "long" channel that defines flare classes) and 0.05–0.4 nm.
 *
 * Live mode asks for the 6-hour file each minute (~160 KB) and the browser merges it into
 * the 24-hour series it already has, so a full day (~650 KB) is parsed only on a full refresh.
 */
export const SWPC_BASE = "https://services.swpc.noaa.gov/json/goes/primary";

interface RawFlux {
  time_tag?: string;
  satellite?: number;
  flux?: number | null;
  energy?: string;
}

interface RawFlare {
  time_tag?: string;
  begin_time?: string | null;
  max_time?: string | null;
  end_time?: string | null;
  max_class?: string | null;
  max_xrlong?: number | null;
  current_class?: string | null;
}

const LONG = "0.1-0.8nm";
const SHORT = "0.05-0.4nm";

export function parseFlux(raw: unknown): { points: GoesData["points"]; satellite: number | null } {
  if (!Array.isArray(raw)) throw new SourceError("parse", "SWPC X-ray data had an unexpected format.");
  const byTime = new Map<number, [number, number | null, number | null]>();
  let satellite: number | null = null;
  for (const r of raw as RawFlux[]) {
    const t = r.time_tag ? Date.parse(r.time_tag) : NaN;
    if (Number.isNaN(t)) continue;
    // SWPC reports missing or below-floor data as 1e-9 (or ≤ 0); treat those as gaps, not readings.
    const f = typeof r.flux === "number" && r.flux > 1.001e-9 ? r.flux : null;
    const row = byTime.get(t) ?? [t, null, null];
    if (r.energy === LONG) row[1] = f;
    else if (r.energy === SHORT) row[2] = f;
    else continue;
    byTime.set(t, row);
    if (typeof r.satellite === "number") satellite = r.satellite;
  }
  const points = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  if (raw.length > 10 && !points.some((p) => p[1] !== null)) {
    throw new SourceError("parse", "SWPC X-ray data contained no 0.1–0.8 nm readings — the format may have changed.");
  }
  return { points, satellite };
}

/** GOES class → flux, e.g. "M2.3" → 2.3e-5. */
export function classFlux(cls: string | null | undefined): number | null {
  const m = /^([ABCMX])(\d+(?:\.\d+)?)$/.exec((cls ?? "").trim());
  if (!m) return null;
  return { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 }[m[1] as "A"] * Number(m[2]);
}

export function parseFlare(r: RawFlare): GoesFlare | null {
  const begin = r.begin_time ? Date.parse(r.begin_time) : NaN;
  const max = r.max_time ? Date.parse(r.max_time) : NaN;
  if (Number.isNaN(begin) || Number.isNaN(max) || !r.max_class) return null;
  const end = r.end_time ? Date.parse(r.end_time) : NaN;
  return {
    begin: new Date(begin).toISOString(),
    max: new Date(max).toISOString(),
    end: Number.isNaN(end) ? null : new Date(end).toISOString(),
    maxClass: r.max_class,
    maxFlux: typeof r.max_xrlong === "number" && r.max_xrlong > 0 ? r.max_xrlong : (classFlux(r.max_class) ?? 0),
  };
}

/**
 * SWPC rewrites these files every minute; very occasionally a request catches one half-written
 * (valid JSON at the start, cut off later). Retry once after a moment before reporting it.
 */
async function fetchFlux(upstream: Upstream, url: string): Promise<unknown> {
  try {
    return await upstream.json<unknown>("SWPC GOES X-ray flux", url, { timeoutMs: 15_000 });
  } catch (err) {
    if (!(err instanceof SourceError) || err.kind !== "parse") throw err;
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await upstream.json<unknown>("SWPC GOES X-ray flux (retry)", url, { timeoutMs: 15_000 });
    } catch (err2) {
      if (err2 instanceof SourceError && err2.kind === "parse") {
        throw new SourceError("parse", "SWPC sent an incomplete X-ray file twice (it is rewritten every minute); the next update should succeed.");
      }
      throw err2;
    }
  }
}

/** Query parameters this source reads (also its cache key, see lib/params.ts). */
const PARAMS = { hours: oneOf("24", "6") };

export const goesSource: SourceModule<"goes"> = {
  id: "goes",
  title: "GOES X-ray flux",
  provider: "NOAA SWPC",
  docsUrl: "https://www.swpc.noaa.gov/products/goes-x-ray-flux",
  maxAge: 60, // SWPC rewrites the files every minute (and caches them for 60 s); live mode polls every minute
  params: PARAMS,
  async load({ upstream, params }) {
    const hours = readParams(PARAMS, params).hours === "6" ? 6 : 24;
    const fluxUrl = `${SWPC_BASE}/${hours === 6 ? "xrays-6-hour" : "xrays-1-day"}.json`;
    const [flux, latest, list] = await Promise.all([
      fetchFlux(upstream, fluxUrl),
      upstream.json<RawFlare[]>("SWPC latest flare", `${SWPC_BASE}/xray-flares-latest.json`, { timeoutMs: 10_000 }).catch(() => null),
      hours === 24 ? upstream.json<RawFlare[]>("SWPC flare list (7 days)", `${SWPC_BASE}/xray-flares-7-day.json`, { timeoutMs: 10_000 }).catch(() => null) : Promise.resolve(null),
    ]);
    const { points, satellite } = parseFlux(flux);
    const since = points.length ? points[0]![0] : 0;
    const flares = (Array.isArray(list) ? list : []).map(parseFlare).filter((f): f is GoesFlare => !!f && Date.parse(f.max) >= since);
    const lr = Array.isArray(latest) ? latest[0] : null;
    const lf = lr ? parseFlare(lr) : null;
    return {
      satellite,
      hours,
      points,
      flares,
      latestFlare: lf ? { ...lf, currentClass: lr?.current_class ?? null } : null,
    } satisfies GoesData;
  },
};
