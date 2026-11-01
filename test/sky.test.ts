import { describe, expect, it } from "vitest";
import { angularSeparation } from "../shared/astro";
import {
  findCrossings, geocentricVectorOfDate, gmst, localDate, localSiderealTime, moonPhase, moonPhaseEvents, moonPhaseName,
  nightEvents, nightWindow, norm180, planetAstrometric, planetInfo, planetMagnitude, PRESET_PLACES, refraction,
  refractionFromApparent, riseTransitSet, skyPosition, SKY_PLANETS, timeZoneOffset, toObserver, vecToRaDec, zonedTimeToUtc,
  equatorialToHorizontal, type NightEvent, type SkyBody, type SkyPlanet,
} from "../shared/sky";
import fx from "./fixtures/sky-reference.json";

/*
 * References (test/fixtures/sky-reference.json, built by scripts/fetch-sky-fixtures.mjs on 2026-11-01):
 * JPL Horizons observer tables (DE441) and USNO's rise/set/twilight and Moon-phase APIs, for Jakarta,
 * Tromsø and Cape Town. Measured worst cases when the fixture was made are noted next to each limit.
 */

type Row = { ms: number; ra: number; dec: number; az: number; el: number; mag: number | null; illum: number };
type Site = { lat: number; lon: number; tz: number };
const POS = fx.positions as unknown as Record<string, Record<string, Row[]>>;
const SITES = fx.sites as Record<string, Site>;
const MIN = 60_000;
const minutes = (a: number, b: number) => Math.abs(a - b) / MIN;
const at = (e: NightEvent) => (e.state === "time" ? e.ms : NaN);

/** Sky-position limits vs Horizons apparent airless az/el, degrees. */
const POSITION_LIMIT: Record<SkyBody, number> = {
  sun: 0.02, // measured 0.003°
  moon: 0.2, // 0.007°
  mercury: 0.1, venus: 0.1, mars: 0.1, neptune: 0.1, uranus: 0.1, // ≤ 0.014°
  jupiter: 0.1, // 0.038° (JPL Table 1: up to 400″ heliocentric)
  saturn: 0.1, // 0.076° — Table 1's largest error (up to 600″); expect it to approach 0.1° on other dates
};

describe("sidereal time and frames", () => {
  it("matches Meeus' GMST examples 12.a and 12.b", () => {
    expect(gmst(Date.UTC(1987, 3, 10))).toBeCloseTo(197.693195, 5);
    expect(gmst(Date.UTC(1987, 3, 10, 19, 21))).toBeCloseTo(128.7378734, 5);
    expect(localSiderealTime(Date.UTC(1987, 3, 10), -77.065556)).toBeCloseTo(197.693195 - 77.065556, 5);
  });

  it("converts equatorial to horizontal (zenith, horizon, azimuth convention)", () => {
    expect(equatorialToHorizontal(100, 40, 100, 40).alt).toBeCloseTo(90, 9);
    // Due east on the celestial equator, 6 h before transit: on the horizon at azimuth 90°.
    const e = equatorialToHorizontal(90, 0, 0, 30);
    expect(e.alt).toBeCloseTo(0, 9);
    expect(e.az).toBeCloseTo(90, 9);
    // A star south of the zenith at transit has azimuth 180° (north through east).
    expect(equatorialToHorizontal(0, 10, 0, 50).az).toBeCloseTo(180, 9);
  });

  it("applies standard refraction for display only", () => {
    // ~34′ at the apparent horizon; Bennett and Sæmundsson invert each other to ~0.1′.
    expect(refractionFromApparent(0) * 60).toBeCloseTo(34.5, 0);
    for (const h of [-0.5, 0, 2, 10, 45, 80]) {
      const apparent = h + refraction(h);
      expect(Math.abs(apparent - refractionFromApparent(apparent) - h) * 60).toBeLessThan(0.15);
    }
    expect(refraction(90)).toBe(0);
    expect(refraction(-10)).toBe(0);
    expect(refraction(-3)).toBeGreaterThan(0);
  });
});

describe("positions vs JPL Horizons", () => {
  for (const [site, bodies] of Object.entries(POS)) {
    it(`apparent altitude/azimuth at ${site}`, () => {
      for (const [body, rows] of Object.entries(bodies)) {
        for (const r of rows) {
          const p = skyPosition(body as SkyBody, r.ms, SITES[site]!);
          const err = angularSeparation(p.az, p.alt, r.az, r.el);
          expect(err, `${body} ${new Date(r.ms).toISOString()}`).toBeLessThan(POSITION_LIMIT[body as SkyBody]);
        }
      }
    });
  }

  it("astrometric RA/Dec of the planets (light-time corrected, J2000)", () => {
    for (const body of SKY_PLANETS) {
      for (const r of POS.jakarta![body]!) {
        const a = planetAstrometric(body, r.ms);
        // Horizons' values are topocentric; parallax is ≤ 0.01° for the planets.
        expect(angularSeparation(a.ra, a.dec, r.ra, r.dec), body).toBeLessThan(POSITION_LIMIT[body]);
      }
    }
  });

  it("needs the topocentric correction for the Moon (parallax ~1°)", () => {
    const r = POS.tromso!.moon![0]!; // just below the horizon at Tromsø
    const geo = vecToRaDec(geocentricVectorOfDate("moon", r.ms));
    const geoAlt = equatorialToHorizontal(geo.ra, geo.dec, localSiderealTime(r.ms, SITES.tromso!.lon), SITES.tromso!.lat).alt;
    expect(Math.abs(geoAlt - r.el)).toBeGreaterThan(0.5);
    expect(Math.abs(skyPosition("moon", r.ms, SITES.tromso!).alt - r.el)).toBeLessThan(0.05);
  });
});

describe("brightness and phases vs JPL Horizons", () => {
  it("planet magnitudes within 0.2 (measured ≤ 0.04; Saturn's simplified ring term ≤ 0.04)", () => {
    for (const body of SKY_PLANETS) {
      for (const r of POS.jakarta![body]!) {
        const info = planetInfo(body, r.ms);
        expect(info.mag, body).not.toBeNull();
        expect(Math.abs(info.mag! - r.mag!), `${body} ${new Date(r.ms).toISOString()}`).toBeLessThan(0.2);
        expect(Math.abs(info.illuminated * 100 - r.illum), body).toBeLessThan(0.5);
      }
    }
  });

  it("gives elongation from the Sun and returns null outside a model's range", () => {
    const sun = POS.jakarta!.sun![0]!;
    for (const body of SKY_PLANETS) {
      const p = POS.jakarta![body]![0]!;
      expect(Math.abs(planetInfo(body, p.ms).elongation - angularSeparation(sun.ra, sun.dec, p.ra, p.dec)), body).toBeLessThan(0.1);
    }
    expect(planetMagnitude("venus", 0.72, 0.27, 179.5)).toBeNull();
    expect(planetMagnitude("venus", 0.72, 0.27, 170)).not.toBeNull();
  });

  it("Moon illuminated fraction within 1 percentage point (topocentric; measured 0.003)", () => {
    for (const [site, bodies] of Object.entries(POS)) {
      for (const r of bodies.moon!) {
        expect(Math.abs(moonPhase(r.ms, SITES[site]!).illuminated * 100 - r.illum), site).toBeLessThan(1);
      }
    }
  });
});

describe("Moon phases vs USNO", () => {
  const ref = fx.moonPhases as { phase: string; ms: number }[];
  const events = moonPhaseEvents(ref[0]!.ms - 2 * 86_400_000, ref.at(-1)!.ms + 2 * 86_400_000);

  it("finds every principal phase within 2 minutes (measured 1.8; USNO rounds to the minute)", () => {
    expect(events).toHaveLength(ref.length);
    ref.forEach((r, k) => {
      expect(events[k]!.phase).toBe(r.phase);
      expect(minutes(events[k]!.ms, r.ms), `${r.phase} ${new Date(r.ms).toISOString()}`).toBeLessThan(2);
    });
  });

  it("names the phase, its direction and the age", () => {
    const full = ref.find((r) => r.phase === "Full Moon")!.ms;
    const newMoon = ref.find((r) => r.phase === "New Moon")!.ms;
    expect(moonPhase(full).name).toBe("Full Moon");
    expect(moonPhase(full).illuminated).toBeGreaterThan(0.99);
    const p = moonPhase(newMoon + 3 * 86_400_000);
    expect(p.name).toBe("Waxing Crescent");
    expect(p.waxing).toBe(true);
    expect(p.ageDays).toBeCloseTo(3, 2);
    expect(moonPhase(full + 4 * 86_400_000).name).toBe("Waning Gibbous");
    expect(moonPhase(full + 4 * 86_400_000).waxing).toBe(false);
    expect(moonPhaseName(359)).toBe("New Moon");
    expect(moonPhaseName(84)).toBe("First Quarter");
    expect(moonPhaseName(83)).toBe("Waxing Crescent");
    expect(moonPhaseName(275)).toBe("Last Quarter");
    expect(moonPhaseName(300)).toBe("Waning Crescent");
  });
});

describe("night events", () => {
  const TW = fx.twilight as unknown as Record<string, Record<string, { windowStart: number; events: { limit: number; kind: string; ms: number }[] }>>;
  // The fixture used each site's standard offset for "local noon"; fixed-offset IANA zones reproduce it.
  const ZONE: Record<string, string> = { jakarta: "Asia/Jakarta", tromso: "Etc/GMT-1", capetown: "Africa/Johannesburg" };

  for (const [site, days] of Object.entries(TW)) {
    it(`sunset, twilights and sunrise at ${site} vs Horizons' Sun elevation (≤ 2 min; measured 0.04)`, () => {
      for (const [day, ref] of Object.entries(days)) {
        const n = nightEvents(SITES[site]!, day, ZONE[site]!);
        expect(n.start).toBe(ref.windowStart);
        const pick: Record<string, NightEvent> = {
          "-0.8333down": n.sunset, "-0.8333up": n.sunrise, "-6down": n.civilDusk, "-6up": n.civilDawn,
          "-12down": n.nauticalDusk, "-12up": n.nauticalDawn, "-18down": n.astronomicalDusk, "-18up": n.astronomicalDawn,
        };
        for (const e of ref.events) expect(minutes(at(pick[`${e.limit}${e.kind}`]!), e.ms), `${day} ${e.limit} ${e.kind}`).toBeLessThan(2);
      }
    });
  }

  it("reports polar night and polar day as states, not NaN", () => {
    const winter = nightEvents(SITES.tromso!, "2026-12-21", "Europe/Oslo");
    expect(winter.sunset).toEqual({ state: "always-below" });
    expect(winter.sunrise).toEqual({ state: "always-below" });
    expect(winter.astronomicalDusk.state).toBe("time");
    const summer = nightEvents(SITES.tromso!, "2027-06-21", "Europe/Oslo");
    for (const k of ["sunset", "sunrise", "civilDusk", "nauticalDawn", "astronomicalDusk", "astronomicalDawn"] as const) {
      expect(summer[k]).toEqual({ state: "always-above" });
    }
    // White nights: London in June has no astronomical darkness, but does have a sunset.
    const london = nightEvents({ lat: 51.51, lon: -0.13 }, "2027-06-21", "Europe/London");
    expect(london.sunset.state).toBe("time");
    expect(london.astronomicalDusk).toEqual({ state: "always-above" });
  });

  const US = fx.usno as unknown as Record<string, Record<string, { tz: number; sun: { phen: string; ms: number | null }[]; moon: { phen: string; ms: number | null }[] }>>;
  const KEY: Record<string, "rise" | "set" | "transit"> = { Rise: "rise", Set: "set", "Upper Transit": "transit" };

  for (const [site, days] of Object.entries(US)) {
    it(`Sun and Moon rise/transit/set at ${site} vs USNO (≤ 2 min; measured 0.93)`, () => {
      for (const [day, ref] of Object.entries(days)) {
        const start = Date.parse(`${day}T00:00:00Z`) - ref.tz * 3_600_000;
        const end = start + 86_400_000;
        for (const body of ["sun", "moon"] as const) {
          const r = riseTransitSet(body, SITES[site]!, start, end);
          for (const e of ref[body]) {
            const key = KEY[e.phen];
            if (key && e.ms !== null) expect(minutes(r[key] ?? NaN, e.ms), `${day} ${body} ${e.phen}`).toBeLessThan(2);
            if (e.phen === "Object continuously above the Horizon") expect(r.state, `${day} ${body}`).toBe("always-up");
            if (e.phen === "Object continuously below the Horizon") expect(r.state, `${day} ${body}`).toBe("never-up");
          }
          if (r.state === "normal") expect(r.rise !== null || r.set !== null).toBe(true);
          else expect([r.rise, r.set]).toEqual([null, null]);
        }
        // USNO's civil twilight (−6°) for the same calendar day.
        const civil = findCrossings((t) => skyPosition("sun", t, SITES[site]!).alt + 6, start, end);
        for (const e of ref.sun.filter((x) => x.phen.endsWith("Civil Twilight"))) {
          const c = civil.find((x) => x.rising === e.phen.startsWith("Begin"));
          expect(minutes(c?.ms ?? NaN, e.ms!), `${day} ${e.phen}`).toBeLessThan(2);
        }
      }
    });
  }

  it("gives planet rise/transit/set with a transit altitude", () => {
    const [start, end] = nightWindow("2026-11-01", "Asia/Jakarta");
    for (const p of SKY_PLANETS) {
      const r = riseTransitSet(p as SkyPlanet, SITES.jakarta!, start, end);
      expect(r.state).toBe("normal"); // near the equator everything rises and sets
      expect(r.transit).not.toBeNull();
      // Highest point: 90° − |lat − dec| at transit.
      const dec = skyPosition(p, r.transit!, SITES.jakarta!).dec;
      expect(r.transitAlt!).toBeCloseTo(90 - Math.abs(SITES.jakarta!.lat - dec), 1);
    }
  });
});

describe("root finder", () => {
  it("brackets and bisects sign changes, with direction", () => {
    const f = (t: number) => Math.sin((t / 1000) * 2 * Math.PI / 100); // roots every 50 s
    const c = findCrossings(f, 1000, 230_000, 7000, 1);
    expect(c.map((x) => Math.round(x.ms / 1000))).toEqual([50, 100, 150, 200]);
    expect(c.map((x) => x.rising)).toEqual([false, true, false, true]);
  });

  it("ignores wrap-around jumps of angles", () => {
    const angle = (t: number) => norm180(t / 1000); // −180..180, jumps at 180
    const c = findCrossings(angle, 10_000, 700_000, 7000, 1);
    expect(c.map((x) => Math.round(x.ms / 1000))).toEqual([360]);
  });

  it("returns nothing when there is no crossing", () => {
    expect(findCrossings(() => 1, 0, 1e6)).toEqual([]);
  });
});

describe("time zones and places", () => {
  it("reads offsets from Intl, including daylight saving time", () => {
    expect(timeZoneOffset(Date.UTC(2026, 10, 1), "Asia/Jakarta")).toBe(420);
    expect(timeZoneOffset(Date.UTC(2026, 6, 1), "Europe/Oslo")).toBe(120);
    expect(timeZoneOffset(Date.UTC(2026, 11, 1), "Europe/Oslo")).toBe(60);
    expect(timeZoneOffset(Date.UTC(2026, 11, 1), "America/New_York")).toBe(-300);
    expect(zonedTimeToUtc("2026-11-01", 12, 0, "Asia/Jakarta")).toBe(Date.UTC(2026, 10, 1, 5));
    expect(localDate(Date.UTC(2026, 10, 1, 18), "Asia/Jakarta")).toBe("2026-11-02");
  });

  it("builds a noon-to-noon window that spans a DST change", () => {
    const [a, b] = nightWindow("2026-10-24", "Europe/Oslo"); // clocks go back on 25 October
    expect(a).toBe(Date.UTC(2026, 9, 24, 10));
    expect(b - a).toBe(25 * 3_600_000);
  });

  it("validates and rounds observer coordinates to 0.01°", () => {
    expect(toObserver(-6.20456, 106.84567)).toEqual({ lat: -6.2, lon: 106.85 });
    expect(toObserver(10, 190)).toEqual({ lat: 10, lon: -170 });
    expect(toObserver(91, 0)).toBeNull();
    expect(toObserver(Number.NaN, 0)).toBeNull();
  });

  it("has valid preset places with real IANA zones (both hemispheres and a polar one)", () => {
    for (const p of PRESET_PLACES) expect(() => timeZoneOffset(0, p.timeZone), p.name).not.toThrow();
    expect(PRESET_PLACES.some((p) => p.name === "Jakarta")).toBe(true);
    expect(PRESET_PLACES.some((p) => p.lat > 66.56)).toBe(true);
    expect(PRESET_PLACES.some((p) => p.lat < 0)).toBe(true);
  });
});
