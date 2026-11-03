import { describe, expect, it } from "vitest";
import { angularSeparation } from "../shared/astro";
import { moonPhase, nightEvents, riseTransitSet, skyPosition, SKY_PLANETS, timeZoneOffset, type Observer } from "../shared/sky";
import {
  computeTonight, dayLabel, formatLatLonInput, parseLatLon, solarOffsetHours, DARK_SUN_ALT, domeAngle, domePoint, fmtMag, formatCoords, GLARE_ELONGATION, hhmm, intersect, MIN_PLANET_ALT,
  moonLitBearing, nightSentences, parseLocation, passTimes, skyBearing, skyOffset, utcOffsetLabel,
} from "../src/viz/sky-model";

/*
 * The "Sky tonight" panel's model (src/viz/sky-model.ts). Positions themselves are checked against JPL
 * Horizons and USNO in test/sky.test.ts; these tests check what the panel derives from them (dark
 * intervals, visibility, best times, Moon orientation, dome geometry, formatting) by brute force.
 */

const SITES: Record<string, Observer> = {
  jakarta: { lat: -6.2, lon: 106.8 },
  tromso: { lat: 69.65, lon: 18.96 },
  capetown: { lat: -33.92, lon: 18.42 },
  london: { lat: 51.51, lon: -0.13 },
};
const MIN = 60_000;
const NOON_UTC = (d: string) => Date.parse(`${d}T12:00:00Z`);

describe("intervals", () => {
  it("intersects sorted interval lists", () => {
    expect(intersect([[0, 10], [20, 30]], [[5, 25]])).toEqual([[5, 10], [20, 25]]);
    expect(intersect([[0, 10]], [[10, 20]])).toEqual([]);
    expect(intersect([], [[0, 1]])).toEqual([]);
    expect(intersect([[0, 100]], [[10, 20], [30, 40]])).toEqual([[10, 20], [30, 40]]);
  });
});

describe("tonight", () => {
  const cases: [string, string][] = [
    ["jakarta", "2026-11-01"], ["capetown", "2026-11-01"], ["london", "2026-12-21"], ["tromso", "2026-12-21"], ["london", "2027-06-21"], ["jakarta", "2027-06-21"],
  ];

  it.each(cases)("dark intervals and the slider range follow the Sun (%s, %s)", (site, date) => {
    const obs = SITES[site]!;
    const t = computeTonight(obs, NOON_UTC(date));
    const sunAlt = (ms: number) => skyPosition("sun", ms, obs).alt;
    for (const [a, b] of t.dark) {
      for (let x = a + 30_000; x < b; x += 10 * MIN) expect(sunAlt(x)).toBeLessThan(DARK_SUN_ALT + 0.01);
      if (a > t.start) expect(sunAlt(a)).toBeCloseTo(DARK_SUN_ALT, 2);
      if (b < t.end) expect(sunAlt(b)).toBeCloseTo(DARK_SUN_ALT, 2);
    }
    // Full darkness lies inside the dark intervals.
    for (const iv of t.fullDark) expect(intersect([iv], t.dark)).toEqual([iv]);
    const ev = nightEvents(obs, t.date);
    expect(t.range).toEqual([ev.sunset.state === "time" ? ev.sunset.ms : t.start, ev.sunrise.state === "time" ? ev.sunrise.ms : t.end]);
  });

  it.each(cases)("planet visibility, best time and reasons are consistent (%s, %s)", (site, date) => {
    const obs = SITES[site]!;
    const t = computeTonight(obs, NOON_UTC(date));
    expect(t.planets.map((p) => p.id)).toEqual([...SKY_PLANETS]);
    for (const p of t.planets) {
      const alt = (ms: number) => skyPosition(p.id, ms, obs).alt;
      // Brute force: 2-minute scan of "above 5° while the Sun is below −6°".
      let maxAlt = -90, anyVisible = false;
      for (let x = t.start; x <= t.end; x += 2 * MIN) {
        if (skyPosition("sun", x, obs).alt >= DARK_SUN_ALT) continue;
        const a = alt(x);
        if (a >= MIN_PLANET_ALT) {
          anyVisible = true;
          maxAlt = Math.max(maxAlt, a);
          expect(p.visible.some(([s, e]) => x >= s - 1000 && x <= e + 1000), `${p.id} at ${new Date(x).toISOString()}`).toBe(true);
        }
      }
      if (p.status === "glare") {
        expect(p.elongation).toBeLessThan(GLARE_ELONGATION);
        continue;
      }
      expect(p.status === "visible").toBe(anyVisible && t.dark.length > 0);
      if (p.status === "visible") {
        expect(p.best).not.toBeNull();
        // The refined best is at least as high as any scanned visible moment (to 0.01°).
        expect(p.best!.alt).toBeGreaterThanOrEqual(maxAlt - 0.01);
        expect(p.visible.some(([s, e]) => p.best!.ms >= s && p.best!.ms <= e)).toBe(true);
        expect(p.reason).toBe("");
      } else {
        expect(p.best).toBeNull();
        expect(p.reason.length).toBeGreaterThan(0);
      }
      // Rise/set from the panel's own samples agree with shared/sky.ts's riseTransitSet.
      const rts = riseTransitSet(p.id, obs, t.start, t.end);
      expect(p.rs.state).toBe(rts.state);
      if (rts.rise !== null) expect(Math.abs(p.rs.rise! - rts.rise) / MIN).toBeLessThan(0.1);
      if (rts.set !== null) expect(Math.abs(p.rs.set! - rts.set) / MIN).toBeLessThan(0.1);
    }
  });

  it("the best time of a planet that culminates in the dark is its transit", () => {
    // Jakarta, 1 Nov 2026: Saturn culminates at 83° in the evening (≈ 21:47 local).
    const obs = SITES.jakarta!;
    const t = computeTonight(obs, NOON_UTC("2026-11-01"));
    const saturn = t.planets.find((p) => p.id === "saturn")!;
    const rts = riseTransitSet("saturn", obs, t.start, t.end);
    expect(saturn.status).toBe("visible");
    expect(Math.abs(saturn.best!.ms - rts.transit!) / MIN).toBeLessThan(1);
    expect(saturn.best!.alt).toBeCloseTo(rts.transitAlt!, 1);
    // Mercury is 7° from the Sun that night.
    expect(t.planets.find((p) => p.id === "mercury")!.status).toBe("glare");
  });

  it("polar day: no dark sky, every planet says why", () => {
    const t = computeTonight(SITES.tromso!, NOON_UTC("2027-06-21"));
    expect(t.dark).toEqual([]);
    expect(t.events.sunset.state).toBe("always-above");
    expect(t.range).toEqual([t.start, t.end]);
    for (const p of t.planets) expect(["no-dark", "glare"]).toContain(p.status);
    expect(nightSentences(t.events)[0]).toMatch(/polar day/);
  });

  it("polar night: dark around midnight, twilight at noon, and plain sentences", () => {
    const t = computeTonight(SITES.tromso!, NOON_UTC("2026-12-21"));
    expect(t.events.sunrise.state).toBe("always-below");
    expect(t.dark.length).toBeGreaterThan(0);
    expect(t.moon.rs.state).toBe("always-up");
    expect(nightSentences(t.events)).toEqual(["The Sun doesn’t rise today: it is polar night here.", "Twilight brightens the sky around midday."]);
  });

  it("names nights without full darkness (London, midsummer) and stays quiet on ordinary nights", () => {
    expect(nightSentences(computeTonight(SITES.london!, NOON_UTC("2027-06-21")).events)[0]).toMatch(/never gets fully dark/);
    expect(nightSentences(computeTonight(SITES.jakarta!, NOON_UTC("2026-11-01")).events)).toEqual([]);
  });

  it("the Moon is up exactly between its rise and set", () => {
    const obs = SITES.capetown!;
    const t = computeTonight(obs, NOON_UTC("2026-11-01"));
    const rts = riseTransitSet("moon", obs, t.start, t.end);
    expect(t.moon.rs.state).toBe(rts.state);
    if (rts.rise !== null) expect(Math.abs(t.moon.rs.rise! - rts.rise) / MIN).toBeLessThan(0.1);
    if (rts.set !== null) expect(Math.abs(t.moon.rs.set! - rts.set) / MIN).toBeLessThan(0.1);
    expect(t.moon.phase.illuminated).toBeCloseTo(moonPhase(NOON_UTC("2026-11-01"), obs).illuminated, 6);
  });

  it("computes a night fast enough for a phone (warm, Node)", () => {
    computeTonight(SITES.london!, NOON_UTC("2026-11-02"));
    const t0 = performance.now();
    for (const obs of Object.values(SITES)) computeTonight(obs, NOON_UTC("2026-11-03"));
    expect((performance.now() - t0) / 4).toBeLessThan(60); // ≈ 16 ms measured
  });
});

describe("sky geometry", () => {
  it("bearing: up is 0°, towards increasing azimuth is 90°", () => {
    expect(skyBearing({ alt: 0, az: 180 }, { alt: 0, az: 270 })).toBeCloseTo(90, 6);
    expect(skyBearing({ alt: 0, az: 180 }, { alt: 0, az: 90 })).toBeCloseTo(270, 6);
    expect(skyBearing({ alt: 10, az: 40 }, { alt: 30, az: 40 })).toBeCloseTo(0, 6);
    expect(skyBearing({ alt: 30, az: 40 }, { alt: 10, az: 40 })).toBeCloseTo(180, 6);
  });

  it("an offset along a bearing lands on the target (great circles), also below the horizon", () => {
    for (const [from, to] of [[{ alt: 25, az: 250 }, { alt: -12, az: 230 }], [{ alt: 70, az: 10 }, { alt: 5, az: 200 }], [{ alt: -3, az: 100 }, { alt: 40, az: 120 }]] as const) {
      const d = angularSeparation(from.az, from.alt, to.az, to.alt);
      const q = skyOffset(from, skyBearing(from, to), d);
      expect(angularSeparation(q.az, q.alt, to.az, to.alt)).toBeLessThan(1e-6);
    }
  });

  it("the Moon's lit side points to the Sun", () => {
    // Waxing crescent at dusk (Jakarta, 2026-11-12 ≈ 2 days after new moon): the Sun has just set, so the
    // lit limb points down towards the horizon.
    const obs = SITES.jakarta!;
    const ms = Date.parse("2026-11-12T11:30:00Z");
    const moon = skyPosition("moon", ms, obs), sun = skyPosition("sun", ms, obs);
    expect(moon.alt).toBeGreaterThan(0);
    expect(sun.alt).toBeLessThan(0);
    const b = moonLitBearing(obs, ms);
    expect(Math.abs(((b - 180 + 540) % 360) - 180)).toBeLessThan(90);
    const q = skyOffset(moon, b, angularSeparation(moon.az, moon.alt, sun.az, sun.alt));
    expect(angularSeparation(q.az, q.alt, sun.az, sun.alt)).toBeLessThan(1e-6);
  });

  it("dome: zenith in the centre, north up, east LEFT, horizon on the circle", () => {
    const [cx, cy, r] = [100, 100, 80];
    expect(domePoint({ alt: 90, az: 0 }, cx, cy, r)).toEqual([100, 100]);
    const close = (p: [number, number], q: [number, number]) => expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-9);
    close(domePoint({ alt: 0, az: 0 }, cx, cy, r), [100, 20]);
    close(domePoint({ alt: 0, az: 90 }, cx, cy, r), [20, 100]);
    close(domePoint({ alt: 0, az: 180 }, cx, cy, r), [100, 180]);
    close(domePoint({ alt: 0, az: 270 }, cx, cy, r), [180, 100]);
    close(domePoint({ alt: 45, az: 90 }, cx, cy, r), [60, 100]);
    // On the dome, "up" (towards the zenith) at a point due south points to the centre, i.e. screen-up.
    expect(domeAngle({ alt: 20, az: 180 }, 0, cx, cy, r)).toBeCloseTo(0, 3);
    // Due east, the direction of increasing azimuth (towards the south) points down the screen (the
    // 0.5° step domeAngle measures along bends ~0.2° in the projection: invisible on a glyph).
    expect(Math.abs(domeAngle({ alt: 20, az: 90 }, 90, cx, cy, r) - 180)).toBeLessThan(1);
  });
});

describe("location and formatting", () => {
  it("accepts only valid stored locations and rounds them to 0.01°", () => {
    expect(parseLocation({ kind: "preset", name: "Jakarta", lat: -6.2, lon: 106.8, timeZone: "Asia/Jakarta" })).toEqual({ kind: "preset", name: "Jakarta", lat: -6.2, lon: 106.8, timeZone: "Asia/Jakarta" });
    expect(parseLocation({ kind: "manual", name: "x", lat: 12.3456, lon: 190.004, timeZone: "Not/AZone" })).toEqual({ kind: "manual", name: null, lat: 12.35, lon: -170, timeZone: null });
    for (const bad of [null, "x", { kind: "other", lat: 0, lon: 0 }, { kind: "device", lat: 95, lon: 0 }, { kind: "device", lat: "1", lon: 2 }]) expect(parseLocation(bad)).toBeNull();
  });

  it("reads one coordinate field: Google Maps style and hemisphere letters", () => {
    const ok = (lat: number, lon: number) => ({ ok: true, lat, lon });
    expect(parseLatLon("-33.87, 151.21")).toEqual(ok(-33.87, 151.21)); // copied from Google Maps
    expect(parseLatLon("-33.8688,151.2093")).toEqual(ok(-33.8688, 151.2093));
    expect(parseLatLon("-33.87 151.21")).toEqual(ok(-33.87, 151.21));
    expect(parseLatLon("33.87 S, 151.21 E")).toEqual(ok(-33.87, 151.21));
    expect(parseLatLon("33.87°S 151.21°E")).toEqual(ok(-33.87, 151.21));
    expect(parseLatLon("33.87° s, 151.21° e")).toEqual(ok(-33.87, 151.21));
    expect(parseLatLon("S 33.87, E 151.21")).toEqual(ok(-33.87, 151.21));
    expect(parseLatLon("40.71 N, 74.01 W")).toEqual(ok(40.71, -74.01));
    expect(parseLatLon("151.21 E, 33.87 S")).toEqual(ok(-33.87, 151.21)); // letters say which is which
    expect(parseLatLon("6,2; 106,8")).toEqual(ok(6.2, 106.8)); // decimal commas
    expect(parseLatLon("−6.2, 106.8")).toEqual(ok(-6.2, 106.8)); // Unicode minus
    expect(parseLatLon("  69.65 , 18.96  ")).toEqual(ok(69.65, 18.96));
  });

  it("keeps the sign rule: a typed sign wins, else the letter, else north and east", () => {
    // Sign and letter disagree: the sign wins ("-33.87 N" was a sign × select bug before).
    expect(parseLatLon("-33.87 N, 151.21 E")).toEqual({ ok: true, lat: -33.87, lon: 151.21 });
    expect(parseLatLon("+33.87 S, -151.21 E")).toEqual({ ok: true, lat: 33.87, lon: -151.21 });
    // No sign: the letter decides.
    expect(parseLatLon("33.87 S, 151.21 W")).toEqual({ ok: true, lat: -33.87, lon: -151.21 });
    // Neither: north and east (the old selects' default).
    expect(parseLatLon("33.87, 151.21")).toEqual({ ok: true, lat: 33.87, lon: 151.21 });
  });

  it("rejects what it can't read, with a message", () => {
    for (const bad of ["", "abc", "-33.87", "1, 2, 3", "33,151", "12.3.4, 5", "33.87 S, 151.21 N", "N 33 E", "33 S 151 E 2", "S 33.87 151.21 E", "33.87 X, 151"]) {
      const r = parseLatLon(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
    expect(parseLatLon("91, 10")).toEqual({ ok: false, error: "Latitude must be between 90° S and 90° N." });
    expect(parseLatLon("-90.5, 10")).toEqual({ ok: false, error: "Latitude must be between 90° S and 90° N." });
    expect(parseLatLon("10, 181 W")).toEqual({ ok: false, error: "Longitude must be between 180° W and 180° E." });
    expect(parseLatLon("90 N, 180 W")).toEqual({ ok: true, lat: 90, lon: -180 });
    expect(parseLatLon("33.87 E, 151.21 E").ok).toBe(false);
  });

  it("prefills the field Google Maps style", () => {
    expect(formatLatLonInput(-33.87, 151.21)).toBe("-33.87, 151.21");
    expect(parseLatLon(formatLatLonInput(-6.2, 106.8))).toEqual({ ok: true, lat: -6.2, lon: 106.8 });
  });

  it("wraps the solar-time offset into [−12, 12) h, so places across the date line get no false warning", () => {
    const off = (lon: number, tz: string) => solarOffsetHours(lon, timeZoneOffset(Date.parse("2026-11-01T12:00:00Z"), tz));
    expect(Math.abs(off(-175.2, "Pacific/Tongatapu"))).toBeLessThan(1); // UTC+13
    expect(Math.abs(off(-171.76, "Pacific/Apia"))).toBeLessThan(1.5); // Samoa, UTC+13
    expect(Math.abs(off(-157.36, "Pacific/Kiritimati"))).toBeLessThan(1); // Kiribati, UTC+14
    expect(Math.abs(off(106.8, "Asia/Jakarta"))).toBeLessThan(1);
    expect(off(170.5, "UTC")).toBeCloseTo(170.5 / 15, 6); // 11.37 h is inside the range: unchanged (and warned about)
    expect(Math.abs(off(87.6, "Asia/Shanghai"))).toBeGreaterThan(2); // Ürümqi on Beijing time: a real gap
    for (const d of [-25, -12, -0.5, 0, 11.99, 12, 36]) {
      const w = solarOffsetHours(d * 15, 0);
      expect(w).toBeGreaterThanOrEqual(-12);
      expect(w).toBeLessThan(12);
      expect((((w - d) % 24) + 24) % 24).toBeCloseTo(0, 9);
    }
  });

  it("formats coordinates, offsets, magnitudes and times", () => {
    expect(formatCoords(-6.2, 106.8)).toBe("6.20° S, 106.80° E");
    expect(formatCoords(51.51, -0.13)).toBe("51.51° N, 0.13° W");
    const ms = Date.parse("2026-11-01T12:00:00Z");
    expect(utcOffsetLabel(ms, "Asia/Jakarta")).toBe("UTC+7");
    expect(utcOffsetLabel(ms, "UTC")).toBe("UTC");
    expect(utcOffsetLabel(ms, "America/St_Johns")).toBe("UTC−3:30");
    expect(fmtMag(-3.14)).toBe("−3.1");
    expect(fmtMag(0.04)).toBe("0.0");
    expect(fmtMag(5.66)).toBe("5.7");
    expect(hhmm(ms, "Asia/Jakarta")).toBe("19:00");
    expect(dayLabel(ms, "Pacific/Auckland")).toBe("Mon 2 Nov");
    const pt = (a: number, b: number) => ({ start: { ms: a, alt: 10, az: 0, cause: "horizon" as const }, end: { ms: b, alt: 10, az: 0, cause: "horizon" as const } });
    expect(passTimes(pt(ms, ms + 6 * MIN), "UTC")).toBe("12:00–12:06");
    expect(passTimes(pt(ms, ms + 40_000), "UTC")).toBe("12:00 · 40 s");
  });
});
