import type { ApiErrorBody, Envelope, GcnCircular, SourceDataMap, SourceId, StatusResponse } from "../../shared/contract";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly body: ApiErrorBody | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") {
      throw new ApiError("The request took too long and was cancelled.", null, 0);
    }
    throw new ApiError("Could not reach this dashboard's server. Is it running?", null, 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const b = body as ApiErrorBody | null;
    throw new ApiError(b?.error?.message ?? `Server answered HTTP ${res.status}.`, b?.error ? b : null, res.status);
  }
  return body as T;
}

const withTimeout = (ms: number, outer?: AbortSignal) =>
  outer ? AbortSignal.any([outer, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

export function fetchStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>("/api/status", withTimeout(10_000));
}

export function fetchSource<K extends SourceId>(
  id: K,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Envelope<SourceDataMap[K]>> {
  const qs = new URLSearchParams(params).toString();
  // Generous: some upstreams (the Exoplanet Archive) occasionally take tens of seconds.
  return getJson(`/api/sources/${id}${qs ? `?${qs}` : ""}`, withTimeout(100_000, signal));
}

export async function fetchText(path: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(path, { signal: withTimeout(100_000, signal) });
  } catch {
    throw new ApiError("Could not download the planet catalog.", null, 0);
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* ignore */
    }
    throw new ApiError(body?.error?.message ?? `Catalog request failed (HTTP ${res.status}).`, body, res.status);
  }
  return res.text();
}

/** One GCN Circular for the reader (fetched when the user opens it). */
export function fetchCircular(id: number, signal?: AbortSignal): Promise<GcnCircular> {
  return getJson<GcnCircular>(`/api/gcn/circulars/${id}`, withTimeout(30_000, signal));
}
