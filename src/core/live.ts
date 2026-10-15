import type { PanelHost } from "./panel";

/**
 * Live mode: the one exception to "data is fetched only when you press a button".
 *
 * - Off by default and never remembered: every visit starts with it off.
 * - While on, each panel's `live` feeds are refreshed on their own interval, but only while
 *   the page is visible and the browser is online. A hidden tab makes no requests at all;
 *   when it becomes visible again, feeds that are due refresh straight away.
 * - Failures back off (×2, ×4, … up to ×8 the interval) so an upstream outage isn't hammered.
 *
 * Budget with one open tab: GOES every 60 s → ≤ 1,440 Worker requests/day (2 upstream calls
 * each, SWPC caches for 60 s); DONKI every 15 min; GCN every 10 min. Far inside the free
 * plan's 100,000 requests/day and the upstreams' published guidance.
 *
 * The 3D Solar System has its own clock and isn't part of live mode; it pauses itself when the
 * tab is hidden or the view is off-screen (src/panels/solarsystem.ts).
 */
export class LiveMode {
  enabled = false;
  private timer: number | undefined;
  private state = new Map<string, { due: number; failures: number; inFlight: boolean }>();

  constructor(private hosts: PanelHost<any>[]) {
    document.addEventListener("visibilitychange", () => {
      this.emit();
      if (!document.hidden) void this.tick();
    });
    window.addEventListener("online", () => {
      this.emit();
      void this.tick();
    });
    window.addEventListener("offline", () => this.emit());
  }

  /** True when live mode is on and actually running (tab visible, online). */
  isActive(): boolean {
    return this.enabled && !document.hidden && navigator.onLine;
  }

  status(): "off" | "on" | "paused" {
    if (!this.enabled) return "off";
    return this.isActive() ? "on" : "paused";
  }

  /** Human summary of what live mode refreshes, e.g. "X-ray flux every 1 min · …". */
  describe(): string {
    const parts: string[] = [];
    for (const host of this.hosts) for (const f of host.def.live ?? []) parts.push(`${f.label} every ${f.everyMs >= 60_000 ? `${Math.round(f.everyMs / 60_000)} min` : `${Math.round(f.everyMs / 1000)} s`}`);
    return parts.join(" · ");
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    window.clearInterval(this.timer);
    this.state.clear();
    if (on) {
      const now = Date.now();
      // Feeds whose data is already fresh wait for their next slot; stale or missing ones run now.
      this.hosts.forEach((host, hi) =>
        (host.def.live ?? []).forEach((f, fi) => {
          const last = host.result ? (f.lastUpdate?.(host.result) ?? host.result.fetchedAt) : null;
          const due = last ? new Date(last).getTime() + f.everyMs : now;
          this.state.set(`${hi}:${fi}`, { due: Math.min(due, now + f.everyMs), failures: 0, inFlight: false });
        }),
      );
      this.timer = window.setInterval(() => void this.tick(), 5_000);
      void this.tick();
    }
    this.emit();
  }

  private async tick() {
    if (!this.isActive()) return;
    const now = Date.now();
    this.hosts.forEach((host, hi) =>
      (host.def.live ?? []).forEach((f, fi) => {
        const st = this.state.get(`${hi}:${fi}`);
        if (!st || st.inFlight || now < st.due || host.busy) return;
        st.inFlight = true;
        void host.refresh(f.params ?? {}, { quiet: true }).then((ok) => {
          st.inFlight = false;
          st.failures = ok ? 0 : st.failures + 1;
          // Count the next slot from when this request started, so the cadence stays at `everyMs`.
          st.due = now + f.everyMs * Math.min(8, 2 ** st.failures);
        });
      }),
    );
  }

  private emit() {
    window.dispatchEvent(new CustomEvent("livechange", { detail: this.status() }));
  }
}
