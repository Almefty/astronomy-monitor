import { describe, expect, it } from "vitest";
import { angularSeparation } from "../shared/astro";
import { extractPositions, parseErrorRadius, positionFromName, resolverName } from "../worker/lib/coords";
import {
  bestPosition,
  buildEvents,
  chooseBodies,
  designation,
  groupEvents,
  gwInfo,
  mergePreliminary,
  normalizeCircular,
  parseListHtml,
  parseListJson,
  stripEmail,
  triggerTime,
} from "../worker/sources/gcn";
import circulars from "./fixtures/gcn-circulars-sample.json";
import listing from "./fixtures/gcn-archive-listing.json";

type Raw = { circularId: number; subject: string; body: string; eventId?: string | null; createdOn?: number };
const byId = new Map((circulars as Raw[]).map((c) => [c.circularId, c]));
const body = (id: number) => byId.get(id)!.body;
const first = (id: number) => extractPositions(body(id))[0]!;

describe("coordinates in circular text (real circulars)", () => {
  it("reads Fermi GBM decimal positions with a degree error", () => {
    const p = first(45943);
    expect(p.ra).toBeCloseTo(138.6);
    expect(p.dec).toBeCloseTo(17.6);
    expect(p.errDeg).toBeCloseTo(15.4);
  });

  it("reads Swift-XRT sexagesimal positions with arcsec errors", () => {
    const p = first(45815); // "RA (J2000): 17 01 21.42 / Dec (J2000): +01 35 19.4 … 2.2 arcsec"
    expect(p.ra).toBeCloseTo(255.33925, 4);
    expect(p.dec).toBeCloseTo(1.58872, 4);
    expect(p.errDeg! * 3600).toBeCloseTo(2.2, 3);
  });

  it("reads Swift-BAT 'RA, Dec = a, b deg' with arcmin errors", () => {
    const p = first(45812);
    expect(p.ra).toBeCloseTo(255.327);
    expect(p.dec).toBeCloseTo(1.59);
    expect(p.errDeg! * 60).toBeCloseTo(3);
  });

  it("reads IceCube ± containment as the error radius", () => {
    const p = first(45929); // RA: 177.71 (+0.54/-0.53 …) Dec: 8.95 (+0.33/-0.42 …)
    expect(p.ra).toBeCloseTo(177.71);
    expect(p.dec).toBeCloseTo(8.95);
    expect(p.errDeg).toBeGreaterThan(0.5);
    expect(p.errDeg).toBeLessThan(0.6);
  });

  it("reads SVOM 'R.A., Dec. a, b degrees' and Einstein Probe 'R.A. = … deg, DEC = … deg'", () => {
    expect(first(45824).ra).toBeCloseTo(11.5787);
    expect(first(45824).dec).toBeCloseTo(-17.6698);
    const ep = first(45828);
    expect(ep.ra).toBeCloseTo(11.629);
    expect(ep.dec).toBeCloseTo(-17.694);
    expect(ep.errDeg! * 60).toBeCloseTo(3);
  });

  it("reads 'Ra,Dec=(a,b degree)', colon-sexagesimal pairs and MAXI's (R.A., Dec) = (a deg, b deg)", () => {
    expect(first(45825).ra).toBeCloseTo(11.6142);
    expect(first(45857).ra).toBeCloseTo(21.79058, 4); // 01:27:09.74
    expect(first(45857).dec).toBeCloseTo(12.88939, 4);
    expect(first(45857).errDeg! * 3600).toBeCloseTo(6.7, 3);
    const maxi = first(45919);
    expect(maxi.ra).toBeCloseTo(297.193);
    expect(maxi.dec).toBeCloseTo(-36.587);
    expect(maxi.errDeg).toBeCloseTo(0.32);
  });

  it("finds nothing in circulars without positions", () => {
    expect(extractPositions(body(45935))).toEqual([]);
    expect(extractPositions(body(45792))).toEqual([]);
  });

  it("rejects out-of-range or ambiguous values", () => {
    expect(extractPositions("RA = 400.1, Dec = 12.0")).toEqual([]);
    expect(extractPositions("RA = 12.5, Dec = 95.0")).toEqual([]);
    expect(extractPositions("RA (J2000) = 25h 10m 00s, Dec (J2000) = +10d 00' 00\"")).toEqual([]);
  });

  it("parses error radii in all the usual phrasings", () => {
    expect(parseErrorRadius("with a 90%-confidence error radius of about 1.10 arc sec")! * 3600).toBeCloseTo(1.1);
    expect(parseErrorRadius("with a 90% confidence level (C.L.) radius of 2.17 arcmin")! * 60).toBeCloseTo(2.17);
    expect(parseErrorRadius("with a statistical uncertainty of 4.2 degrees.")).toBeCloseTo(4.2);
    expect(parseErrorRadius("no error given here")).toBeNull();
  });
});

describe("coordinates in target names", () => {
  it("decodes J-names, SDSS, 2MASS (with and without J) and SPT names", () => {
    const a = positionFromName("J095236+405249")!;
    expect(a.ra).toBeCloseTo(148.15, 2);
    expect(a.dec).toBeCloseTo(40.88028, 4);
    expect(a.approx).toBe(false);
    expect(positionFromName("SDSSJ124416.60+501014.0")!.ra).toBeCloseTo(191.06917, 4);
    const m = positionFromName("2MASS-J04285053+1844361")!;
    expect(m.ra).toBeCloseTo(67.21054, 4);
    expect(m.dec).toBeCloseTo(18.74336, 4);
    expect(positionFromName("2MASS-03313052-2739514")!.dec).toBeCloseTo(-27.66428, 4);
    expect(positionFromName("BPMG-2MASS-J07180871-6415310")!.dec).toBeCloseTo(-64.25861, 4);
    const spt = positionFromName("SPT-S-J205239-5611.9")!;
    expect(spt.dec).toBeCloseTo(-(56 + 11.9 / 60), 4);
  });

  it("marks coarse names as approximate and understands P/M signs", () => {
    const c = positionFromName("J2150-4652AB")!;
    expect(c.approx).toBe(true);
    expect(c.ra).toBeCloseTo(327.5);
    expect(c.dec).toBeCloseTo(-46.8667, 3);
    expect(positionFromName("DW0936P2135")!.dec).toBeGreaterThan(21);
    expect(positionFromName("DW0315M4112")!.dec).toBeLessThan(-41);
  });

  it("does not invent positions for ordinary names", () => {
    for (const n of ["TOI-1774", "NGC-1549", "JUPITER-88-PJ", "HD207129", "GJ1214", "Bubble", "TYC-3814-1598-1", "J9999+9999"]) {
      expect(positionFromName(n)).toBeNull();
    }
  });

  it("rewrites STScI names for the CDS resolver", () => {
    expect(resolverName("NGC-855")).toBe("NGC 855");
    expect(resolverName("-KSI01-CMA")).toBe("ksi01 Cma");
    expect(resolverName("GRW+70D5824")).toBe("GRW +70 5824");
    expect(resolverName("TOI-1774")).toBe("TOI-1774");
  });
});

describe("GCN events", () => {
  it("recognises designations in subjects", () => {
    expect(designation("GRB 261013A: Fermi GBM Final Real-time Localization")).toMatchObject({ type: "grb", name: "GRB 261013A", date: "2026-10-13" });
    expect(designation("GRB 261007A / EP261007a: SVOM/VT optical observations")!.aliases).toEqual(["EP261007a"]);
    expect(designation("EP261007a/GRB 261007A: Einstein Probe detection")!.name).toBe("GRB 261007A");
    expect(designation("Fermi-LAT Gamma-ray Observations of IceCube-261012A")).toMatchObject({ type: "neutrino", name: "IceCube-261012A" });
    expect(designation("IceCube Alert 260930A: Global MASTER-Net observations report")!.name).toBe("IceCube-260930A");
    expect(designation("LIGO/Virgo/KAGRA S251105aj: SVOM/ECLAIRs detection of a high-energy transient")).toMatchObject({ type: "gw", name: "S251105aj", date: "2025-11-05" });
    expect(designation("MAXI GRB261012.23: Global MASTER-Net observations report")!.name).toBe("GRB 261012.23");
    expect(designation("EP261010a Einstein Probe detection of an X-ray transient")).toBeNull();
  });

  it("groups the real archive list into events, merging EP aliases into GRBs", () => {
    const { items } = parseListJson(listing);
    expect(items.length).toBe(60);
    const { events } = groupEvents(items);
    const grb = events.find((e) => e.name === "GRB 261007A")!;
    expect([...grb.aliases]).toContain("EP261007a");
    expect(events.find((e) => e.name === "IceCube-261012A")!.items.length).toBe(2);
    expect(events.every((e) => !e.name.startsWith("EP"))).toBe(true);
  });

  it("spends the body budget on the most informative circulars, newest events first", () => {
    const { events } = groupEvents(parseListJson(listing).items);
    const ids = chooseBodies(events, 12);
    expect(ids.length).toBe(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids).toContain(45933); // GRB 261011A: Enhanced Swift-XRT position
  });

  it("picks the most precise consistent position and skips inconsistent ones", () => {
    const gbm = { ra: 21.9, dec: -21.5, errDeg: 5, circularId: 1, from: "Fermi GBM" };
    const xrt = { ra: 21.8972, dec: -21.5605, errDeg: 2.9 / 3600, circularId: 2, from: "Swift-XRT" };
    const wrong = { ra: 200, dec: 10, errDeg: 1 / 3600, circularId: 3, from: "circular" };
    expect(bestPosition([gbm, xrt])!.circularId).toBe(2);
    expect(bestPosition([gbm, wrong, xrt])!.circularId).toBe(2);
    expect(bestPosition([])).toBeNull();
  });

  it("builds events with positions, trigger times and GW details from real circulars", () => {
    const items = (circulars as Raw[]).map((c) => ({ circularId: c.circularId, subject: c.subject }));
    const { events: drafts } = groupEvents(items);
    const bodies = new Map((circulars as Raw[]).map((c) => [c.circularId, normalizeCircular(c)]));
    const events = buildEvents(drafts, bodies);
    const g = events.find((e) => e.name === "GRB 261011A")!;
    // Swift's detection circular states BAT (3′), then a UVOT afterglow position (1.1″).
    expect(g.position!.from).toBe("Swift-UVOT");
    expect(g.position!.errDeg! * 3600).toBeCloseTo(1.1);
    expect(angularSeparation(g.position!.ra, g.position!.dec, 21.89746, -21.56032)).toBeLessThan(0.0005);
    const b = events.find((e) => e.name === "GRB 261005B")!;
    expect(b.position!.from).toBe("Swift-XRT");
    const ic = events.find((e) => e.name === "IceCube-261012A")!;
    expect(ic.position!.from).toBe("IceCube");
    expect(ic.triggerTime?.startsWith("2026-10-12")).toBe(true);
    const gw = events.find((e) => e.name === "S251117dq")!;
    expect(gw.position).toBeNull();
    expect(gw.gw).toMatchObject({ areaDeg2: 1547, classification: "BBH (>99%)" });
    expect(events.find((e) => e.name === "GRB 261013A")!.triggerTime).toBe("2026-10-13T13:57:44.000Z");
  });

  it("reads trigger times and LVK details", () => {
    expect(triggerTime("At 13:57:44 UT on 13 Oct 2026, the Fermi GBM triggered", "2026-10-13")).toBe("2026-10-13T13:57:44.000Z");
    expect(triggerTime("triggered at 2026-10-07T06:47:00 (UTC)", "2026-10-07")).toBe("2026-10-07T06:47:00.000Z");
    expect(triggerTime("At 13:57:44 UT", null)).toBeNull();
    expect(gwInfo(body(42727)).classification).toBe("BBH (>99%)");
  });

  it("parses the archive HTML fallback and strips e-mail addresses", () => {
    const html = '<li value="45943"><a class="usa-link" href="/circulars/45943">GRB 261013A: Fermi GBM Final &amp; Real-time Localization</a></li>';
    expect(parseListHtml(html)).toEqual([{ circularId: 45943, subject: "GRB 261013A: Fermi GBM Final & Real-time Localization" }]);
    expect(stripEmail("Fermi GBM Team at MSFC/Fermi-GBM <do_not_reply@GIOC.nsstc.nasa.gov>")).toBe("Fermi GBM Team at MSFC/Fermi-GBM");
  });

  it("rejects an archive list in an unknown format", () => {
    expect(() => parseListJson({ results: [] })).toThrow();
  });
});

describe("GCN refinements", () => {
  const ev = (name: string, date: string, triggerTime: string | null, ids: number[]) =>
    ({ name, type: "grb" as const, aliases: [], date, triggerTime, position: null, gw: null, circulars: ids.map((id) => ({ id, subject: name, createdOn: null })) });

  it("merges preliminary alert names into the matching lettered GRB", () => {
    const out = mergePreliminary([
      ev("GRB 261007A", "2026-10-07", "2026-10-07T05:42:03.000Z", [45850]),
      ev("GRB 261007.23", "2026-10-07", "2026-10-07T17:00:00.000Z", [45835]),
      ev("GRB 261007.27", "2026-10-07", null, [45842]),
    ]);
    expect(out.map((e) => e.name)).toEqual(["GRB 261007A", "GRB 261007.27"]);
    expect(out[0]!.aliases).toEqual(["GRB 261007.23"]);
    expect(out[0]!.circulars.map((c) => c.id)).toEqual([45850, 45835]);
    expect(out[1]!.triggerTime).toBe("2026-10-07T06:28:48.000Z");
  });

  it("labels positions in ground-based follow-ups by the circular, not by cited instruments", () => {
    const body = "We observed GRB 261011A (Cenko et al., GCN 45896, Swift BAT trigger).\n\nThe afterglow is at RA (J2000) = 01:27:35.34, Dec (J2000) = -21:33:37.9 with an uncertainty of 0.15 arcsec.";
    const items = [{ circularId: 1, subject: "GRB 261011A: SOAR optical afterglow observations" }];
    const { events: drafts } = groupEvents(items);
    const out = buildEvents(drafts, new Map([[1, normalizeCircular({ circularId: 1, subject: items[0]!.subject, body })]]));
    expect(out[0]!.position!.from).toBe("optical afterglow");
  });
});
