import type { Notice, SourceDataMap, SourceId, SourceInfo } from "../../shared/contract";
import type { Env } from "../lib/env";
import type { Upstream } from "../lib/upstream";

export interface SourceContext {
  env: Env;
  upstream: Upstream;
  params: URLSearchParams;
  now: Date;
  notices: Notice[];
}

/**
 * A data source the dashboard can refresh. To add a new panel's backend
 * (e.g. GCN Circulars in v2): create a module implementing this interface and
 * add it to worker/sources/index.ts.
 */
export interface SourceModule<K extends SourceId = SourceId> extends SourceInfo {
  id: K;
  load(ctx: SourceContext): Promise<SourceDataMap[K]>;
}
