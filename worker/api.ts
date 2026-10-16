import type { ApiErrorBody, Envelope, Notice, StatusResponse } from "../shared/contract";
import { appEnv, nasaKey, type Env } from "./lib/env";
import { canonicalQuery } from "./lib/params";
import { SourceError, Upstream } from "./lib/upstream";
import { streamCatalog } from "./sources/exoplanets";
import { fetchCircular } from "./sources/gcn";
import { getSource, SOURCES } from "./sources/index";

/** Cache lifetimes (seconds) for the routes that aren't a SourceModule. */
export const MAX_AGE = {
  status: 300,
  /** Circulars are final once posted (rare corrections show up within hours). */
  circular: 6 * 3600,
} as const;

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * `public, max-age=N` lets Cloudflare's Worker cache (and the browser) reuse a response for N seconds;
 * anything else is `no-store`. Every /api response states this explicitly: without it, Workers Cache
 * applies heuristic lifetimes (2 h for a 200).
 */
export function cacheControl(maxAge: number, browserMaxAge = maxAge): string {
  if (maxAge <= 0) return "no-store";
  // A browser keeps a long-lived answer (APOD archive weeks) for less time than Cloudflare's cache, so a
  // deploy that fixes how entries are read reaches visitors within a day (the edge cache restarts per deploy).
  return browserMaxAge < maxAge
    ? `public, max-age=${Math.floor(browserMaxAge)}, s-maxage=${Math.floor(maxAge)}`
    : `public, max-age=${Math.floor(maxAge)}`;
}

export function json(body: unknown, status = 200, maxAge = 0, extra: Record<string, string> = {}, browserMaxAge = maxAge): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "cache-control": cacheControl(maxAge, browserMaxAge), ...extra } });
}

function errorResponse(source: string, err: unknown, upstream: Upstream): Response {
  const known = err instanceof SourceError ? err : null;
  // Log only the message (never env or full request) so secrets cannot leak into logs.
  console.warn(`[${source}] ${known ? known.kind : "internal"}: ${known ? known.message : String((err as Error)?.message ?? err)}`);
  const body: ApiErrorBody = {
    source,
    fetchedAt: new Date().toISOString(),
    error: known
      ? { kind: known.kind, message: known.message, ...(known.hint ? { hint: known.hint } : {}) }
      : { kind: "internal", message: "Unexpected error while preparing this panel's data." },
    upstream: upstream.calls,
  };
  return json(body, known?.status ?? 500);
}

/**
 * The path + query the API would act on, or null if no route matches. The front Worker forwards only
 * this canonical form, so the cache can't be bypassed with junk parameters or zero-padded IDs.
 */
export function canonicalApiPath(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/api/status" || path === "/api/exoplanets/catalog") return path;
  const circ = /^\/api\/gcn\/circulars\/(\d{1,7})$/.exec(path)?.[1];
  if (circ) return `/api/gcn/circulars/${Number(circ)}`;
  const id = /^\/api\/sources\/([a-z0-9-]+)$/.exec(path)?.[1];
  const source = id ? getSource(id) : undefined;
  if (!source) return null;
  return `/api/sources/${source.id}${canonicalQuery(source.params, url.searchParams)}`;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/status") {
    const body: StatusResponse = {
      env: appEnv(env),
      nasaKey: nasaKey(env).mode,
      sources: Object.values(SOURCES).map(({ id, title, provider, docsUrl }) => ({ id, title, provider, docsUrl })),
    };
    return json(body, 200, MAX_AGE.status);
  }

  if (path === "/api/exoplanets/catalog") {
    const upstream = new Upstream();
    try {
      return await streamCatalog(upstream);
    } catch (err) {
      return errorResponse("exoplanets/catalog", err, upstream);
    }
  }

  // One GCN Circular for the in-page reader (fetched only when the user opens it).
  const circ = /^\/api\/gcn\/circulars\/(\d{1,7})$/.exec(path)?.[1];
  if (circ) {
    const upstream = new Upstream();
    try {
      return json(await fetchCircular(upstream, Number(circ)), 200, MAX_AGE.circular);
    } catch (err) {
      return errorResponse("gcn/circular", err, upstream);
    }
  }

  const id = /^\/api\/sources\/([a-z0-9-]+)$/.exec(path)?.[1];
  const source = id ? getSource(id) : undefined;
  if (!source) return json({ error: "Not found" }, 404);

  const upstream = new Upstream();
  const notices: Notice[] = [];
  let cacheable = true;
  let maxAge = source.maxAge;
  try {
    const data = await source.load({
      env,
      upstream,
      params: url.searchParams,
      now: new Date(),
      notices,
      noCache: () => (cacheable = false),
      cacheFor: (seconds) => (maxAge = Math.min(maxAge, seconds)),
    });
    const body: Envelope<unknown> = { source: source.id, fetchedAt: new Date().toISOString(), data, upstream: upstream.calls, notices };
    // A partial failure (a failed upstream call, a warning) is served but not cached, so the next
    // request tries again instead of everyone seeing the degraded result for the full lifetime.
    const degraded = !cacheable || upstream.calls.some((c) => !c.ok) || notices.some((n) => n.level === "warning");
    return json(body, 200, degraded ? 0 : maxAge, {}, source.browserMaxAge ?? maxAge);
  } catch (err) {
    return errorResponse(source.id, err, upstream);
  }
}
