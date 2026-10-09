import type { ErrorKind, UpstreamCall } from "../../shared/contract";

export class SourceError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint?: string,
    readonly status = kind === "bad-request" ? 400 : 502,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** Strip credentials from a URL before it is recorded, logged or returned. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const name of ["api_key", "apikey", "key", "token"]) {
      if (url.searchParams.has(name)) url.searchParams.set(name, "***");
    }
    return url.toString().replace(/%2A%2A%2A/g, "***");
  } catch {
    return "(invalid url)";
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Treat these HTTP statuses as a valid (non-throwing) response. */
  acceptStatus?: number[];
}

const USER_AGENT = "astronomy-monitor/1.0 (personal dashboard; Cloudflare Worker)";

/**
 * Records every upstream call for transparency in the UI, enforces a timeout,
 * and turns network failures into typed SourceErrors.
 */
export class Upstream {
  readonly calls: UpstreamCall[] = [];

  async fetch(name: string, url: string, opts: FetchOptions = {}): Promise<Response> {
    const started = Date.now();
    const record: UpstreamCall = { name, url: redactUrl(url), ok: false, status: null, ms: 0 };
    this.calls.push(record);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json, text/csv;q=0.9, */*;q=0.5", ...opts.headers },
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      record.status = res.status;
      record.ms = Date.now() - started;
      if (res.status >= 300 && res.status < 400) {
        throw new SourceError(
          "upstream",
          `${name} redirected (${res.status}) instead of returning data — the endpoint may have moved.`,
        );
      }
      if (!res.ok && !(opts.acceptStatus ?? []).includes(res.status)) {
        const body = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ").trim();
        const rateLimited = res.status === 429;
        throw new SourceError(
          "upstream",
          `${name} answered HTTP ${res.status}${body ? `: ${body}` : ""}`,
          rateLimited ? "Rate limit reached. With DEMO_KEY the limit is very low; add your own NASA key." : undefined,
        );
      }
      record.ok = true;
      return res;
    } catch (err) {
      record.ms = Date.now() - started;
      if (err instanceof SourceError) throw err;
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new SourceError("timeout", `${name} did not respond within ${Math.round((opts.timeoutMs ?? 15_000) / 1000)} s.`);
      }
      throw new SourceError("unreachable", `${name} could not be reached (${e.message || "network error"}).`);
    }
  }

  async json<T>(name: string, url: string, opts?: FetchOptions): Promise<T> {
    const res = await this.fetch(name, url, opts);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SourceError("parse", `${name} returned something that is not JSON (starts with "${text.slice(0, 60)}").`);
    }
  }

  async text(name: string, url: string, opts?: FetchOptions): Promise<string> {
    const res = await this.fetch(name, url, opts);
    return res.text();
  }
}
