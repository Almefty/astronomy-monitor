import { json2satrec, jday, propagate, sgp4, shadowFraction, sunPos, twoline2satrec, SatRecError } from "satellite.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, SatelliteElements, SatellitesData } from "../shared/contract";
import { compassPoint, nightEvents, nightWindow, skyPosition, sunVectorOfDate, type Observer } from "../shared/sky";
import {
  darkIntervals, estimateMagnitude, inEarthShadow, MIN_ALTITUDE, passesAboveHorizon, passSearchWindow, predictPasses,
  satellitePosition,
} from "../src/viz/passes";
import { canonicalApiPath, handleApi } from "../worker/api";
import type { Env } from "../worker/lib/env";
import { SOURCES } from "../worker/sources/index";
import { FAILURE_MAX_AGE, ommEpochMs, SATELLITE_LIST, slimOmm, STALE_AFTER_DAYS } from "../worker/sources/satellites";
import ref from "./fixtures/satellites-reference.json";
import vallado from "./fixtures/sgp4-vallado.json";

/*
 * References, built by scripts/fetch-satellite-fixtures.mjs on 2026-11-01:
 * - satellites-reference.json: CelesTrak's OMM answers for the ISS, Tiangong and Hubble, the ISS as a TLE from
 *   the same update, and JPL Horizons' ISS (−125544, TLE-based, elements revised 31 Oct 2026) seen from Jakarta,
 *   Tromsø, Cape Town and London over four days.
 * - sgp4-vallado.json: the SGP4 verification set of Vallado et al. (2006), AIAA 2006-6753.
 * Measured worst cases when the fixtures were made are noted next to each limit.
 */

const OMM = ref.celestrak.omm as unknown as Record<string, unknown[]>;
const SITES = ref.horizons.sites as unknown as Record<string, Observer & {
  passes: { rise: { ms: number; az: number }; peak: { ms: number; el: number; az: number }; set: { ms: number; az: number } }[];
  samples: [number, number, number][];
}>;
const { start: H_START, end: H_END } = ref.horizons;
const DEG = Math.PI / 180;

function elements(id: number): SatelliteElements {
  const s = SATELLITE_LIST.find((x) => x.id === id)!;
  const omm = slimOmm(OMM[id], id)!;
  return { ...s, epoch: new Date(ommEpochMs(omm.EPOCH)!).toISOString(), omm };
}
const SATS = SATELLITE_LIST.map((s) => elements(s.id));
const ISS = SATS[0]!;

/** Angle between two sky directions given as altitude/azimuth, degrees. */
function skyAngle(alt1: number, az1: number, alt2: number, az2: number): number {
  const c = Math.sin(alt1 * DEG) * Math.sin(alt2 * DEG) + Math.cos(alt1 * DEG) * Math.cos(alt2 * DEG) * Math.cos((az1 - az2) * DEG);
  return Math.acos(Math.min(1, Math.max(-1, c))) / DEG;
}

/* ------------------------------------------------------------------ */
/* Worker source                                                       */
/* ------------------------------------------------------------------ */

describe("CelesTrak elements (Worker)", () => {
  const env = { APP_ENV: "production" } as Env;
  const get = () => handleApi(new Request("https://example.test/api/sources/satellites"), env);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Stub CelesTrak: `answers` maps a catalog number to a Response factory; records requested numbers. */
  function stub(answers: Record<number, () => Response>): number[] {
    const asked: number[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const id = Number(url.searchParams.get("CATNR"));
      asked.push(id);
      return (answers[id] ?? (() => Response.json(OMM[id])))();
    });
    return asked;
  }

  it("keeps only what SGP4 needs, from a real answer", () => {
    const omm = slimOmm(OMM[25544], 25544)!;
    expect(omm).toEqual({
      OBJECT_NAME: "ISS (ZARYA)", OBJECT_ID: "1998-067A", NORAD_CAT_ID: 25544, EPOCH: "2026-11-01T05:00:23.160096",
      MEAN_MOTION: 15.49138562, ECCENTRICITY: 0.0007056, INCLINATION: 51.6332, RA_OF_ASC_NODE: 342.0408, ARG_OF_PERICENTER: 334.5041,
      MEAN_ANOMALY: 25.5599, BSTAR: 0.00013267, MEAN_MOTION_DOT: 6.903e-5, MEAN_MOTION_DDOT: 0, ELEMENT_SET_NO: 999,
    });
    // OMM epochs carry no zone but are UTC.
    expect(ommEpochMs(omm.EPOCH)).toBe(Date.UTC(2026, 10, 1, 5, 0, 23, 160));
    expect(ommEpochMs("2026-11-01T05:00:23Z")).toBe(Date.UTC(2026, 10, 1, 5, 0, 23));
    expect(ommEpochMs("1 Nov 2026")).toBeNull();
  });

  it("rejects answers without a usable element set", () => {
    const iss = OMM[25544]![0] as Record<string, unknown>;
    expect(slimOmm(OMM[25544], 48274)).toBeNull(); // another object
    expect(slimOmm("No GP data found", 25544)).toBeNull();
    expect(slimOmm([{ ...iss, MEAN_MOTION: null }], 25544)).toBeNull();
    expect(slimOmm([{ ...iss, ECCENTRICITY: 1.2 }], 25544)).toBeNull();
    expect(slimOmm([{ ...iss, EPOCH: "yesterday" }], 25544)).toBeNull();
    expect(slimOmm([{ ...iss, MEAN_MOTION: "15.49" }], 25544)?.MEAN_MOTION).toBe(15.49); // numeric strings are fine
  });

  it("asks for each object once and caches the answer for CelesTrak's 2-hour update cycle", async () => {
    const asked = stub({});
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=7200");
    const body = (await res.json()) as Envelope<SatellitesData>;
    expect(asked).toEqual([25544, 48274, 20580]);
    expect(body.data.satellites.map((s) => [s.id, s.name, s.epoch])).toEqual([
      [25544, "ISS", "2026-11-01T05:00:23.160Z"],
      [48274, "Tiangong", "2026-11-01T00:08:01.018Z"],
      [20580, "Hubble", "2026-11-01T02:56:12.392Z"],
    ]);
    expect(body.data.unavailable).toEqual([]);
    expect(body.notices).toEqual([]);
    expect(body.upstream.every((c) => c.ok && c.url.startsWith("https://celestrak.org/NORAD/elements/gp.php?CATNR="))).toBe(true);
    // No query parameters: one cache entry for everyone.
    expect(canonicalApiPath(new URL("https://example.test/api/sources/satellites?lat=1&x=2"))).toBe("/api/sources/satellites");
  });

  // Deliberate exception to "no-store for errors" (CLAUDE.md): CelesTrak asks clients to stop after
  // errors, so failed and partial answers are cached for FAILURE_MAX_AGE instead of being re-requested.
  it("stops at the first error, as CelesTrak's usage policy asks, and caches the failure briefly", async () => {
    expect(FAILURE_MAX_AGE).toBe(600);
    const asked = stub({ 25544: () => new Response("Service Unavailable", { status: 503 }) });
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
    expect(asked).toEqual([25544]);
  });

  it("serves what loaded before an error with a warning, cached briefly", async () => {
    const asked = stub({ 48274: () => new Response("Forbidden", { status: 403 }) });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
    const body = (await res.json()) as Envelope<SatellitesData>;
    expect(asked).toEqual([25544, 48274]);
    expect(body.data.satellites.map((s) => s.name)).toEqual(["ISS"]);
    expect(body.data.unavailable.map((u) => [u.name, u.reason])).toEqual([
      ["Tiangong", expect.stringContaining("HTTP 403")],
      ["Hubble", "Not requested after an earlier CelesTrak error."],
    ]);
    expect(body.notices).toEqual([{ level: "warning", text: expect.stringContaining("Tiangong and Hubble") }]);
  });

  it("treats “No GP data found” as an answer about one object: the others load and the cache lifetime stays", async () => {
    const asked = stub({ 48274: () => new Response("No GP data found", { status: 404, headers: { "content-type": "text/plain" } }) });
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("public, max-age=7200");
    const body = (await res.json()) as Envelope<SatellitesData>;
    expect(asked).toEqual([25544, 48274, 20580]);
    expect(body.data.satellites.map((s) => s.name)).toEqual(["ISS", "Hubble"]);
    expect(body.data.unavailable).toEqual([{ id: 48274, name: "Tiangong", reason: "CelesTrak has no current elements for it." }]);
    expect(body.notices).toEqual([{ level: "info", text: expect.stringContaining("no usable orbital elements for Tiangong") }]);
  });

  it("stops at any other HTTP 404", async () => {
    const asked = stub({ 48274: () => new Response("Not Found", { status: 404 }) });
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
    expect(asked).toEqual([25544, 48274]);
  });

  it("treats an answer that isn't an element set (HTTP 200 with a text message) like missing elements", async () => {
    const asked = stub({ 20580: () => new Response('Invalid query: "CATNR=x"', { status: 200 }) });
    const res = await get();
    const body = (await res.json()) as Envelope<SatellitesData>;
    expect(asked).toEqual([25544, 48274, 20580]);
    expect(res.headers.get("cache-control")).toBe("public, max-age=7200");
    expect(body.data.unavailable).toEqual([{ id: 20580, name: "Hubble", reason: expect.stringContaining("Invalid query") }]);
    expect(body.notices.map((n) => n.level)).toEqual(["info"]);
  });

  it("caches a total failure briefly too, but no other source's errors", async () => {
    stub({ 25544: () => new Response("No GP data found", { status: 404 }), 48274: () => new Response("No GP data found", { status: 404 }), 20580: () => new Response("No GP data found", { status: 404 }) });
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
    // The exception is CelesTrak's alone.
    expect(Object.values(SOURCES).filter((x) => x.failureMaxAge !== undefined).map((x) => x.id)).toEqual(["satellites"]);
  });

  it("flags stale elements without making the answer uncacheable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 1, 6) + (STALE_AFTER_DAYS + 3) * 86_400_000);
    stub({});
    const res = await get();
    const body = (await res.json()) as Envelope<SatellitesData>;
    expect(res.headers.get("cache-control")).toBe("public, max-age=7200");
    expect(body.notices.map((n) => n.level)).toEqual(["info", "info", "info"]);
    expect(body.notices[0]!.text).toBe("ISS’s orbital elements are 10 days old, so its predicted passes may be off by minutes.");
  });
});

/* ------------------------------------------------------------------ */
/* SGP4 (satellite.js)                                                 */
/* ------------------------------------------------------------------ */

describe("SGP4 (satellite.js) against Vallado's verification set", () => {
  type Case = { satnum: number; tle: [string, string]; rows: number[][] };
  const cases = vallado.cases as unknown as Case[];
  /** Cases whose reference output stops at an SGP4 error (Vallado's "check error code" cases). */
  const ERROR_CASES = new Set([33333, 33334]);

  function maxError(satrec: ReturnType<typeof twoline2satrec>, rows: number[][]): { r: number; v: number } {
    let r = 0, v = 0;
    for (const [t, x, y, z, vx, vy, vz] of rows as [number, number, number, number, number, number, number][]) {
      const pv = sgp4(satrec, t);
      if (!pv) return { r: Infinity, v: Infinity };
      r = Math.max(r, Math.hypot(pv.position.x - x, pv.position.y - y, pv.position.z - z));
      v = Math.max(v, Math.hypot(pv.velocity.x - vx, pv.velocity.y - vy, pv.velocity.z - vz));
    }
    return { r, v };
  }

  it("reproduces the reference positions and velocities", () => {
    expect(cases).toHaveLength(33);
    for (const c of cases) {
      if (ERROR_CASES.has(c.satnum)) continue;
      const { r, v } = maxError(twoline2satrec(c.tle[0], c.tle[1]), c.rows);
      // 23599 is the "Lyddane choice" deep-space case: the reference was run in AFSPC mode, and
      // satellite.js's default "improved" mode differs there by design (0.96 km; checked below).
      if (c.satnum === 23599) continue;
      expect(r, `${c.satnum} position (km)`).toBeLessThan(1e-6); // measured ≤ 1e-8 km
      expect(v, `${c.satnum} velocity (km/s)`).toBeLessThan(1e-8); // ≤ 1e-9 km/s
    }
  });

  it("matches the AFSPC-mode reference for the Lyddane case (23599)", () => {
    const c = cases.find((x) => x.satnum === 23599)!;
    const tle = twoline2satrec(c.tle[0], c.tle[1]);
    // Re-initialize the same elements in AFSPC mode through the OMM reader.
    const afspc = json2satrec({
      OBJECT_NAME: "", OBJECT_ID: "", NORAD_CAT_ID: 23599, ELEMENT_SET_NO: 1,
      EPOCH: new Date(Math.round((tle.jdsatepoch - 2440587.5) * 86_400_000)).toISOString(),
      MEAN_MOTION: Number(c.tle[1].slice(52, 63)), ECCENTRICITY: Number(`.${c.tle[1].slice(26, 33)}`),
      INCLINATION: Number(c.tle[1].slice(8, 16)), RA_OF_ASC_NODE: Number(c.tle[1].slice(17, 25)),
      ARG_OF_PERICENTER: Number(c.tle[1].slice(34, 42)), MEAN_ANOMALY: Number(c.tle[1].slice(43, 51)),
      BSTAR: 0.12956e-2, MEAN_MOTION_DOT: 0.00085586, MEAN_MOTION_DDOT: 0.12891e-6,
    }, "a");
    expect(maxError(afspc, c.rows).r).toBeLessThan(1e-3); // measured 8e-9 km (epoch rounded to 1 ms)
    expect(maxError(tle, c.rows).r).toBeLessThan(1); // improved mode: 0.96 km
  });

  it("reports SGP4's error cases instead of returning positions", () => {
    const c33334 = cases.find((x) => x.satnum === 33334)!;
    const s4 = twoline2satrec(c33334.tle[0], c33334.tle[1]);
    expect(s4.error).not.toBe(SatRecError.None);
    const c33333 = cases.find((x) => x.satnum === 33333)!;
    const s3 = twoline2satrec(c33333.tle[0], c33333.tle[1]);
    // The reference output stops after 20 min; the case runs to 150 min.
    expect(maxError(s3, c33333.rows).r).toBeLessThan(1e-6);
    let failed = false;
    for (let t = 25; t <= 150 && !failed; t += 5) failed = sgp4(s3, t) === null;
    expect(failed).toBe(true);
  });

  it("reads CelesTrak's OMM JSON exactly like the TLE of the same update", () => {
    const tle = (ref.celestrak.tle as Record<string, string[]>)["25544"]!;
    const a = json2satrec({ ...ISS.omm }), b = twoline2satrec(tle[1]!, tle[2]!);
    let max = 0;
    for (let t = H_START; t < H_END; t += 7 * 60_000) {
      const p = propagate(a, new Date(t))!.position, q = propagate(b, new Date(t))!.position;
      max = Math.max(max, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
    }
    expect(max).toBeLessThan(0.01); // measured 0.6 m over four days (TLE epochs have 0.1 ms resolution)
  });
});

/* ------------------------------------------------------------------ */
/* Passes                                                              */
/* ------------------------------------------------------------------ */

describe("ISS passes against JPL Horizons", () => {
  it("finds the same passes above 10°, with the same times, at four observers", () => {
    let compared = 0;
    for (const [name, site] of Object.entries(SITES)) {
      const ours = passesAboveHorizon(ISS, site, H_START, H_END);
      expect(ours.length, name).toBe(site.passes.length);
      for (const [i, h] of site.passes.entries()) {
        const o = ours[i]!;
        const ctx = `${name} pass at ${new Date(h.peak.ms).toISOString()}`;
        expect(Math.abs(o.start.ms - h.rise.ms) / 1000, `${ctx}: rise (s)`).toBeLessThan(5); // measured ≤ 0.7 s
        expect(Math.abs(o.peak.ms - h.peak.ms) / 1000, `${ctx}: peak (s)`).toBeLessThan(5); // ≤ 0.7 s
        expect(Math.abs(o.end.ms - h.set.ms) / 1000, `${ctx}: set (s)`).toBeLessThan(5); // ≤ 0.8 s
        // Near the zenith, elevation against time is V-shaped, so the reference's parabola through 2-s
        // samples is itself off by tenths of a degree there; elsewhere it is far better than 0.01°.
        const nearZenith = h.peak.el > 80;
        const peakEl = Math.abs(o.peak.alt - h.peak.el);
        expect(peakEl, `${ctx}: peak altitude (°)`).toBeLessThan(nearZenith ? 0.5 : 0.1); // measured ≤ 0.25° / ≤ 0.04°
        const peakDir = skyAngle(o.peak.alt, o.peak.az, h.peak.el, h.peak.az);
        expect(peakDir, `${ctx}: peak direction (°)`).toBeLessThan(nearZenith ? 0.5 : 0.1); // ≤ 0.34° / ≤ 0.05°
        expect(skyAngle(o.start.alt, o.start.az, MIN_ALTITUDE, h.rise.az), `${ctx}: rise direction (°)`).toBeLessThan(1); // ≤ 0.46°
        compared++;
      }
    }
    expect(compared).toBe(46);
    // The ISS (inclination 51.6°) never climbs 10° above Tromsø's horizon (69.65° N).
    expect(SITES.tromso!.passes).toHaveLength(0);
  });

  it("puts the ISS where Horizons does, every 20 s across a pass", () => {
    for (const [name, site] of Object.entries(SITES)) {
      for (const [ms, az, el] of site.samples) {
        const p = satellitePosition(ISS, site, ms)!;
        expect(skyAngle(p.alt, p.az, el, az), `${name} ${new Date(ms).toISOString()}`).toBeLessThan(0.1); // measured ≤ 0.07°
      }
    }
  });

  it("skips ahead without missing or moving a pass", () => {
    for (const sat of SATS) {
      for (const [name, site] of Object.entries(SITES)) {
        const fast = passesAboveHorizon(sat, site, H_START, H_END);
        const slow = passesAboveHorizon(sat, site, H_START, H_END, { skipAhead: false });
        expect(fast.length, `${sat.name} at ${name}`).toBe(slow.length);
        for (const [i, p] of fast.entries()) {
          expect(Math.abs(p.start.ms - slow[i]!.start.ms)).toBeLessThan(1000);
          expect(Math.abs(p.end.ms - slow[i]!.end.ms)).toBeLessThan(1000);
          expect(Math.abs(p.peak.alt - slow[i]!.peak.alt)).toBeLessThan(0.01);
        }
      }
    }
  });
});

describe("visibility", () => {
  it("models the Earth's shadow as a cylinder", () => {
    const sun: [number, number, number] = [1, 0, 0];
    expect(inEarthShadow([7000, 0, 0], sun)).toBe(false); // sunward
    expect(inEarthShadow([-7000, 0, 0], sun)).toBe(true); // straight behind
    expect(inEarthShadow([-7000, 6000, 0], sun)).toBe(true); // behind, inside the radius
    expect(inEarthShadow([-7000, 6500, 0], sun)).toBe(false); // behind, outside it
    expect(inEarthShadow([0, 7000, 0], sun)).toBe(false); // over the terminator
  });

  it("agrees with satellite.js's conical shadow (umbra + penumbra) almost everywhere", () => {
    for (const sat of SATS) {
      const satrec = json2satrec({ ...sat.omm });
      let n = 0, differ = 0;
      for (let t = H_START; t < H_END; t += 10_000) {
        const d = new Date(t);
        const p = propagate(satrec, d)!.position;
        const s = sunVectorOfDate(t), r = Math.hypot(...s);
        const cyl = inEarthShadow([p.x, p.y, p.z], [s[0] / r, s[1] / r, s[2] / r]);
        const cone = shadowFraction(sunPos(jday(d)).rsun, p) > 0.5;
        n++;
        if (cyl !== cone) differ++;
      }
      // 34,560 samples each; measured: 0 differ (ISS, Hubble), 2 (Tiangong), i.e. edges within ~10 s.
      expect(differ / n, sat.name).toBeLessThan(0.001);
    }
  });

  it("estimates brightness from the standard magnitude, range and phase", () => {
    expect(estimateMagnitude(-1.8, 1000, 90)).toBeCloseTo(-1.8, 2); // the definition: 1,000 km, half lit
    expect(estimateMagnitude(-1.8, 1000, 0)).toBeCloseTo(-1.8 - 0.753, 2); // fully lit
    expect(estimateMagnitude(-1.8, 500, 90)).toBeCloseTo(-1.8 - 1.505, 2); // half the range: 4× brighter
    expect(estimateMagnitude(2, 1000, 180)).toBeLessThan(20); // stays finite when unlit
  });

  it("finds the observer's dark intervals, including polar day", () => {
    const jakarta = { lat: -6.2, lon: 106.8 };
    const [a, b] = nightWindow("2026-11-01", jakarta);
    const dark = darkIntervals(jakarta, a, b);
    expect(dark).toHaveLength(1);
    const civil = nightEvents(jakarta, "2026-11-01");
    expect(Math.abs(dark[0]![0] - (civil.civilDusk.state === "time" ? civil.civilDusk.ms : NaN))).toBeLessThan(60_000);
    expect(Math.abs(dark[0]![1] - (civil.civilDawn.state === "time" ? civil.civilDawn.ms : NaN))).toBeLessThan(60_000);
    for (const t of dark[0]!) expect(skyPosition("sun", t, jakarta).alt).toBeCloseTo(-6, 2);
    const tromso = { lat: 69.65, lon: 18.96 };
    expect(darkIntervals(tromso, ...nightWindow("2027-06-21", tromso))).toEqual([]); // midnight Sun
  });

  it("predicts only passes that are high, sunlit and against a dark sky", () => {
    let total = 0;
    for (const [name, site] of Object.entries(SITES)) {
      const [start, end] = passSearchWindow(H_START, site, 4);
      const result = predictPasses(SATS, site, start, end);
      expect(result.satellites.map((s) => s.error), name).toEqual([null, null, null]);
      expect(result.passes).toEqual([...result.passes].sort((x, y) => x.start.ms - y.start.ms));
      for (const p of result.passes) {
        total++;
        const sat = SATS.find((s) => s.id === p.satId)!;
        expect(p.start.ms).toBeLessThan(p.end.ms);
        expect(p.peak.ms).toBeGreaterThanOrEqual(p.start.ms);
        expect(p.peak.ms).toBeLessThanOrEqual(p.end.ms);
        expect(p.track[0]!.ms).toBe(p.start.ms);
        expect(p.track.at(-1)!.ms).toBe(p.end.ms);
        for (const q of p.track) {
          expect(q.alt).toBeGreaterThanOrEqual(MIN_ALTITUDE - 0.05);
          expect(skyPosition("sun", q.ms, site).alt).toBeLessThan(-6 + 0.01);
          // Edges are within 0.5 s of the shadow boundary, so test points a second inside.
          const inner = Math.min(Math.max(q.ms, p.start.ms + 1000), p.end.ms - 1000);
          expect(satellitePosition(sat, site, inner)!.sunlit).toBe(true);
        }
        expect(p.mag).toBeLessThanOrEqual(Math.min(...p.track.map((q) => satellitePosition(sat, site, q.ms)!.mag)) + 1e-4); // track times are rounded to 1 ms
        // An edge is explained by what changed there.
        const before = satellitePosition(sat, site, p.start.ms - 2000)!;
        if (p.start.cause === "horizon") expect(before.alt).toBeLessThan(MIN_ALTITUDE);
        if (p.start.cause === "shadow") expect(before.sunlit).toBe(false);
        const after = satellitePosition(sat, site, p.end.ms + 2000)!;
        if (p.end.cause === "horizon") expect(after.alt).toBeLessThan(MIN_ALTITUDE);
        if (p.end.cause === "shadow") expect(after.sunlit).toBe(false);
      }
      if (name === "tromso") expect(result.passes).toEqual([]); // none of the three climbs 10° there
    }
    expect(total).toBeGreaterThan(10); // measured 15
  });

  it("finds visible pieces shorter than the scan step (eclipsed near 10°, grazing)", () => {
    // With a 2-minute step, many visible pieces fall between two samples that are both not visible
    // (below 10°, or above 10° but eclipsed). They must still be found, matching a 5-s scan.
    let short = 0, compared = 0;
    for (const [name, site] of Object.entries(SITES)) {
      const [start, end] = passSearchWindow(H_START, site, 4);
      const fine = predictPasses(SATS, site, start, end, { stepMs: 5_000 }).passes;
      const coarse = predictPasses(SATS, site, start, end, { stepMs: 120_000 }).passes;
      expect(coarse.map((p) => p.name), name).toEqual(fine.map((p) => p.name));
      for (const [i, p] of coarse.entries()) {
        const f = fine[i]!;
        expect(Math.abs(p.start.ms - f.start.ms), `${name} ${p.name} start`).toBeLessThan(1500);
        expect(Math.abs(p.end.ms - f.end.ms), `${name} ${p.name} end`).toBeLessThan(1500);
        expect(p.start.cause).toBe(f.start.cause);
        expect(p.end.cause).toBe(f.end.cause);
        expect(Math.abs(p.peak.alt - f.peak.alt)).toBeLessThan(0.1); // a peak at an eclipse edge moves with the 0.5-s edge tolerance
        if (f.end.ms - f.start.ms < 120_000) short++;
        compared++;
      }
      // Grazing passes above 10° for less than the step, day or night.
      for (const sat of SATS) {
        const all = passesAboveHorizon(sat, site, H_START, H_END, { stepMs: 5_000 });
        const sparse = passesAboveHorizon(sat, site, H_START, H_END, { stepMs: 120_000 });
        expect(sparse.length, `${sat.name} at ${name}`).toBe(all.length);
        short += all.filter((p) => p.end.ms - p.start.ms < 120_000).length;
      }
    }
    expect(compared).toBeGreaterThan(10);
    expect(short).toBeGreaterThan(3); // the test exercises pieces shorter than the coarse step
  });

  it("isolates a satellite with unusable or old elements", () => {
    const site = SITES.capetown!;
    const [start, end] = passSearchWindow(H_START, site, 4);
    const broken = { ...SATS[1]!, omm: { ...SATS[1]!.omm, ECCENTRICITY: 1.5 } };
    const old = { ...SATS[2]!, epoch: new Date(start - 40 * 86_400_000).toISOString() };
    const result = predictPasses([ISS, broken, old], site, start, end);
    expect(result.satellites[0]!.error).toBeNull();
    expect(result.satellites[1]!.error).toMatch(/SGP4|couldn’t/);
    expect(result.satellites[2]!.error).toMatch(/40 days/);
    expect(result.satellites[2]!.ageDays).toBeCloseTo(40, 6);
    expect(result.passes.every((p) => p.satId === ISS.id)).toBe(true);
  });

  it("reports an SGP4 failure during the search (decay) instead of passes", () => {
    const site = SITES.london!;
    const [start, end] = passSearchWindow(H_START, site, 4);
    // A very low, high-drag orbit: SGP4 gives up about 29 h after the epoch, inside the search.
    const decaying = { ...ISS, omm: { ...ISS.omm, MEAN_MOTION: 16.2, BSTAR: 0.01, MEAN_MOTION_DOT: 0.01 } };
    const result = predictPasses([decaying, SATS[1]!], site, start, end);
    expect(result.satellites[0]!.passes).toEqual([]);
    expect(result.satellites[0]!.error).toMatch(/couldn’t be propagated from 2026-11-0\d \d\d:\d\d UTC/);
    expect(result.satellites[1]!.error).toBeNull();
    expect(() => passesAboveHorizon(decaying, site, start, end)).toThrow(/SGP4 failed/);
  });

  it("searches from now to the end of the fourth night, fast", () => {
    const site = SITES.london!;
    const [start, end] = passSearchWindow(H_START, site, 4);
    expect(start).toBe(H_START);
    // 06:00 UTC is still "last night" in London (before solar noon), so the four nights are 31 Oct – 3 Nov.
    expect(end).toBe(nightWindow("2026-11-03", site)[1]);
    const t0 = performance.now();
    predictPasses(SATS, site, start, end);
    // Measured 3–6 ms per observer in Node on the cloud container (phones: a few times slower).
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it("names compass points", () => {
    expect([0, 11.2, 11.3, 90, 180, 247.5, 348.75, 359.9, -45].map(compassPoint)).toEqual(["N", "N", "NNE", "E", "S", "WSW", "N", "N", "NW"]);
  });
});

describe("bundle", () => {
  /** Imports satellite.js or one of its subpaths, statically, by re-export, or with import()/require(). */
  const SATELLITE_JS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']satellite\.js(?:\/[^"']*)?["']/;
  /** Static import/export statements (not `import type`) with their module specifiers. */
  const STATIC = /^\s*(?:import|export)\s+(?!type\s)(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']/gm;

  /** "../src/panels/sky.ts" + "../viz/passes" → "src/viz/passes". */
  function resolve(file: string, spec: string): string {
    const parts = file.replace(/^\.\.\//, "").split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    return parts.join("/").replace(/\.(ts|js)$/, "");
  }
  const staticImportsOfPasses = (file: string, text: string) =>
    [...text.matchAll(STATIC)].filter((m) => m[1]!.startsWith(".") && resolve(file, m[1]!) === "src/viz/passes");

  it("recognizes the import forms it guards against", () => {
    for (const ok of ['import { sgp4 } from "satellite.js";', "const m = await import('satellite.js');", 'export * from "satellite.js/dist/io.js";', 'import "satellite.js";']) {
      expect(SATELLITE_JS.test(ok), ok).toBe(true);
    }
    expect(SATELLITE_JS.test('import x from "satellite.json";')).toBe(false);
    const panel = "../src/panels/sky.ts";
    expect(staticImportsOfPasses(panel, 'import { predictPasses } from "../viz/passes";')).toHaveLength(1);
    expect(staticImportsOfPasses(panel, 'import "../viz/passes.ts";')).toHaveLength(1);
    expect(staticImportsOfPasses(panel, 'export { predictPasses } from "../viz/passes";')).toHaveLength(1);
    expect(staticImportsOfPasses(panel, 'import {\n  type VisiblePass,\n} from "../viz/passes";')).toHaveLength(1); // kept by verbatimModuleSyntax
    expect(staticImportsOfPasses(panel, 'import type { VisiblePass } from "../viz/passes";')).toHaveLength(0);
    expect(staticImportsOfPasses(panel, 'const m = await import("../viz/passes");')).toHaveLength(0);
    expect(staticImportsOfPasses("../src/viz/other.ts", 'import { x } from "./passes";')).toHaveLength(1);
  });

  it("keeps satellite.js in src/viz/passes.ts, loaded only with import()", () => {
    const sources = import.meta.glob<string>(["../src/**/*.{ts,js}", "../shared/**/*.{ts,js}", "../worker/**/*.{ts,js}"], { query: "?raw", import: "default", eager: true });
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    const importers = Object.entries(sources).filter(([, text]) => SATELLITE_JS.test(text)).map(([path]) => path.replace(/^\.\.\//, ""));
    expect(importers).toEqual(["src/viz/passes.ts"]);
    const staticUsers = Object.entries(sources).filter(([path, text]) => staticImportsOfPasses(path, text).length).map(([path]) => path);
    expect(staticUsers).toEqual([]);
  });
});
