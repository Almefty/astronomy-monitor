import type { Cme, CmeEarthImpact, Flare, GeoStorm, KpReading, SolarData } from "../../shared/contract";
import { SourceError } from "../lib/upstream";
import { addDays, clampInt, donkiTime, isoDate, num } from "../lib/util";
import type { SourceModule } from "./types";

/**
 * DONKI moved from api.nasa.gov to CCMC on 2026-09-30 (api.nasa.gov/DONKI/* now
 * 301-redirects to a notice page). The new host needs no API key and keeps the
 * same parameters and JSON. Max date range per request: 60 days.
 */
export const DONKI_BASE = "https://ccmc.gsfc.nasa.gov/DONKI-API/get";

const CLASS_BASE: Record<string, number> = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 };

/** "M1.0" → 1.0e-5 W/m². Returns null for unparseable classes. */
export function flareFlux(classType: string): { letter: string; flux: number } | null {
  const m = /^\s*([ABCMX])\s*(\d+(?:\.\d+)?)?/i.exec(classType ?? "");
  if (!m) return null;
  const letter = m[1]!.toUpperCase();
  const mult = m[2] ? Number(m[2]) : 1;
  return { letter, flux: CLASS_BASE[letter]! * mult };
}

/** NOAA G-scale from Kp: Kp5=G1 … Kp9=G5. */
export function gScale(kp: number): number {
  if (kp >= 9) return 5;
  if (kp >= 8) return 4;
  if (kp >= 7) return 3;
  if (kp >= 6) return 2;
  if (kp >= 5) return 1;
  return 0;
}

type Linked = { activityID?: string }[] | null | undefined;
const linkedIds = (l: Linked) => (l ?? []).map((x) => x.activityID ?? "").filter(Boolean);

interface RawFlare {
  flrID: string; beginTime: string; peakTime: string; endTime: string | null; classType: string;
  sourceLocation?: string; activeRegionNum?: number | null; linkedEvents?: Linked; link?: string; note?: string;
}

export function parseFlares(raw: RawFlare[]): Flare[] {
  const out: Flare[] = [];
  for (const f of raw ?? []) {
    const cls = flareFlux(f.classType);
    const peak = donkiTime(f.peakTime) ?? donkiTime(f.beginTime);
    if (!cls || !peak) continue;
    out.push({
      id: f.flrID,
      begin: donkiTime(f.beginTime) ?? peak,
      peak,
      end: donkiTime(f.endTime),
      classType: f.classType.trim(),
      flux: cls.flux,
      letter: cls.letter,
      region: num(f.activeRegionNum),
      location: f.sourceLocation ?? "",
      linkedIds: linkedIds(f.linkedEvents),
      link: f.link ?? "",
      note: (f.note ?? "").trim(),
    });
  }
  return out.sort((a, b) => a.peak.localeCompare(b.peak));
}

interface RawEnlil {
  estimatedShockArrivalTime?: string | null; isEarthGB?: boolean | null; isEarthMinorImpact?: boolean | null;
  kp_18?: number | null; kp_90?: number | null; kp_135?: number | null; kp_180?: number | null;
}
interface RawAnalysis {
  isMostAccurate?: boolean; time21_5?: string | null; latitude?: number | null; longitude?: number | null;
  halfAngle?: number | null; speed?: number | null; type?: string | null; enlilList?: RawEnlil[] | null;
}
interface RawCme {
  activityID: string; startTime: string; sourceLocation?: string; note?: string; link?: string;
  cmeAnalyses?: RawAnalysis[] | null; linkedEvents?: Linked;
}

function earthImpact(analysis: RawAnalysis | undefined): CmeEarthImpact | null {
  let impact: CmeEarthImpact | null = null;
  for (const run of analysis?.enlilList ?? []) {
    const arrival = donkiTime(run.estimatedShockArrivalTime);
    const glancing = Boolean(run.isEarthGB || run.isEarthMinorImpact);
    if (!arrival && !glancing) continue;
    // isEarthGB / isEarthMinorImpact = glancing blow; an arrival time without them = direct hit.
    const kps = [run.kp_18, run.kp_90, run.kp_135, run.kp_180].map(num).filter((v): v is number => v !== null);
    // Later model runs supersede earlier ones.
    impact = {
      arrival,
      glancingBlow: glancing,
      kpMin: kps.length ? Math.min(...kps) : null,
      kpMax: kps.length ? Math.max(...kps) : null,
    };
  }
  return impact;
}

export function parseCmes(raw: RawCme[]): Cme[] {
  const out: Cme[] = [];
  for (const c of raw ?? []) {
    const start = donkiTime(c.startTime);
    if (!start) continue;
    const analyses = c.cmeAnalyses ?? [];
    // Several analyses can carry isMostAccurate=true (different teams/techniques); the newest wins.
    const accurate = analyses.filter((a) => a.isMostAccurate);
    const best = accurate[accurate.length - 1] ?? analyses[analyses.length - 1];
    out.push({
      id: c.activityID,
      start,
      time21_5: donkiTime(best?.time21_5),
      speed: num(best?.speed),
      halfAngle: num(best?.halfAngle),
      lat: num(best?.latitude),
      lon: num(best?.longitude),
      type: best?.type ?? null,
      sourceLocation: c.sourceLocation ?? "",
      earth: earthImpact(best),
      linkedIds: linkedIds(c.linkedEvents),
      note: (c.note ?? "").trim(),
      link: c.link ?? "",
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

interface RawStorm {
  gstID: string; startTime: string; link?: string; linkedEvents?: Linked;
  allKpIndex?: { observedTime: string; kpIndex: number; source?: string }[] | null;
}

export function parseStorms(raw: RawStorm[]): GeoStorm[] {
  const out: GeoStorm[] = [];
  for (const s of raw ?? []) {
    const start = donkiTime(s.startTime);
    if (!start) continue;
    const readings: KpReading[] = [];
    for (const k of s.allKpIndex ?? []) {
      const time = donkiTime(k.observedTime);
      const kp = num(k.kpIndex);
      if (time && kp !== null) readings.push({ time, kp, source: k.source ?? "" });
    }
    readings.sort((a, b) => a.time.localeCompare(b.time));
    const maxKp = readings.reduce((m, r) => Math.max(m, r.kp), 0);
    out.push({ id: s.gstID, start, maxKp, gScale: gScale(maxKp), readings, linkedIds: linkedIds(s.linkedEvents), link: s.link ?? "" });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export const solarSource: SourceModule<"solar"> = {
  id: "solar",
  title: "Solar activity",
  provider: "NASA DONKI (Space Weather Database Of Notifications, Knowledge, Information) · CCMC",
  docsUrl: "https://ccmc.gsfc.nasa.gov/tools/DONKI/",

  async load({ upstream, params, now, notices, env }) {
    // Dev-only: CCMC blocks some networks, so local previews can use a saved real snapshot.
    // The whole branch (and the fixture) is removed from production builds.
    if (import.meta.env.DEV && params.get("sample") === "1") {
      const raw = (await import("../../test/fixtures/donki-2026-10-09.json")).default;
      notices.push({
        level: "warning",
        text: "SAMPLE DATA — a saved DONKI snapshot from 9 Oct 2026, shown because CCMC is unreachable from this network. Not live.",
      });
      const sampleNow = new Date("2026-10-09T06:53:00Z");
      return {
        start: addDays(sampleNow, -30).toISOString(), end: sampleNow.toISOString(), days: 30,
        flares: parseFlares(raw.FLR as RawFlare[]), cmes: parseCmes(raw.CME as RawCme[]), storms: parseStorms(raw.GST as RawStorm[]),
        feeds: { flares: true, cmes: true, storms: true },
      };
    }
    const days = clampInt(params.get("days"), 3, 59, 30); // +1 day below keeps the range under DONKI's 60-day cap
    const start = addDays(now, -days);
    // endDate is inclusive and day-granular; include tomorrow so nothing "today" (UTC) is cut off.
    const q = `startDate=${isoDate(start)}&endDate=${isoDate(addDays(now, 1))}`;
    const opts = { timeoutMs: 12_000 };

    const [flares, cmes, storms] = await Promise.allSettled([
      upstream.json<RawFlare[]>("DONKI solar flares (FLR)", `${DONKI_BASE}/FLR?${q}`, opts),
      upstream.json<RawCme[]>("DONKI coronal mass ejections (CME)", `${DONKI_BASE}/CME?${q}`, opts),
      upstream.json<RawStorm[]>("DONKI geomagnetic storms (GST)", `${DONKI_BASE}/GST?${q}`, opts),
    ]);

    const failed = [flares, cmes, storms].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    if (failed.length === 3) {
      const first = failed[0]!.reason as SourceError;
      const network = first instanceof SourceError && (first.kind === "timeout" || first.kind === "unreachable");
      throw new SourceError(
        first instanceof SourceError ? first.kind : "upstream",
        first.message,
        network
          ? env.APP_ENV === "development"
            ? "CCMC (DONKI's host since 30 Sep 2026) refuses connections from some networks, including some home ISPs. The deployed Worker runs on Cloudflare's network, which CCMC accepts, so this panel works once deployed."
            : "CCMC (DONKI's host) did not answer. It is occasionally down for maintenance; try again later."
          : undefined,
      );
    }
    const names = ["flares", "CMEs", "geomagnetic storms"];
    [flares, cmes, storms].forEach((r, i) => {
      if (r.status === "rejected") notices.push({ level: "warning", text: `DONKI ${names[i]} feed failed: ${(r.reason as Error).message}` });
    });

    const data: SolarData = {
      start: start.toISOString(),
      end: now.toISOString(),
      days,
      flares: flares.status === "fulfilled" ? parseFlares(flares.value) : [],
      cmes: cmes.status === "fulfilled" ? parseCmes(cmes.value) : [],
      storms: storms.status === "fulfilled" ? parseStorms(storms.value) : [],
      feeds: { flares: flares.status === "fulfilled", cmes: cmes.status === "fulfilled", storms: storms.status === "fulfilled" },
    };
    return data;
  },
};
