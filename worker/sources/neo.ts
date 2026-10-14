import type { CloseApproach, NeoData } from "../../shared/contract";
import { SourceError } from "../lib/upstream";
import { intParam, readParams } from "../lib/params";
import { addDays, isoDate, num } from "../lib/util";
import type { SourceModule } from "./types";

const CAD = "https://ssd-api.jpl.nasa.gov/cad.api";
const KM_PER_AU = 149_597_870.7;
const KM_PER_LD = 384_400;

interface CadResponse {
  count: number | string;
  fields?: string[];
  data?: (string | null)[][];
}

/** Convert a Julian Date (TDB) to an ISO timestamp. TDB is ~69 s ahead of UTC; irrelevant at this scale. */
export function jdToIso(jd: number): string {
  return new Date((jd - 2440587.5) * 86_400_000).toISOString();
}

/** Diameter range (km) from absolute magnitude H for geometric albedo 0.25 (small) .. 0.05 (large). */
export function diameterFromH(h: number): { min: number; max: number } {
  const d = (albedo: number) => (1329 / Math.sqrt(albedo)) * 10 ** (-h / 5);
  return { min: d(0.25), max: d(0.05) };
}

export function parseCad(json: CadResponse, phaDes: Set<string>): CloseApproach[] {
  const fields = json.fields ?? [];
  const idx = (name: string) => fields.indexOf(name);
  const col = {
    des: idx("des"), orbit: idx("orbit_id"), jd: idx("jd"), dist: idx("dist"), min: idx("dist_min"), max: idx("dist_max"),
    v: idx("v_rel"), sigma: idx("t_sigma_f"), h: idx("h"), diam: idx("diameter"), full: idx("fullname"),
  };
  if (col.des < 0 || col.jd < 0 || col.dist < 0) throw new SourceError("parse", "JPL CAD response is missing expected fields.");

  const out: CloseApproach[] = [];
  for (const row of json.data ?? []) {
    const at = (i: number) => (i >= 0 ? row[i] ?? null : null);
    const des = String(at(col.des) ?? "").trim();
    const jd = num(at(col.jd));
    const distAu = num(at(col.dist));
    if (!des || jd === null || distAu === null) continue;
    const h = num(at(col.h));
    const distKm = distAu * KM_PER_AU;
    out.push({
      des,
      name: String(at(col.full) ?? des).trim() || des,
      time: jdToIso(jd),
      timeSigma: String(at(col.sigma) ?? "").trim(),
      distAu,
      distMinAu: num(at(col.min)) ?? distAu,
      distMaxAu: num(at(col.max)) ?? distAu,
      distLd: distKm / KM_PER_LD,
      distKm,
      vRelKms: num(at(col.v)) ?? 0,
      h,
      diameterKm: num(at(col.diam)),
      estDiameterKm: h === null ? null : diameterFromH(h),
      pha: phaDes.has(des),
      orbitId: String(at(col.orbit) ?? ""),
      sbdbUrl: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(des)}`,
    });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

/** Query parameters this source reads (also its cache key, see lib/params.ts). */
const PARAMS = { past: intParam(0, 30, 7), ahead: intParam(7, 120, 60) };

export const neoSource: SourceModule<"neo"> = {
  id: "neo",
  title: "Near-Earth asteroid close approaches",
  provider: "NASA/JPL SSD · CNEOS Close Approach Data API",
  docsUrl: "https://ssd-api.jpl.nasa.gov/doc/cad.html",
  maxAge: 3600, // CNEOS updates orbits a few times a day
  params: PARAMS,

  async load({ upstream, params, now, notices }) {
    const { past, ahead } = readParams(PARAMS, params);
    // 0.05 au ≈ 19.5 lunar distances — the CNEOS threshold for "close" approaches.
    const distMaxAu = 0.05;
    const start = addDays(now, -past);
    const end = addDays(now, ahead);
    const q = new URLSearchParams({
      "date-min": isoDate(start),
      "date-max": isoDate(end),
      "dist-max": String(distMaxAu),
      diameter: "true",
      fullname: "true",
      sort: "date",
    });
    const qPha = new URLSearchParams(q);
    qPha.set("pha", "true");

    const [all, pha] = await Promise.allSettled([
      upstream.json<CadResponse>("JPL CAD (all objects)", `${CAD}?${q}`),
      upstream.json<CadResponse>("JPL CAD (hazardous only)", `${CAD}?${qPha}`),
    ]);
    if (all.status === "rejected") throw all.reason;

    const phaDes = new Set<string>();
    if (pha.status === "fulfilled") {
      const i = pha.value.fields?.indexOf("des") ?? -1;
      for (const row of pha.value.data ?? []) {
        const d = i >= 0 ? row[i] : null;
        if (d) phaDes.add(String(d).trim());
      }
    } else {
      notices.push({ level: "warning", text: "Hazard flags unavailable this time (the PHA query failed); all objects shown unflagged." });
    }

    const data: NeoData = {
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      distMaxAu,
      approaches: parseCad(all.value, phaDes),
    };
    return data;
  },
};
