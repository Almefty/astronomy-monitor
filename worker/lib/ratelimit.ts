/**
 * Per-client limit on /api/* (the API_RATE_LIMIT binding in wrangler.jsonc: 120 requests per 60 s).
 * A normal visit never comes close: "Refresh all" is ~10 requests, live mode adds 1–2 per minute,
 * and the circular reader one per circular opened. Cloudflare counts per location and is
 * deliberately approximate, so this is a brake on abuse, not exact accounting.
 */
export const RATE_LIMIT = { limit: 120, periodSeconds: 60 } as const;

/** The key a client is counted under: its IPv4 address, or its IPv6 /64 (one subscriber's prefix). */
export function clientKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":") || ip.includes(".")) return ip; // IPv4 (also IPv4-mapped IPv6)
  const [head = "", tail] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** True if the request may go ahead. Fails open: a missing or failing binding never blocks anyone. */
export async function allowRequest(limiter: RateLimit | undefined, ip: string | null): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key: clientKey(ip) })).success;
  } catch {
    return true;
  }
}
