import type { Notice, SourceDataMap, SourceId, SourceInfo } from "../../shared/contract";
import type { Env } from "../lib/env";
import type { ParamSpec } from "../lib/params";
import type { Upstream } from "../lib/upstream";

export interface SourceContext {
  env: Env;
  upstream: Upstream;
  params: URLSearchParams;
  now: Date;
  notices: Notice[];
  /** Mark this response as not cacheable (sample data, a partial failure the user should retry). */
  noCache(): void;
  /** Cache this response for a shorter time than the source's `maxAge` (e.g. the APOD week holding today). */
  cacheFor(seconds: number): void;
}

/**
 * A data source the dashboard can refresh. To add a new panel's backend
 * (e.g. GCN Circulars in v2): create a module implementing this interface and
 * add it to worker/sources/index.ts.
 */
export interface SourceModule<K extends SourceId = SourceId> extends SourceInfo {
  id: K;
  /**
   * How long (seconds) a successful response may be served from the Worker cache. Match it to how
   * fast the source changes, and keep it at or below the live-mode interval for live feeds.
   */
  maxAge: number;
  /** Shorter lifetime for browsers (sent as max-age, with `maxAge` as s-maxage for Cloudflare's cache). */
  browserMaxAge?: number;
  /** The query parameters load() reads; everything else is dropped from the cache key. */
  params?: ParamSpec;
  load(ctx: SourceContext): Promise<SourceDataMap[K]>;
}
