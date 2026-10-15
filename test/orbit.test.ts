import { describe, expect, it } from "vitest";
import {
  closestApproach, earthPosition, jdTdb, keplerPosition, KM_PER_AU, moonGeocentric, msFromJdTdb, norm, orbitPath,
  periodDays, planetPosition, solveKepler, solveKeplerHyperbolic, sub, type PlanetId, type Vec3,
} from "../shared/orbit";
import { cdataChunks, designationFilter, parseOrbits } from "../worker/sources/orbits";
import fx from "./fixtures/orbits-2026-10-15.json";

const H = fx.horizons as unknown as Record<string, Record<string, Vec3>>;
const BODY: Record<string, PlanetId> = { "199": "mercury", "299": "venus", "3": "emb", "499": "mars", "599": "jupiter", "699": "saturn", "799": "uranus", "899": "neptune" };
/** JPL's nominal Table 1 errors (distance part), plus margin for the angular part, km. */
const LIMIT_KM: Record<PlanetId, number> = {
  mercury: 20_000, venus: 25_000, emb: 25_000, mars: 60_000, jupiter: 1_500_000, saturn: 5_000_000, uranus: 2_500_000, neptune: 2_500_000,
};

describe("Kepler solvers", () => {
  it("solves elliptic and hyperbolic equations", () => {
    for (const e of [0, 0.1, 0.5, 0.9, 0.99]) {
      for (const M of [-3, -1, 0.001, 1, 2.5, 3.1, 20]) {
        const E = solveKepler(M, e);
        const m = M - 2 * Math.PI * Math.round(M / (2 * Math.PI));
        expect(E - e * Math.sin(E)).toBeCloseTo(m, 10);
      }
    }
    for (const e of [1.01, 1.5, 4]) for (const M of [-10, -0.2, 0.3, 8]) {
      const Hh = solveKeplerHyperbolic(M, e);
      expect(e * Math.sinh(Hh) - Hh).toBeCloseTo(M, 9);
    }
  });

  it("closes orbits and keeps perihelion at q", () => {
    const el = { e: 0.4, q: 0.8, i: 10, om: 30, w: 60, tp: 2461000 };
    const P = periodDays(el);
    const a = keplerPosition(el, 2461100), b = keplerPosition(el, 2461100 + P);
    expect(norm(sub(a, b))).toBeLessThan(1e-9);
    expect(norm(keplerPosition(el, el.tp))).toBeCloseTo(0.8, 12);
    expect(norm(keplerPosition({ ...el, e: 1.2 }, el.tp))).toBeCloseTo(0.8, 12);
    expect(norm(keplerPosition({ ...el, e: 1 }, el.tp))).toBeCloseTo(0.8, 12);
    const path = orbitPath(el, 64);
    expect(path).toHaveLength(65);
    expect(Math.min(...path.map(norm))).toBeCloseTo(0.8, 6);
  });

  it("converts UTC ↔ TDB", () => {
    const ms = Date.UTC(2026, 9, 15);
    expect(jdTdb(ms) - 2461328.5).toBeCloseTo(69.184 / 86400, 9);
    expect(msFromJdTdb(jdTdb(ms))).toBeCloseTo(ms, 1);
  });
});

describe("planets and Moon vs JPL Horizons (DE441)", () => {
  for (const [jd, bodies] of Object.entries(H)) {
    it(`agrees within JPL's stated errors at JD ${jd}`, () => {
      for (const [id, planet] of Object.entries(BODY)) {
        const errKm = norm(sub(planetPosition(planet, Number(jd)), bodies[id]!)) * KM_PER_AU;
        expect(errKm, planet).toBeLessThan(LIMIT_KM[planet]);
      }
      expect(norm(sub(earthPosition(Number(jd)), bodies["399"]!)) * KM_PER_AU).toBeLessThan(25_000);
      // Moon (truncated Meeus series): better than 200 km here (~0.03°).
      expect(norm(sub(moonGeocentric(Number(jd)), bodies["301"]!)) * KM_PER_AU).toBeLessThan(200);
    });
  }
});

describe("asteroid two-body orbits vs CNEOS close approaches", () => {
  const orbits = parseOrbits(fx.sbdb);
  const f = (n: string) => fx.cad.fields.indexOf(n);

  it("parses SBDB rows with full precision", () => {
    expect(Object.keys(orbits)).toHaveLength(14);
    const tx = orbits["2026 TX"]!;
    expect(tx.e).toBeCloseTo(0.3507986242868118, 15);
    expect(tx.epoch).toBe(2461200.5);
    expect(tx.conditionCode).toBe(7);
  });

  it("reproduces official miss distances for well-determined, recent-epoch orbits", () => {
    for (const row of fx.cad.data) {
      const des = row[f("des")]!;
      const o = orbits[des]!;
      const jd = Number(row[f("jd")]), dist = Number(row[f("dist")]);
      const ca = closestApproach(o, jd, 3);
      const rel = Math.abs(ca.dist - dist) / dist;
      if (jd - o.epoch < 400) {
        expect(rel, des).toBeLessThan(0.08);
        // Slow, distant passes (2012 YD7: 18.5 LD) have a shallow minimum, so the time drifts more.
        expect(Math.abs(ca.jd - jd) * 24, des).toBeLessThan(dist < 0.01 ? 2 : 15);
      }
    }
  });

  it("is visibly off for a stale orbit (2022 UP6: one-day arc, epoch 2022) — the UI flags it", () => {
    const row = fx.cad.data.find((r) => r[0] === "2022 UP6")!;
    const ca = closestApproach(orbits["2022 UP6"]!, Number(row[f("jd")]), 3);
    expect(Math.abs(ca.dist - Number(row[f("dist")])) / Number(row[f("dist")])).toBeGreaterThan(0.25);
  });
});

describe("SBDB query building", () => {
  it("turns designations into anchored regexes and rejects odd characters", () => {
    expect(designationFilter("2026 TX")).toBe("pdes|RE|^2026 TX$");
    expect(designationFilter("P/2019 LD2")).toBe("pdes|RE|^P/2019 LD2$");
    expect(designationFilter("x|y")).toBeNull();
    expect(designationFilter("a.*")).toBeNull();
  });

  it("splits long lists under the sb-cdata length limit", () => {
    const des = Array.from({ length: 130 }, (_, k) => `2026 T${String.fromCharCode(65 + (k % 26))}${k}`);
    const chunks = cdataChunks(des);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(700);
    expect(chunks.map((c) => (JSON.parse(c).OR ?? JSON.parse(c).AND).length).reduce((a: number, b: number) => a + b, 0)).toBe(130);
    expect(JSON.parse(cdataChunks(["433"])[0]!)).toEqual({ AND: ["pdes|RE|^433$"] });
  });
});
