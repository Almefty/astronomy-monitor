import { CATALOG_COLUMNS, type ExoplanetData, type NewPlanet } from "../../shared/contract";
import type { Upstream } from "../lib/upstream";
import { addDays, clampInt, isoDate, num } from "../lib/util";
import type { SourceModule } from "./types";

const TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const MAX_RECENT = 150;

export function tapUrl(query: string, format: "json" | "csv" = "json"): string {
  return `${TAP}?${new URLSearchParams({ query, format })}`;
}

const adqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface RawPlanet {
  pl_name: string; hostname: string; disc_year: number | null; discoverymethod: string; disc_facility: string;
  pl_orbper: number | null; pl_rade: number | null; pl_bmasse: number | null; pl_eqt: number | null;
  pl_insol: number | null; sy_dist: number | null; ra: number | null; dec: number | null; st_teff: number | null;
}

export function toNewPlanet(p: RawPlanet, added: string): NewPlanet {
  return {
    name: p.pl_name,
    host: p.hostname,
    discYear: num(p.disc_year),
    method: p.discoverymethod ?? "Unknown",
    facility: p.disc_facility ?? "",
    periodDays: num(p.pl_orbper),
    radiusEarth: num(p.pl_rade),
    massEarth: num(p.pl_bmasse),
    eqTempK: num(p.pl_eqt),
    insolation: num(p.pl_insol),
    distPc: num(p.sy_dist),
    ra: num(p.ra),
    dec: num(p.dec),
    starTeffK: num(p.st_teff),
    added,
  };
}

export const exoplanetSource: SourceModule<"exoplanets"> = {
  id: "exoplanets",
  title: "Exoplanet discoveries",
  provider: "NASA Exoplanet Archive (Caltech/IPAC) · TAP service",
  docsUrl: "https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html",

  async load({ upstream, params, now, notices }) {
    const windowDays = clampInt(params.get("days"), 14, 365, 90);
    const since = isoDate(addDays(now, -windowDays));

    // A planet's first appearance in the archive = the earliest release of any of its parameter sets.
    const recentQ =
      `select pl_name, min(releasedate) as added from ps group by pl_name ` +
      `having min(releasedate) >= ${adqlString(since)} order by added desc`;
    // The archive's response time varies a lot (1–25 s), so timeouts are generous and the count is optional.
    const [recentRes, countRes] = await Promise.allSettled([
      upstream.json<{ pl_name: string; added: string }[]>("Exoplanet Archive: newly added planets", tapUrl(recentQ), { timeoutMs: 40_000 }),
      upstream.json<{ n: number }[]>("Exoplanet Archive: confirmed planet count", tapUrl("select count(*) as n from pscomppars"), { timeoutMs: 25_000 }),
    ]);
    if (recentRes.status === "rejected") throw recentRes.reason;
    const recentRows = recentRes.value;

    const addedByName = new Map<string, string>();
    for (const r of recentRows.slice(0, MAX_RECENT)) addedByName.set(r.pl_name, String(r.added).slice(0, 10));

    let recent: NewPlanet[] = [];
    if (addedByName.size) {
      const inList = [...addedByName.keys()].map(adqlString).join(",");
      const detailQ =
        `select pl_name,hostname,disc_year,discoverymethod,disc_facility,pl_orbper,pl_rade,pl_bmasse,` +
        `pl_eqt,pl_insol,sy_dist,ra,dec,st_teff from pscomppars where pl_name in (${inList})`;
      const details = await upstream.json<RawPlanet[]>("Exoplanet Archive: parameters of new planets", tapUrl(detailQ), { timeoutMs: 40_000 });
      recent = details
        .map((p) => toNewPlanet(p, addedByName.get(p.pl_name) ?? since))
        .sort((a, b) => b.added.localeCompare(a.added) || a.name.localeCompare(b.name));
    }

    const total = countRes.status === "fulfilled" ? num(countRes.value[0]?.n) : null;
    if (total === null) notices.push({ level: "info", text: "The planet-count query was slow, so the total below is counted from the catalog instead." });
    const data: ExoplanetData = { total, windowDays, recent };
    return data;
  },
};

/**
 * Streams the whole confirmed-planet table (~6,500 rows, ~0.8 MB CSV) straight
 * through without parsing it, so the Worker stays far below the free plan's
 * 10 ms CPU limit. The browser parses it.
 */
export async function streamCatalog(upstream: Upstream): Promise<Response> {
  const q = `select ${CATALOG_COLUMNS.join(",")} from pscomppars`;
  const res = await upstream.fetch("Exoplanet Archive: full catalog", tapUrl(q, "csv"), { timeoutMs: 50_000 });
  return new Response(res.body, {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
  });
}
