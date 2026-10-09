import type { KeyMode } from "../../shared/contract";

export interface Env {
  /** Worker secret (Cloudflare dashboard) or .dev.vars locally. Never logged, never returned. */
  NASA_API_KEY?: string;
  APP_ENV?: string;
  ASSETS: Fetcher;
}

/** NASA's public, heavily rate-limited key used until the real one is configured. */
export const DEMO_KEY = "DEMO_KEY";

export function nasaKey(env: Env): { key: string; mode: KeyMode } {
  const configured = (env.NASA_API_KEY ?? "").trim();
  if (configured && configured !== DEMO_KEY) return { key: configured, mode: "secret" };
  return { key: DEMO_KEY, mode: "demo" };
}

export function appEnv(env: Env): "development" | "production" {
  return env.APP_ENV === "development" ? "development" : "production";
}
