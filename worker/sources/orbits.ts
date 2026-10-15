import type { OrbitsData, SmallBodyOrbit } from "../../shared/contract";
import { intParam, readParams } from "../lib/params";
import { SourceError } from "../lib/upstream";
import { addDays, isoDate, num } from "../lib/util";
import { parseCad } from "./neo";
import type { SourceModule } from "./types";

const CAD = "https://ssd-api.jpl.nasa.gov/cad.api";
const SBDB_QUERY = "https://ssd-api.jpl.nasa.gov/sbdb_query.api";
const FIELDS = "pdes,pha,epoch,e,q,i,om,w,tp,orbit_id,condition_code,data_arc";
/**
 * sb-cdata may be at most 2048 characters (JPL docs), but in practice JPL's server answers 502
 * once the filter passes ~1,000 characters (~46 designations, tested 15 Oct 2026), so chunks
 * stay at ~30 designations and run in parallel (~1 s each).
 */
const MAX_CDATA = 700;

interface QueryResponse {
  fields?: string[];
  data?: (string | number | null)[][];
  count?: number;
}

/**
 * The SBDB Query API rejects spaces in `EQ` values (despite its docs, Oct 2026), so each
 * designation becomes an anchored regex. Only characters that are literal in a regex and allowed
 * by the API are accepted; anything else is skipped rather than escaped.
 */
export function designationFilter(des: string): string | null {
  return /^[A-Za-z0-9 /-]{1,24}$/.test(des) ? `pdes|RE|^${des}$` : null;
}

/** Split designations into `sb-cdata` OR-constraints that each fit the length limit. */
export function cdataChunks(designations: string[], maxLen = MAX_CDATA): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const build = (list: string[]) => JSON.stringify({ OR: list });
  for (const d of designations) {
    const f = designationFilter(d);
    if (!f) continue;
    if (cur.length && build([...cur, f]).length > maxLen) {
      out.push(build(cur));
      cur = [];
    }
    cur.push(f);
  }
  // A single constraint is never "OR"-ed on its own (the API wants ≥ 2 for OR).
  if (cur.length === 1) out.push(JSON.stringify({ AND: cur }));
  else if (cur.length) out.push(build(cur));
  return out;
}

/** Normalize SBDB query rows into orbits keyed by primary designation. */
export function parseOrbits(json: QueryResponse): Record<string, SmallBodyOrbit & { pha: boolean }> {
  const fields = json.fields ?? [];
  const col = (n: string) => fields.indexOf(n);
  const c = { des: col("pdes"), pha: col("pha"), epoch: col("epoch"), e: col("e"), q: col("q"), i: col("i"), om: col("om"), w: col("w"), tp: col("tp"), orbit: col("orbit_id"), cc: col("condition_code"), arc: col("data_arc") };
  if (c.des < 0 || c.e < 0 || c.q < 0 || c.tp < 0) throw new SourceError("parse", "JPL SBDB query response is missing orbit fields.");
  const out: Record<string, SmallBodyOrbit & { pha: boolean }> = {};
  for (const row of json.data ?? []) {
    const at = (i: number) => (i >= 0 ? (row[i] ?? null) : null);
    const des = String(at(c.des) ?? "").trim();
    const e = num(at(c.e)), q = num(at(c.q)), i = num(at(c.i)), om = num(at(c.om)), w = num(at(c.w)), tp = num(at(c.tp)), epoch = num(at(c.epoch));
    if (!des || e === null || q === null || i === null || om === null || w === null || tp === null || epoch === null) continue;
    if (!(e >= 0 && e < 20 && q > 0 && q < 100)) continue;
    const cc = num(at(c.cc));
    out[des] = {
      e, q, i, om, w, tp, epoch,
      orbitId: String(at(c.orbit) ?? "").trim(),
      conditionCode: cc === null ? null : Math.round(cc),
      dataArcDays: num(at(c.arc)),
      pha: at(c.pha) === "Y",
    };
  }
  return out;
}

const PARAMS = { past: intParam(0, 30, 7), ahead: intParam(7, 120, 60) };

export const orbitsSource: SourceModule<"orbits"> = {
  id: "orbits",
  title: "Solar System in 3D (close-approach asteroid orbits)",
  provider: "NASA/JPL SSD · CNEOS Close Approach Data API + SBDB Query API",
  docsUrl: "https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html",
  maxAge: 3600, // same as close approaches; orbits are updated a few times a day at most
  params: PARAMS,

  async load({ upstream, params, now, notices }) {
    const { past, ahead } = readParams(PARAMS, params);
    const distMaxAu = 0.05;
    const start = addDays(now, -past);
    const end = addDays(now, ahead);
    const q = new URLSearchParams({ "date-min": isoDate(start), "date-max": isoDate(end), "dist-max": String(distMaxAu), diameter: "true", fullname: "true", sort: "date" });
    const cad = await upstream.json<Parameters<typeof parseCad>[0]>("JPL CAD (close approaches)", `${CAD}?${q}`);
    const approachesRaw = parseCad(cad, new Set());
    const designations = [...new Set(approachesRaw.map((a) => a.des))];

    // Orbits in a few parallel queries. `sb-group=neo` makes the regex match fast (~1 s instead of
    // ~15 s); every CAD object is a NEO, since CAD lists only NEOs by default.
    const chunks = cdataChunks(designations);
    const results = await Promise.allSettled(
      chunks.map((cdata, k) => {
        const qs = new URLSearchParams({ fields: FIELDS, "sb-group": "neo", "full-prec": "true", "sb-cdata": cdata });
        return upstream.json<QueryResponse>(`JPL SBDB orbits (${k + 1}/${chunks.length})`, `${SBDB_QUERY}?${qs.toString().replace(/\+/g, "%20")}`, { timeoutMs: 25_000 });
      }),
    );
    const orbits: Record<string, SmallBodyOrbit> = {};
    const pha = new Set<string>();
    let failed = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        failed++;
        continue;
      }
      for (const [des, o] of Object.entries(parseOrbits(r.value))) {
        const { pha: isPha, ...orbit } = o;
        orbits[des] = orbit;
        if (isPha) pha.add(des);
      }
    }
    if (chunks.length && failed === chunks.length) {
      notices.push({ level: "warning", text: "Asteroid orbits couldn’t be loaded from JPL’s Small-Body Database this time; planets are shown, asteroids are listed without positions." });
    } else if (failed) {
      notices.push({ level: "warning", text: `Some asteroid orbits couldn’t be loaded (${failed} of ${chunks.length} JPL queries failed); those objects are listed without positions.` });
    }
    const missing = designations.filter((d) => !orbits[d]).length;
    if (missing && !failed) notices.push({ level: "info", text: `${missing} object${missing > 1 ? "s" : ""} without an orbit in JPL’s Small-Body Database; listed without positions.` });

    const data: OrbitsData = {
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      distMaxAu,
      approaches: approachesRaw.map((a) => ({ ...a, pha: pha.has(a.des) })),
      orbits,
    };
    return data;
  },
};
