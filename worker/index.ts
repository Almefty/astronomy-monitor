import { WorkerEntrypoint } from "cloudflare:workers";
import type { ApiErrorBody } from "../shared/contract";
import { canonicalApiPath, handleApi, json } from "./api";
import type { Env } from "./lib/env";
import { allowRequest, RATE_LIMIT } from "./lib/ratelimit";

/**
 * The API behind Workers Cache (`exports.Api.cache` in wrangler.jsonc). A cache hit is answered
 * by Cloudflare without running this code or calling any upstream; lifetimes come from each
 * response's Cache-Control (see api.ts).
 */
export class Api extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleApi(request, this.env);
  }
}

/**
 * Front door (not cached, so static files stay free): only /api/* reaches it (`run_worker_first`).
 * It applies the per-client rate limit and forwards a canonical URL with no client headers to the
 * cached API, so query-string junk or an Authorization header can't bypass the cache.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);

    if (!(await allowRequest(env.API_RATE_LIMIT, request.headers.get("cf-connecting-ip")))) {
      const body: ApiErrorBody = {
        source: "api",
        fetchedAt: new Date().toISOString(),
        error: {
          kind: "rate-limited",
          message: "Too many requests from your connection in the last minute.",
          hint: "Wait a minute, then try again.",
        },
        upstream: [],
      };
      return json(body, 429, 0, { "retry-after": String(RATE_LIMIT.periodSeconds) });
    }

    const path = canonicalApiPath(url);
    if (!path) return json({ error: "Not found" }, 404);
    return ctx.exports.Api.fetch(new Request(new URL(path, url.origin), { method: request.method, headers: { accept: "application/json" } }));
  },
} satisfies ExportedHandler<Env>;
