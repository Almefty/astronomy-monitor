import type { ApiErrorBody, Envelope, Notice, StatusResponse } from "../shared/contract";
import { appEnv, nasaKey, type Env } from "./lib/env";
import { SourceError, Upstream } from "./lib/upstream";
import { streamCatalog } from "./sources/exoplanets";
import { fetchCircular } from "./sources/gcn";
import { getSource, SOURCES } from "./sources/index";

const API_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: API_HEADERS });
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

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/status") {
    const body: StatusResponse = {
      env: appEnv(env),
      nasaKey: nasaKey(env).mode,
      sources: Object.values(SOURCES).map(({ id, title, provider, docsUrl }) => ({ id, title, provider, docsUrl })),
    };
    return json(body);
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
      return json(await fetchCircular(upstream, Number(circ)));
    } catch (err) {
      return errorResponse("gcn/circular", err, upstream);
    }
  }

  const id = /^\/api\/sources\/([a-z0-9-]+)$/.exec(path)?.[1];
  const source = id ? getSource(id) : undefined;
  if (!source) return json({ error: "Not found" }, 404);

  const upstream = new Upstream();
  const notices: Notice[] = [];
  try {
    const data = await source.load({ env, upstream, params: url.searchParams, now: new Date(), notices });
    const body: Envelope<unknown> = { source: source.id, fetchedAt: new Date().toISOString(), data, upstream: upstream.calls, notices };
    return json(body);
  } catch (err) {
    return errorResponse(source.id, err, upstream);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
