import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalApiPath, handleApi } from "../worker/api";
import type { Env } from "../worker/lib/env";
import { allowRequest, clientKey } from "../worker/lib/ratelimit";
import { creditText } from "../worker/sources/apod";
import { SOURCES } from "../worker/sources/index";
import flaresLatest from "./fixtures/goes-flares-latest.json";
import xrays from "./fixtures/goes-xrays-sample.json";

const env = { APP_ENV: "production" } as Env;
const get = (path: string) => handleApi(new Request(`https://example.test${path}`), env);
const canon = (path: string) => canonicalApiPath(new URL(`https://example.test${path}`));

describe("cache key canonicalization", () => {
  it("drops unknown parameters and normalizes values", () => {
    expect(canon("/api/sources/gcn?days=007&utm=x")).toBe("/api/sources/gcn?days=7");
    expect(canon("/api/sources/gcn?days=999")).toBe("/api/sources/gcn?days=30");
    expect(canon("/api/sources/gcn")).toBe("/api/sources/gcn?days=7");
    expect(canon("/api/sources/neo?ahead=60&past=7")).toBe(canon("/api/sources/neo?past=7&ahead=60"));
    expect(canon("/api/sources/goes?hours=6")).toBe("/api/sources/goes?hours=6");
    expect(canon("/api/sources/goes?hours=12")).toBe("/api/sources/goes?hours=24");
    expect(canon("/api/sources/telescopes?telescope=JWST")).toBe("/api/sources/telescopes?telescope=JWST");
    expect(canon("/api/sources/telescopes?telescope=nope")).toBe("/api/sources/telescopes");
    expect(canon("/api/sources/apod?date=2020-01-01")).toBe("/api/sources/apod");
  });

  it("normalizes fixed routes and rejects unknown ones", () => {
    expect(canon("/api/status/?x=1")).toBe("/api/status");
    expect(canon("/api/gcn/circulars/0041000")).toBe("/api/gcn/circulars/41000");
    expect(canon("/api/exoplanets/catalog?fresh=1")).toBe("/api/exoplanets/catalog");
    expect(canon("/api/sources/nope")).toBeNull();
    expect(canon("/api/elsewhere")).toBeNull();
  });
});

describe("cache lifetimes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps live feeds within their live-mode interval", () => {
    // Live mode: GOES every minute, GCN every 10 min, DONKI every 15 min (src/panels/*.ts).
    expect(SOURCES.goes.maxAge).toBeLessThanOrEqual(60);
    expect(SOURCES.gcn.maxAge).toBeLessThanOrEqual(600);
    expect(SOURCES.solar.maxAge).toBeLessThanOrEqual(900);
    for (const s of Object.values(SOURCES)) expect(s.maxAge).toBeGreaterThan(0);
  });

  it("caches a successful response for the source's lifetime", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return Response.json(url.includes("xrays-") ? xrays : flaresLatest);
    });
    const res = await get("/api/sources/goes?hours=6");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect((await get("/api/status")).headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("never caches errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const res = await get("/api/sources/goes");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await get("/api/sources/nope")).headers.get("cache-control")).toBe("no-store");
    expect((await handleApi(new Request("https://example.test/api/status", { method: "POST" }), env)).headers.get("cache-control")).toBe("no-store");
  });

  it("doesn't cache a partial failure", async () => {
    // The flux loads, the flare lists fail: served (with what loaded) but not cached.
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes("xrays-") ? Response.json(xrays) : new Response("nope", { status: 500 });
    });
    const res = await get("/api/sources/goes?hours=6");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("rate limiting", () => {
  it("counts IPv4 per address and IPv6 per /64", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:0db8:abcd:0012::99")).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::ffff:198.51.100.7")).toBe("::ffff:198.51.100.7");
    expect(clientKey(null)).toBe("unknown");
  });

  it("fails open without a working binding", async () => {
    expect(await allowRequest(undefined, "203.0.113.9")).toBe(true);
    expect(await allowRequest({ limit: async () => Promise.reject(new Error("boom")) }, "203.0.113.9")).toBe(true);
    expect(await allowRequest({ limit: async () => ({ success: false }) }, "203.0.113.9")).toBe(false);
  });
});

describe("APOD credits", () => {
  it("drops a repeated label and keeps the names", () => {
    expect(creditText('<strong>Image Credit:</strong> <a href="http://www.nasa.gov/">NASA</a>, JPL-Caltech')).toBe("NASA, JPL-Caltech");
    expect(creditText("Image Credit &amp; Copyright: Petr Horálek")).toBe("Petr Horálek");
    expect(creditText('<a href="https://x.test">Julien Looten</a>')).toBe("Julien Looten");
    expect(creditText(undefined)).toBe("");
  });
});
