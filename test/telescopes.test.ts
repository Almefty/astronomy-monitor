import { afterEach, describe, expect, it, vi } from "vitest";
import { angularSeparation, formatDec, formatRa, smallCircle, sunPosition } from "../shared/astro";
import { Upstream } from "../worker/lib/upstream";
import { classFlux, goesSource, parseFlare, parseFlux } from "../worker/sources/goes";
import {
  columnStarts,
  cut,
  hstTimelines,
  jwstReports,
  mastPositions,
  mergeVisits,
  parseHst,
  parseJwst,
  parseSesame,
  resolvable,
  sunAngleOk,
  telescopeSource,
} from "../worker/sources/telescopes";
import flaresLatest from "./fixtures/goes-flares-latest.json";
import xrays from "./fixtures/goes-xrays-sample.json";
import HST from "./fixtures/hst-timeline_10_12_26-excerpt.txt?raw";
import JWST from "./fixtures/jwst-20261012_report_20261008.txt?raw";


describe("astronomy helpers", () => {
  it("puts the Sun where the almanac does", () => {
    // 2026-03-20 14:46 UTC: March equinox → RA ≈ 0°, Dec ≈ 0°.
    const [ra, dec] = sunPosition(Date.UTC(2026, 2, 20, 14, 46));
    expect(Math.min(ra, 360 - ra)).toBeLessThan(0.05);
    expect(Math.abs(dec)).toBeLessThan(0.05);
    // June solstice → Dec ≈ +23.44°.
    expect(sunPosition(Date.UTC(2026, 5, 21, 8, 24))[1]).toBeCloseTo(23.44, 1);
  });

  it("measures separations and draws small circles", () => {
    expect(angularSeparation(0, 0, 90, 0)).toBeCloseTo(90);
    expect(angularSeparation(10, 10, 10, 10 + 1 / 3600) * 3600).toBeCloseTo(1, 5);
    for (const [ra, dec] of smallCircle(120, 45, 10, 12)) expect(angularSeparation(120, 45, ra, dec)).toBeCloseTo(10, 6);
    expect(formatRa(327.5)).toBe("21h 50m 00s");
    expect(formatDec(-46.8667)).toBe("−46° 52′");
  });
});

describe("JWST weekly report (real file)", () => {
  const rows = parseJwst(JWST);

  it("reads prime visits with start, duration and target", () => {
    const v = rows.find((r) => r.id === "11567:4:1")!;
    expect(v.start).toBe(Date.parse("2026-10-13T18:35:59Z"));
    expect(v.end - v.start).toBe(((7 * 60 + 44) * 60 + 32) * 1000);
    expect(v).toMatchObject({ program: "11567", target: "J2150-4652AB", instrument: "NIRCam Wide Field Slitless Spectroscopy", category: "Galaxy", kind: "science" });
    expect(rows.find((r) => r.target === "2MASS-05230435-5119006")!.kind).toBe("calibration");
    expect(rows.some((r) => r.id.startsWith("1520:"))).toBe(false); // parallel calibrations skipped
  });

  it("rejects a report whose columns moved or vanished", () => {
    expect(() => parseJwst(JWST.replace("TARGET NAME", "TARGET     "))).toThrow(/header/);
    const shifted = JWST.split("\n").map((l, i) => (i < 4 ? l : `            ${l}`)).join("\n");
    expect(() => parseJwst(shifted)).toThrow();
    expect(() => parseJwst("<html>Page not found</html>")).toThrow(/header/);
  });

  it("finds the latest report per week on the schedules page", () => {
    const html = ["20261012_report_20261008", "20261005_report_20261005", "20261005_report_20261002"].map((n) => `<a href="/files/x/_documents/${n}.txt">`).join("");
    const r = jwstReports(html);
    expect(r.map((x) => x.week)).toEqual(["2026-10-12", "2026-10-05"]);
    expect(r[1]!.name).toBe("20261005_report_20261005.txt");
  });
});

describe("Hubble weekly timeline (real file)", () => {
  const { rows, coverage } = parseHst(HST);

  it("reads the coverage and merges exposures into visits", () => {
    expect(new Date(coverage.start).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(new Date(coverage.end).toISOString()).toBe("2026-10-18T23:15:00.000Z");
    const jones = rows.filter((r) => r.target === "DW0930P2143");
    expect(jones.length).toBe(1);
    expect(jones[0]).toMatchObject({ id: "18061 54", program: "18061", instrument: "ACS/WFC", kind: "science", pi: "Jones", title: "Hubble Census of Nearby Satellites" });
    expect(new Date(jones[0]!.start).toISOString()).toBe("2026-10-12T01:39:36.000Z");
  });

  it("marks internal calibrations and keeps sky targets", () => {
    expect(rows.filter((r) => r.target === "DARK").every((r) => r.kind === "internal")).toBe(true);
    expect(rows.find((r) => r.target === "-KSI01-CMA")!.kind).toBe("science");
  });

  it("rejects a timeline in an unexpected format", () => {
    expect(() => parseHst(HST.replace(/SMS Start:/g, "SMS Begin:"))).toThrow(/coverage/);
    expect(() => parseHst(HST.replace(/SU Id   /g, "Visit    "))).toThrow();
    expect(() => parseHst(HST.replace(/Target   /g, "Object   "))).toThrow();
  });

  it("lists timeline files newest first", () => {
    const html = '<a href="timeline_10_12_26">x</a><a href="timeline_10_05_26">x</a><a href="timeline_12_28_25">x</a>';
    expect(hstTimelines(html).map((f) => f.date)).toEqual(["2026-10-12", "2026-10-05", "2025-12-28"]);
  });

  it("merges only contiguous exposures of the same visit", () => {
    const base = { program: "1", category: null, keywords: null, pi: null, title: null, kind: "science" as const, instrument: "ACS/WFC" };
    const merged = mergeVisits([
      { ...base, id: "1 01", target: "A", start: 0, end: 10 },
      { ...base, id: "1 01", target: "A", start: 20, end: 30 },
      { ...base, id: "1 01", target: "A", start: 10 * 3600_000, end: 11 * 3600_000 },
    ]);
    expect(merged.length).toBe(2);
    expect(merged[0]!.end).toBe(30);
  });
});

describe("fixed-width helpers and position lookups", () => {
  it("cuts columns from a dashed separator", () => {
    const starts = columnStarts("---  ----- --");
    expect(starts).toEqual([0, 5, 11]);
    expect(cut("abc  hello xy", starts)).toEqual(["abc", "hello", "xy"]);
  });

  it("reads MAST rows, preferring planned observations", () => {
    const m = mastPositions({ data: [
      { proposal_id: "13006", target_name: "Bubble", s_ra: 1, s_dec: 2, calib_level: 3 },
      { proposal_id: "13006", target_name: "Bubble", s_ra: 343.305, s_dec: 62.148, calib_level: -1 },
      { proposal_id: "13006", target_name: "None", s_ra: null, s_dec: null, calib_level: -1 },
    ] });
    expect(m.get("13006|Bubble")).toEqual({ ra: 343.305, dec: 62.148, source: "mast-planned", approx: false });
    expect(m.has("13006|None")).toBe(false);
    expect(() => mastPositions({ status: "ERROR" })).toThrow();
  });

  it("parses Sesame answers and only asks about catalog-like names", () => {
    const txt = "# NGC 855\t#Q1\n#=Sc=Simbad\n%J 33.51505000 +27.87717222 = 02 14 03.612  +27 52 37.82\n# bogus\t#Q1\n#! *** Nothing found ***\n";
    const r = parseSesame(txt);
    expect(r.get("NGC 855")).toEqual([33.51505, 27.87717222]);
    expect(r.has("bogus")).toBe(false);
    for (const n of ["NGC-855", "TOI-1774", "GRW+70D5824", "-KSI01-CMA", "HD207129", "UGC8882"]) expect(resolvable(n)).toBe(true);
    for (const n of ["Bubble", "East_Lobe", "catalog_gds_all_v6", "runaway_star", "PAR617"]) expect(resolvable(n)).toBe(false);
  });

  it("checks positions against the telescopes' Sun-angle limits", () => {
    const t = Date.UTC(2026, 9, 13);
    const [sra, sdec] = sunPosition(t);
    expect(sunAngleOk("HST", sra + 5, sdec, t)).toBe(false);
    expect(sunAngleOk("HST", sra + 180, -sdec, t)).toBe(true);
    expect(sunAngleOk("JWST", sra + 180, -sdec, t)).toBe(false); // JWST can't look anti-Sun
    expect(sunAngleOk("JWST", sra + 100, 0, t)).toBe(true);
    // A real JWST target from the report: Kepler-89 (MAST planned pointing) on 15 Oct.
    expect(sunAngleOk("JWST", 297.33306, 41.89111, Date.parse("2026-10-15T15:34:03Z"))).toBe(true);
  });
});

describe("telescope source end-to-end (mocked network)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("combines schedules, MAST and name positions, and isolates a broken schedule", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("observing-schedules") && !url.endsWith(".txt")) return new Response('<a href="/x/_documents/20261012_report_20261008.txt">');
      if (url.endsWith("20261012_report_20261008.txt")) return new Response(JWST);
      if (url.includes("weekly_timeline/?")) return new Response('<a href="timeline_10_12_26">');
      if (url.includes("timeline_10_12_26")) return new Response("<html>Maintenance</html>");
      if (url.includes("mast.stsci.edu")) {
        const req = JSON.parse(new URLSearchParams(String(init?.body)).get("request")!);
        expect(req.params.filters.find((f: { paramName: string }) => f.paramName === "calib_level").values).toEqual([-1]);
        return Response.json({ status: "COMPLETE", data: [{ proposal_id: "10674", target_name: "Kepler-89", s_ra: 297.33306, s_dec: 41.89111, calib_level: -1 }] });
      }
      if (url.includes("sesame")) return new Response("");
      return new Response("nope", { status: 404 });
    });
    const data = await telescopeSource.load({ env: {} as never, upstream: new Upstream(), params: new URLSearchParams(), now: new Date("2026-10-14T00:00:00Z"), notices: [], noCache: () => {} });
    const [jwst, hst] = data.schedules;
    expect(jwst!.error).toBeNull();
    const kepler = jwst!.observations.find((o) => o.target === "Kepler-89")!;
    expect(kepler).toMatchObject({ posSource: "mast-planned", ra: 297.33306 });
    const named = jwst!.observations.find((o) => o.target === "J2150-4652AB")!;
    expect(named).toMatchObject({ posSource: "name", posApprox: true });
    expect(hst!.error?.kind).toBe("format");
    expect(hst!.observations).toEqual([]);
  });
});

describe("GOES X-ray flux", () => {
  it("pairs both channels per minute", () => {
    const { points, satellite } = parseFlux(xrays);
    expect(satellite).toBe(18);
    expect(points.length).toBe(30);
    expect(points.every((p) => p[1] !== null && p[1]! > 1e-9)).toBe(true);
    expect(points[1]![0] - points[0]![0]).toBe(60_000);
  });

  it("drops missing values and rejects foreign formats", () => {
    const { points } = parseFlux([{ time_tag: "2026-10-13T00:00:00Z", flux: -1e5, energy: "0.1-0.8nm" }]);
    expect(points[0]![1]).toBeNull();
    expect(() => parseFlux({ error: true })).toThrow();
  });

  it("reads SWPC's flare summary", () => {
    const f = parseFlare(flaresLatest[0]!)!;
    expect(f).toMatchObject({ maxClass: "C1.2", end: "2026-10-13T03:47:00.000Z" });
    expect(f.maxFlux).toBeCloseTo(1.28e-6);
    expect(classFlux("M2.3")).toBeCloseTo(2.3e-5);
    expect(classFlux("bogus")).toBeNull();
  });

  it("loads the 6-hour file for live updates", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return Response.json(url.includes("xrays-") ? xrays : flaresLatest);
    });
    const d = await goesSource.load({ env: {} as never, upstream: new Upstream(), params: new URLSearchParams("hours=6"), now: new Date(), notices: [], noCache: () => {} });
    expect(urls.some((u) => u.endsWith("xrays-6-hour.json"))).toBe(true);
    expect(urls.some((u) => u.includes("7-day"))).toBe(false);
    expect(d.latestFlare?.currentClass).toBe("B6.7");
    vi.unstubAllGlobals();
  });
});

describe("GOES truncated files", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries once when SWPC serves a half-written file", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("xrays-")) return new Response(n++ === 0 ? JSON.stringify(xrays).slice(0, 500) : JSON.stringify(xrays));
      return Response.json(flaresLatest);
    });
    const up = new Upstream();
    const d = await goesSource.load({ env: {} as never, upstream: up, params: new URLSearchParams("hours=6"), now: new Date(), notices: [], noCache: () => {} });
    expect(d.points.length).toBe(30);
    expect(up.calls.filter((c) => c.name.startsWith("SWPC GOES X-ray flux")).length).toBe(2);
  });

  it("explains in plain words when the retry is truncated too", async () => {
    vi.stubGlobal("fetch", async () => new Response('[{"time_tag": "2026-10-13T12:11:00Z", "satellite": 18, "flux'));
    await expect(goesSource.load({ env: {} as never, upstream: new Upstream(), params: new URLSearchParams("hours=6"), now: new Date(), notices: [], noCache: () => {} })).rejects.toThrow(/incomplete X-ray file/);
  });
});
