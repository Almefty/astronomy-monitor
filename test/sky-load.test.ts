import { describe, expect, it } from "vitest";
import type { ApiErrorBody, Envelope, SatelliteElements, SatellitesData, UpstreamCall } from "../shared/contract";
import { ApiError } from "../src/core/api";
import { loadElements, orbitsLine, orbitsResult, rememberElements, type SavedIo, type SavedStore } from "../src/viz/sky-elements";
import { ommEpochMs, SATELLITE_LIST, slimOmm } from "../worker/sources/satellites";
import ref from "./fixtures/satellites-reference.json";

/*
 * What the "Sky tonight" panel's load() returns when CelesTrak fails (src/viz/sky-elements.ts orbitsResult,
 * the panel's load() is loadElements + orbitsResult): the header text, whether "Refresh all" counts a
 * failure, and the passes section's line or error box. Fixture epochs: ISS 1 Nov 2026 05:00, Tiangong 00:08,
 * Hubble 02:56 (UTC).
 */

const OMM = ref.celestrak.omm as unknown as Record<string, unknown[]>;
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 1, 6);
const NOW = Date.parse("2026-11-01T22:00:00Z"); // the ISS orbit is 17 h old

function elements(id: number): SatelliteElements {
  const s = SATELLITE_LIST.find((x) => x.id === id)!;
  const omm = slimOmm(OMM[id], id)!;
  return { ...s, epoch: new Date(ommEpochMs(omm.EPOCH)!).toISOString(), omm };
}
const ISS = elements(25544), TIANGONG = elements(48274), HUBBLE = elements(20580);
const all = (): SatellitesData => ({ satellites: [ISS, TIANGONG, HUBBLE], unavailable: [], staleAfterDays: 7 });
const calls: UpstreamCall[] = SATELLITE_LIST.map((s) => ({
  name: `CelesTrak GP elements (${s.name})`, url: `https://celestrak.org/NORAD/elements/gp.php?CATNR=${s.id}&FORMAT=JSON`, ok: false, status: 522, ms: 20_000,
}));
/** The Worker's answer when no spacecraft could be loaded (as src/core/api.ts throws it). */
function workerFailure(): ApiError {
  const body: ApiErrorBody = {
    source: "satellites", fetchedAt: new Date(NOW).toISOString(),
    error: { kind: "upstream", message: "Orbits for ISS, Tiangong and Hubble couldn’t be loaded from CelesTrak." }, upstream: calls,
  };
  return new ApiError(body.error.message, body, 502);
}

/** This browser's storage, holding the copies an earlier successful load left. */
function savedInBrowser(sats: SatelliteElements[]): SavedIo {
  let store: SavedStore = sats.length ? rememberElements({}, { ...all(), satellites: sats }, new Date(T0).toISOString(), T0) : {};
  return { read: () => JSON.parse(JSON.stringify(store)), write: (s) => void (store = s) };
}
const load = async (get: () => Promise<Envelope<SatellitesData>>, io: SavedIo) => orbitsResult(await loadElements(get, io, null, NOW), NOW);
const fails = (err: unknown) => () => Promise.reject(err);
const line = (r: Awaited<ReturnType<typeof load>>) => orbitsLine(r.data.satellites!, r.data.fromBrowser!, r.data.error?.lead, NOW);

describe("Sky tonight when CelesTrak fails", () => {
  it("uses this browser's saved orbits: a neutral header and one line, still a failure for “Refresh all”", async () => {
    const r = await load(fails(workerFailure()), savedInBrowser([ISS, TIANGONG]));
    expect(r.failed).toBeTruthy(); // "Refresh all" counts it
    expect(r.stamp).toBe("Using saved orbits"); // the header doesn't say "failed"
    expect(r.upstream).toEqual(calls); // the HTTP 522s stay in the request log ("Details")
    expect(line(r)).toBe("CelesTrak didn’t answer; using saved orbits: ISS (17 h old), Tiangong (22 h old). Hubble: no saved orbit.");
  });

  it("shows the error box only when no spacecraft can be predicted, naming all of them", async () => {
    const r = await load(fails(workerFailure()), savedInBrowser([]));
    expect(r.failed).toBeTruthy();
    expect(r.stamp).toBeUndefined();
    expect(r.data.satellites).toBeNull();
    expect(r.data.error!.message).toBe("Orbits for ISS, Tiangong and Hubble couldn’t be loaded from CelesTrak. No saved orbits from the last 3 days are available.");
    expect(r.data.error!.message).not.toMatch(/HTTP|522/);
  });

  it("says so when this site's rate limit, or the connection, is the reason", async () => {
    const limited = new ApiError("Too many requests.", { source: "api", fetchedAt: "", error: { kind: "rate-limited", message: "Too many requests." }, upstream: [] }, 429);
    const r = await load(fails(limited), savedInBrowser([ISS]));
    expect(r.stamp).toBe("Using saved orbits");
    expect(line(r)).toBe("Too many requests to this site; using saved orbits: ISS (17 h old). Tiangong and Hubble: no saved orbit.");

    const offline = await load(fails(new ApiError("Could not reach this dashboard's server. Is it running?", null, 0)), savedInBrowser([HUBBLE]));
    expect(line(offline)).toBe("The latest orbits couldn’t be loaded; using saved orbits: Hubble (19 h old). ISS and Tiangong: no saved orbit.");
    const offlineNothing = await load(fails(new ApiError("Could not reach this dashboard's server. Is it running?", null, 0)), savedInBrowser([]));
    expect(offlineNothing.data.error!.message).toBe("Could not reach this dashboard's server. Is it running?");
  });

  it("uses the server's saved copy in a partial answer: not a failure, and its warning isn't repeated above the panel", async () => {
    const env: Envelope<SatellitesData> = {
      source: "satellites", fetchedAt: new Date(NOW).toISOString(),
      data: { ...all(), satellites: [ISS, TIANGONG, { ...HUBBLE, saved: true, fetchedAt: new Date(NOW - 5 * H).toISOString() }] },
      upstream: calls.slice(0, 2).map((c) => ({ ...c, ok: true, status: 200 })),
      notices: [
        { level: "warning", text: "CelesTrak didn’t answer for Hubble; using the copy this site saved 5 h ago." },
        { level: "info", text: "Tiangong’s orbital elements are 8 days old, so its predicted passes may be off by minutes." },
      ],
    };
    const r = await load(async () => env, savedInBrowser([]));
    expect(r.failed).toBeUndefined();
    expect(r.stamp).toBe("Using saved orbits");
    expect(r.notices.map((n) => n.level)).toEqual(["info"]);
    expect(line(r)).toBe("CelesTrak didn’t answer; using saved orbits: Hubble (19 h old).");
  });

  it("names a spacecraft that failed without any saved copy, without the upstream error", async () => {
    const env: Envelope<SatellitesData> = {
      source: "satellites", fetchedAt: new Date(NOW).toISOString(),
      data: { ...all(), satellites: [ISS, HUBBLE], unavailable: [{ id: 48274, name: "Tiangong", reason: "CelesTrak GP elements (Tiangong) answered HTTP 522: error code: 522", kind: "failed" }] },
      upstream: calls, notices: [{ level: "warning", text: "Orbital elements for Tiangong couldn’t be loaded from CelesTrak this time." }],
    };
    const r = await load(async () => env, savedInBrowser([]));
    expect(r.stamp).toBeUndefined();
    expect(r.notices).toEqual([]);
    expect(line(r)).toBe("CelesTrak didn’t answer for Tiangong, and there’s no saved orbit for it.");
  });

  it("keeps the usual header when every orbit is fresh", async () => {
    const r = await load(async () => ({ source: "satellites", fetchedAt: new Date(NOW).toISOString(), data: all(), upstream: [], notices: [] }), savedInBrowser([]));
    expect(r.failed).toBeUndefined();
    expect(r.stamp).toBeUndefined();
    expect(line(r)).toBeNull();
  });
});
