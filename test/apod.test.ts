import { afterEach, describe, expect, it, vi } from "vitest";
import { addDaysIso, APOD_FIRST, isIsoDate, nearestDays, randomDay, weekStartOf } from "../shared/apod";
import type { ApodWeekData, Envelope } from "../shared/contract";
import { canonicalApiPath, handleApi } from "../worker/api";
import type { Env } from "../worker/lib/env";
import { absUrl, ARCHIVE_MAX_AGE, apodSource, creditText, fromBasic } from "../worker/sources/apod";
// Real science.nasa.gov apod-basic rows (16 Oct 2026), basic_html trimmed to the page body before the explanation.
import samples from "./fixtures/apod-archive-2026-10-16.json";

type Row = Parameters<typeof fromBasic>[0];
const rows = samples as unknown as Record<string, Row[]>;
const row = (date: string) => Object.values(rows).flat().find((r) => r.date === date)!;

const env = { APP_ENV: "production" } as Env;
const get = (path: string) => handleApi(new Request(`https://example.test${path}`), env);
const canon = (path: string) => canonicalApiPath(new URL(`https://example.test${path}`));

describe("APOD calendar helpers", () => {
  it("validates dates and finds the Monday of a week", () => {
    expect(isIsoDate("2000-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-1-5")).toBe(false);
    expect(weekStartOf("1995-06-16")).toBe("1995-06-12"); // a Friday
    expect(weekStartOf("2026-10-12")).toBe("2026-10-12"); // a Monday
    expect(weekStartOf("2026-10-18")).toBe("2026-10-12"); // a Sunday
    expect(addDaysIso("2000-02-28", 2)).toBe("2000-03-01");
  });

  it("picks random days only inside the archive", () => {
    expect(randomDay("2026-10-16", () => 0)).toBe(APOD_FIRST);
    expect(randomDay("2026-10-16", () => 0.999999999)).toBe("2026-10-16");
    for (let i = 0; i < 200; i++) {
      const d = randomDay("2026-10-16");
      expect(isIsoDate(d) && d >= APOD_FIRST && d <= "2026-10-16").toBe(true);
    }
  });

  it("offers the nearest published days around a missing one", () => {
    const week = (dates: string[], before: string | null = null, after: string | null = null): ApodWeekData => ({
      weekStart: "2000-06-26",
      weekEnd: "2000-07-02",
      entries: dates.map((date) => ({ date }) as never),
      before,
      after,
    });
    // 30 Jun 2000 has no entry (verified on science.nasa.gov)
    expect(nearestDays("2000-06-30", week(["2000-07-02", "2000-07-01", "2000-06-29", "2000-06-28"]))).toEqual({ before: "2000-06-29", after: "2000-07-01" });
    expect(nearestDays("1995-06-18", week(["1995-06-16"]))).toEqual({ before: "1995-06-16", after: null });
    expect(nearestDays("2001-01-03", week([], "2000-12-20", "2001-01-10"))).toEqual({ before: "2000-12-20", after: "2001-01-10" });
  });
});

describe("APOD archive entries (real rows)", () => {
  it("finds the picture in the page body when hdurl is NASA's placeholder (1995)", () => {
    const e = fromBasic(row("1995-06-16"));
    expect(e.title).toBe("Neutron Star Earth");
    expect(e.mediaType).toBe("image");
    expect(e.imageUrl).toMatch(/^https:\/\/assets\.science\.nasa\.gov\/content\/dam\/.+\/1995\/june\/.+\.gif$/);
    expect(e.thumbUrl).toBe(e.imageUrl);
    expect(e.hdUrl).toMatch(/\.gif$/);
    expect(e.alt).toBe(""); // the generic "See Explanation. Clicking on the picture…" is dropped
  });

  it("resizes archive JPEGs through NASA's image service (GIFs stay as they are)", () => {
    const e = fromBasic(row("2009-04-04"));
    expect(e.thumbUrl).toBe("https://assets.science.nasa.gov/dynamicimage/assets/science/cds/apod/apod/2009/april/iya0908a_tafreshi.jpg?w=480&h=320&fit=crop");
    expect(e.imageUrl).toMatch(/^https:\/\/assets\.science\.nasa\.gov\/dynamicimage\/assets\/.+\?w=1600&fit=clip$/);
    expect(e.hdUrl).toMatch(/^https:\/\/assets\.science\.nasa\.gov\/content\/dam\//); // the original file
    expect(fromBasic(row("1995-06-16")).thumbUrl).toMatch(/\/content\/dam\/.+\.gif$/);
  });

  it("strips the title that 1997 entries put before the credit label", () => {
    expect(fromBasic(row("1997-03-05")).credit).toMatch(/^H\. Yang \(UIUC\)/);
    expect(fromBasic(row("1997-03-03")).credit).toMatch(/^Donald Davis/);
    expect(creditText("<b> Credit &amp; Copyright </b> <a href='x'>Global Television</a> Edmonton")).toBe("Global Television Edmonton");
  });

  it("keeps broken entries usable (no media, page title as title)", () => {
    const e = fromBasic(row("1997-03-04"));
    expect(e.title).toBe("Solar Wind And Milky Way");
    expect(e.mediaType).toBe("other");
    expect(e.imageUrl).toBeNull();
    expect(e.permalink).toMatch(/^https:\/\/science\.nasa\.gov\//);
  });

  it("embeds YouTube videos and links Flash players instead of embedding them", () => {
    const yt = fromBasic(row("2008-11-25"));
    expect(yt).toMatchObject({ mediaType: "video", videoKind: "embed", hdUrl: null });
    expect(yt.videoUrl).toMatch(/^https:\/\/www\.youtube\.com\/embed\/e_2aX-784sw/);
    expect(yt.imageUrl).toMatch(/img\.youtube\.com\/vi\/e_2aX-784sw/);
    expect(yt.credit).toMatch(/^Global Television Edmonton/);

    const flash = fromBasic(row("2009-04-05")); // media_type "iframe": a Flash player on apod.nasa.gov
    expect(flash).toMatchObject({ mediaType: "video", videoKind: "external" });
    expect(flash.videoUrl).toBe("https://apod.nasa.gov/image/0705/flvplayer.swf");
    expect(flash.explanation).not.toMatch(/digg_/);
  });

  it("treats old movie links by format: playable files vs. links", () => {
    const html = (href: string) => `<body><center>1996 January 10<br><a href="${href}"><IMG SRC="poster.gif"></a></center>`;
    const base = { date: "1996-01-10", title: "T", permalink: "p", media_type: "image", explanation: "" };
    const mpg = fromBasic({ ...base, basic_html: html("http://www.stsci.edu/pubinfo/mpeg/M100b.mpg") });
    expect(mpg).toMatchObject({ mediaType: "video", videoKind: "external", videoUrl: "http://www.stsci.edu/pubinfo/mpeg/M100b.mpg" });
    expect(mpg.imageUrl).toBe("https://apod.nasa.gov/apod/poster.gif"); // relative → classic site, https
    expect(fromBasic({ ...base, basic_html: html("https://apod.nasa.gov/x/movie.mp4") }).videoKind).toBe("file");
    expect(fromBasic({ ...base, basic_html: html("image/big.jpg") }).hdUrl).toBe("https://apod.nasa.gov/apod/image/big.jpg");
  });

  it("only accepts http(s) URLs and upgrades NASA hosts to https", () => {
    expect(absUrl("http://apod.nasa.gov/image/x.jpg")).toBe("https://apod.nasa.gov/image/x.jpg");
    expect(absUrl("//www.youtube.com/embed/abc")).toBe("https://www.youtube.com/embed/abc");
    expect(absUrl("javascript:alert(1)")).toBeNull();
    expect(absUrl("http://example.org/a.mpg")).toBe("http://example.org/a.mpg");
  });
});

describe("APOD archive endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("canonicalizes any date to its week, clamped to the archive", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
    expect(canon("/api/sources/apod-archive?week=1998-03-05&x=1")).toBe("/api/sources/apod-archive?week=1998-03-02");
    expect(canon("/api/sources/apod-archive?week=1998-03-08")).toBe("/api/sources/apod-archive?week=1998-03-02");
    expect(canon("/api/sources/apod-archive?week=1980-01-01")).toBe("/api/sources/apod-archive?week=1995-06-12");
    expect(canon("/api/sources/apod-archive?week=2031-01-01")).toBe("/api/sources/apod-archive?week=2026-10-12");
    expect(canon("/api/sources/apod-archive?week=nope")).toBe("/api/sources/apod-archive?week=2026-10-12");
    expect(canon("/api/sources/apod-archive")).toBe("/api/sources/apod-archive?week=2026-10-12");
  });

  function stubWeeks() {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push(url.search);
      const from = url.searchParams.get("date_from");
      const to = url.searchParams.get("date_to");
      if (url.searchParams.get("_fields") === "date") {
        // neighbour lookups for an empty week
        return Response.json(from ? [{ date: "2001-01-12" }, { date: "2001-01-11" }] : [{ date: "2000-12-31" }]);
      }
      if (from === "000626") return Response.json(rows["2000-06-26"]);
      if (from === "261012") return Response.json(rows["2026-10-12"]);
      return Response.json([]);
    });
    return calls;
  }

  it("serves a past week with a long cache lifetime and neighbours only when empty", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
    const calls = stubWeeks();
    const res = await get("/api/sources/apod-archive?week=2000-06-30");
    expect(res.headers.get("cache-control")).toBe(`public, max-age=86400, s-maxage=${ARCHIVE_MAX_AGE}`);
    const body = (await res.json()) as Envelope<ApodWeekData>;
    expect(body.data.weekStart).toBe("2000-06-26");
    expect(body.data.entries.map((e) => e.date)).toEqual(["2000-07-02", "2000-07-01", "2000-06-29", "2000-06-28"]);
    expect(body.data.before).toBeNull();
    expect(calls).toHaveLength(1);

    calls.length = 0;
    const empty = (await (await get("/api/sources/apod-archive?week=2001-01-03")).json()) as Envelope<ApodWeekData>;
    expect(empty.data).toMatchObject({ weekStart: "2001-01-01", entries: [], before: "2000-12-31", after: "2001-01-11" });
    expect(calls).toHaveLength(3);
  });

  it("caches the current week only as long as today's picture", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
    stubWeeks();
    const res = await get("/api/sources/apod-archive?week=2026-10-14");
    expect(res.headers.get("cache-control")).toBe(`public, max-age=${apodSource.maxAge}`);
  });

  it("never caches a failed week", async () => {
    vi.stubGlobal("fetch", async () => new Response("<!DOCTYPE html><title>Checking your browser...</title>", { status: 403 }));
    const res = await get("/api/sources/apod-archive?week=1999-01-01");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
