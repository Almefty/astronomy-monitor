import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "../shared/contract";
import { apodSource, apodToday, cleanExplanation, feedItemDate, fromBasic, isPlaceholderLegacy, parseFeed, sizedImage } from "../worker/sources/apod";
import { Upstream } from "../worker/lib/upstream";
import { diameterFromH, jdToIso, parseCad } from "../worker/sources/neo";
import { flareFlux, gScale, parseCmes, parseFlares, parseStorms } from "../worker/sources/solar";
import { redactUrl } from "../worker/lib/upstream";
import { htmlToText } from "../worker/lib/util";
import donki from "./fixtures/donki-2026-10-09.json";

describe("secrets", () => {
  it("redacts API keys from recorded URLs", () => {
    const out = redactUrl("https://api.nasa.gov/planetary/apod?api_key=abc123SECRET&date=2026-10-09");
    expect(out).not.toContain("abc123SECRET");
    expect(out).toContain("api_key=***");
  });
});

describe("JPL close approaches", () => {
  const cad = {
    count: 2,
    fields: ["des", "orbit_id", "jd", "cd", "dist", "dist_min", "dist_max", "v_rel", "v_inf", "t_sigma_f", "h", "diameter", "diameter_sigma", "fullname"],
    data: [
      ["2026 TB3", "2", "2461322.700346706", "2026-Oct-09 04:48", "0.00430879907752479", "0.00427813012904407", "0.00433946374935701", "11.0612830679976", "11.0052", "< 00:01", "28.516", null, null, "       (2026 TB3)"],
      ["99942", "220", "2462240.407091595", "2029-Apr-13 21:46", "0.000254099", "0.000254", "0.000254", "7.42", "5.84", "< 00:01", "19.09", "0.34", null, "  99942 Apophis (2004 MN4)"],
    ],
  };
  const rows = parseCad(cad, new Set(["99942"]));

  it("converts Julian dates and distances", () => {
    expect(jdToIso(2440587.5)).toBe("1970-01-01T00:00:00.000Z");
    expect(rows[0]!.time.startsWith("2026-10-09T04:48")).toBe(true);
    expect(rows[0]!.distLd).toBeCloseTo(1.677, 2);
    expect(rows[0]!.name).toBe("(2026 TB3)");
  });

  it("flags PHAs and keeps measured diameters", () => {
    expect(rows[1]!.pha).toBe(true);
    expect(rows[1]!.diameterKm).toBe(0.34);
    expect(rows[0]!.pha).toBe(false);
  });

  it("estimates size from absolute magnitude", () => {
    const d = diameterFromH(22);
    expect(d.min).toBeGreaterThan(0.09);
    expect(d.max).toBeLessThan(0.28);
    expect(d.min).toBeLessThan(d.max);
  });
});

describe("DONKI solar activity", () => {
  it("parses GOES flare classes into flux", () => {
    expect(flareFlux("M6.7")).toEqual({ letter: "M", flux: 6.7e-5 });
    expect(flareFlux("X1")!.flux).toBeCloseTo(1e-4);
    expect(flareFlux("nonsense")).toBeNull();
  });

  it("maps Kp to the NOAA G-scale", () => {
    expect([4.67, 5, 5.67, 6.33, 7, 8, 9].map(gScale)).toEqual([0, 1, 1, 2, 3, 4, 5]);
  });

  it("parses real flares", () => {
    const flares = parseFlares(donki.FLR as never);
    expect(flares).toHaveLength(10);
    const biggest = flares.reduce((a, b) => (b.flux > a.flux ? b : a));
    expect(biggest.classType).toBe("M6.7");
    expect(biggest.linkedIds).toContain("2026-10-08T16:53:00-CME-001");
  });

  it("uses the newest most-accurate CME analysis and classifies Earth impacts", () => {
    const cmes = parseCmes(donki.CME as never);
    const byId = new Map(cmes.map((c) => [c.id, c]));
    // Two analyses flagged most-accurate: the later one (lon 0, speed 573) wins.
    const direct = byId.get("2026-10-06T06:23:00-CME-001")!;
    expect(direct.lon).toBe(0);
    expect(direct.speed).toBe(573);
    expect(direct.earth).toMatchObject({ arrival: "2026-10-09T02:21:00.000Z", glancingBlow: false, kpMin: 4, kpMax: 7 });
    // isEarthMinorImpact counts as a glancing blow.
    expect(byId.get("2026-10-06T09:53:00-CME-001")!.earth?.glancingBlow).toBe(true);
    // Far-side CME: no Earth impact.
    expect(byId.get("2026-10-08T16:12:00-CME-001")!.earth).toBeNull();
  });

  it("parses geomagnetic storms", () => {
    const [storm] = parseStorms(donki.GST as never);
    expect(storm!.maxKp).toBeCloseTo(5.67);
    expect(storm!.gScale).toBe(1);
  });
});

describe("APOD", () => {
  it("detects the legacy API's placeholder records", () => {
    expect(
      isPlaceholderLegacy({
        date: "2026-10-08", title: "NASA Science", explanation: "", media_type: "image",
        url: "https://science.nasa.gov/wp-content/themes/nasa-child/assets/images/nasa-logo@2x.png",
      }),
    ).toBe(true);
  });

  it("cleans explanations", () => {
    const html = "<strong>Explanation:</strong> A <a href='x'>moon</a> &amp; a crater.<br><br><strong>Tomorrow&#8217;s picture: </strong>farside";
    expect(cleanExplanation(html)).toBe("A moon & a crater.");
    expect(htmlToText("Sm&ouml;rg&aring;sbord &#8211; ok")).toContain("–");
  });

  it("resizes NASA dynamic images only", () => {
    const u = "https://assets.science.nasa.gov/dynamicimage/assets/x.jpg?w=1836&h=1362&fit=clip";
    expect(sizedImage(u, "thumb")).toBe("https://assets.science.nasa.gov/dynamicimage/assets/x.jpg?w=480&h=320&fit=crop");
    expect(sizedImage("https://example.org/a.jpg?w=1", "thumb")).toBe("https://example.org/a.jpg?w=1");
  });

  it("handles video days (mp4 and YouTube) and placeholder posters", () => {
    const base = { date: "2026-04-22", title: "Earthset", permalink: "p", explanation: "", media_type: "video" };
    const yt = fromBasic({
      ...base,
      hdurl: "https://assets.science.nasa.gov/dynamicimage/assets/science/astro/programs/cosmic-origins/images/misc/news-thumbnail.png?w=594",
      basic_html: '<iframe src="//www.youtube.com/embed/MT8tg5b3b8E?rel=0"></iframe>',
    });
    expect(yt.videoKind).toBe("embed");
    expect(yt.videoUrl).toBe("https://www.youtube.com/embed/MT8tg5b3b8E?rel=0");
    expect(yt.imageUrl).toContain("img.youtube.com/vi/MT8tg5b3b8E");
    const mp4 = fromBasic({ ...base, hdurl: null, basic_html: '<video><source src="https://assets.science.nasa.gov/content/dam/a.mp4"></video>' });
    expect(mp4.videoKind).toBe("file");
    expect(mp4.imageUrl).toBeNull();
  });

  it("parses the official RSS feed (image and video items)", () => {
    const xml = `<rss><channel>
<item><title>Ice Fishing for Cosmic Neutrinos</title>
<link>https://science.nasa.gov/image-article/apod-2026-october-11-ice-fishing-for-cosmic-neutrinos/</link>
<pubDate>Sun, 11 Oct 2026 04:05:00 +0000</pubDate>
<apod:hdurl>https://assets.science.nasa.gov/dynamicimage/assets/x/deephole.jpg?w=0&#038;h=0&#038;fit=clip</apod:hdurl>
<apod:discussion>https://asterisk.apod.com/discuss_apod.php?date=261011</apod:discussion>
<apod:credit><![CDATA[<a href="https://www.nsf.gov/">NSF</a>, B. Gudbjartsson]]></apod:credit>
<apod:alt>A dark cable descends into a hole of ice.</apod:alt>
<apod:explanation><![CDATA[<strong>Explanation:</strong> Scientists are melting holes. <br><br><strong>Tomorrow's picture:</strong> x]]></apod:explanation>
<content:encoded><![CDATA[<p><img src="x.jpg"></p>]]></content:encoded></item>
<item><title>Comet NEOWISE Rising</title>
<link>https://science.nasa.gov/image-article/apod-2026-september-13-comet-neowise-rising/</link>
<pubDate>Sun, 13 Sep 2026 04:05:00 +0000</pubDate>
<apod:hdurl>https://assets.science.nasa.gov/dynamicimage/assets/x/Comet_snapshot.png?w=1080</apod:hdurl>
<content:encoded><![CDATA[<video controls><source src="https://assets.science.nasa.gov/content/dam/a.mp4"></video>]]></content:encoded></item>
</channel></rss>`;
    const [img, vid] = parseFeed(xml).map(fromBasic);
    expect(img).toMatchObject({ date: "2026-10-11", title: "Ice Fishing for Cosmic Neutrinos", mediaType: "image", credit: "NSF, B. Gudbjartsson" });
    expect(img!.explanation).toBe("Scientists are melting holes.");
    expect(img!.hdUrl).toBe("https://assets.science.nasa.gov/dynamicimage/assets/x/deephole.jpg?w=0&h=0&fit=clip");
    expect(vid).toMatchObject({ date: "2026-09-13", mediaType: "video", videoKind: "file" });
    // No discussion link: the date comes from the slug.
    expect(feedItemDate("<link>https://science.nasa.gov/image-article/apod-2026-september-3-x/</link>")).toBe("2026-09-03");
  });
});


describe("APOD source selection", () => {
  const jsonRow = (date: string) => ({ date, title: `JSON ${date}`, permalink: "p", media_type: "image", explanation: "x", hdurl: null, basic_html: "" });
  const feedXml = (date: string) => {
    const [y, m, d] = date.split("-");
    return `<rss><channel><item><title>Feed ${date}</title><link>https://science.nasa.gov/image-article/x/</link>
<apod:discussion>https://asterisk.apod.com/discuss_apod.php?date=${y!.slice(2)}${m}${d}</apod:discussion>
<content:encoded><![CDATA[<p>x</p>]]></content:encoded></item></channel></rss>`;
  };
  function stub(json: (() => Response) | null, feed: () => Response) {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/wp-json/")) return json ? json() : new Response("", { status: 500 });
      if (url.includes("/feed/apod-basic/")) return feed();
      return new Response("{}", { status: 503 });
    });
  }
  const run = (now: Date) => {
    const notices: Notice[] = [];
    return apodSource.load({ env: {} as never, upstream: new Upstream(), params: new URLSearchParams(), now, notices, noCache: () => {} }).then((data) => ({ data, notices }));
  };
  afterEach(() => vi.unstubAllGlobals());

  it("dates APOD by US Eastern time", () => {
    expect(apodToday(new Date("2026-10-11T03:00:00Z"))).toBe("2026-10-10"); // 23:00 EDT
    expect(apodToday(new Date("2026-10-11T06:00:00Z"))).toBe("2026-10-11");
  });

  it("prefers the RSS feed when the JSON API lags behind today's APOD", async () => {
    stub(() => Response.json([jsonRow("2026-10-10"), jsonRow("2026-10-09")]), () => new Response(feedXml("2026-10-11")));
    const { data, notices } = await run(new Date("2026-10-11T06:20:00Z"));
    expect(data.today.date).toBe("2026-10-11");
    expect(data.today.title).toBe("Feed 2026-10-11");
    expect(notices[0]!.text).toMatch(/newest entry is still 10 Oct, the feed already has 11 Oct/);
    expect(notices[0]!.text).not.toMatch(/unavailable/);
  });

  it("keeps the JSON API, silently, when it is current", async () => {
    stub(() => Response.json([jsonRow("2026-10-11")]), () => new Response(feedXml("2026-10-11")));
    const { data, notices } = await run(new Date("2026-10-11T06:20:00Z"));
    expect(data.today.title).toBe("JSON 2026-10-11");
    expect(notices).toHaveLength(0);
  });

  it("keeps the JSON API when neither source has today's entry yet", async () => {
    stub(() => Response.json([jsonRow("2026-10-10")]), () => new Response(feedXml("2026-10-10")));
    const { data, notices } = await run(new Date("2026-10-11T06:20:00Z"));
    expect(data.today.title).toBe("JSON 2026-10-10");
    expect(notices).toHaveLength(0);
  });

  it("names the real reason when the JSON API is blocked", async () => {
    stub(() => new Response("<!DOCTYPE html><title>Checking your browser...</title>", { status: 403 }), () => new Response(feedXml("2026-10-11")));
    const { data, notices } = await run(new Date("2026-10-11T06:20:00Z"));
    expect(data.today.title).toBe("Feed 2026-10-11");
    expect(notices[0]!.text).toBe("From NASA's APOD RSS feed: the science.nasa.gov JSON API answered HTTP 403 (a JavaScript browser check).");
  });
});
