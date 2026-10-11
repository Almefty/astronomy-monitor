# Astronomy Monitor

**Live:** https://astronomy-monitor.almefty.workers.dev

A one-page dashboard showing what is happening in the sky right now:

| Panel | What you see | Source |
|---|---|---|
| **Asteroid close approaches** | Every near-Earth object passing within 0.05 au (19.5 lunar distances) from a week ago to two months ahead, plotted by time and distance, sized by estimated diameter, hazardous objects flagged | JPL SSD/CNEOS Close Approach Data API |
| **Solar activity & space weather** | Flares (X-ray class), CMEs (speed, direction) and geomagnetic storms (Kp) on one timeline, WSA-ENLIL predicted CME arrivals at Earth, and a top-down map of CMEs travelling through the inner Solar System | NASA DONKI (hosted by CCMC) |
| **Exoplanet discoveries** | All ~6,400 confirmed planets in "discovery space" (orbit vs size), their host stars on an all-sky map, discoveries per year, and cards for the newest additions | NASA Exoplanet Archive (TAP) |
| **Astronomy Picture of the Day** | Today's picture or video with explanation, plus the last week as a filmstrip | NASA APOD |

Data is fetched **only when you press a button** — "Refresh all" at the top, or a panel's own ↻ button. Your last results are kept in your browser so the page isn't empty when you come back. Each panel loads independently: if one source is down, the rest still work.

---

## Open it on your computer

You need **Node.js** (developed on version 26). Everything else lives inside this folder.

1. Open the **Terminal** app (press ⌘ Space, type *Terminal*, press Return).
2. Copy-paste this line and press Return (it moves into the project folder):

   ```bash
   cd astronomy-monitor
   ```

3. Only the first time (or after updating the project), install its libraries:

   ```bash
   npm install
   ```

4. Start the dashboard:

   ```bash
   npm run dev
   ```

5. Open **http://localhost:5173** in your browser and press **Refresh all**.

To stop it, click the Terminal window and press **Control + C**. (In the Claude desktop app you can also just ask Claude to start it.)

## Add your NASA API key (local)

Your key stays on your computer in a file called `.dev.vars`, which Git ignores. It is read by the server part of the app and never sent to the browser.

1. In Finder, open the project folder `astronomy-monitor`.
2. Press **⌘ Shift .** (Command, Shift, full stop) to show hidden files — `.dev.vars` appears.
3. Right-click `.dev.vars` → **Open With → TextEdit**.
4. Paste your key right after the equals sign so the line reads `NASA_API_KEY=yourkeyhere` (no spaces, no quotes). Save (⌘ S) and close.
5. Restart the dashboard (Control + C in Terminal, then `npm run dev` again).

The yellow "Using NASA's public DEMO_KEY" notice disappears once the key is picked up. Until then the app falls back to NASA's shared DEMO_KEY.

> Note: as of October 2026 NASA moved DONKI and APOD off `api.nasa.gov` (details below), so today the key is only used by the APOD backup feed. The plumbing stays in place for future panels that use `api.nasa.gov`.

---

## What changed at NASA (verified 9 Oct 2026)

All four sources were checked against their live APIs before building:

- **JPL Close Approach Data** — works as documented.
- **NASA Exoplanet Archive TAP** — works. "Newly added" uses the earliest `releasedate` of each planet in the `ps` table. Response times vary a lot (1–25 s), so timeouts are generous.
- **DONKI** — on 30 Sep 2026 DONKI moved from `api.nasa.gov/DONKI/*` (which now redirects to a CCMC notice page) to **`https://ccmc.gsfc.nasa.gov/DONKI-API/get/*`**: same parameters and JSON, no API key, max 60-day range. CCMC refuses connections from some networks, **including the one this project was developed on**; it works from Cloudflare's network (tested on Cloudflare's edge). So locally the solar panel shows an explanation plus a *"Preview with saved sample"* button (real DONKI data captured on 9 Oct 2026, clearly labelled, development only). Once deployed it uses live data.
- **APOD** — APOD moved to science.nasa.gov. The old `api.nasa.gov/planetary/apod` now returns placeholder records (title "NASA Science", the NASA logo as image) and is reported to go offline on 1 Dec 2026. The dashboard uses the new official endpoint **`science.nasa.gov/wp-json/wp/v2/apod-basic`**. Two fallbacks: NASA's official APOD RSS feed (`science.nasa.gov/feed/apod-basic/`, same fields), used when the JSON API fails (on 11 Oct 2026 it briefly answered with a JavaScript "Checking your browser" page) or lags behind today's APOD; and `api.nasa.gov`, used only if it returns real records (placeholder records are rejected). The panel notes which source it used and why.

---

## How it's built

```
worker/                 Cloudflare Worker = the only server code (holds the secret, calls upstream APIs)
  index.ts              router: /api/status, /api/sources/:id, /api/exoplanets/catalog
  lib/upstream.ts       fetch with timeouts, typed errors, API-key redaction, call log shown in the UI
  sources/*.ts          one module per data source → normalized JSON (see shared/contract.ts)
shared/contract.ts      the JSON contract between Worker and browser
src/                    browser app (TypeScript + D3 scales, no framework)
  core/panel.ts         panel framework: loading, errors, snapshots, per-panel isolation
  panels/*.ts           one module per panel (fetch → render → summary for the "Right now" strip)
  viz/                  shared chart pieces (axes, hover layer, label placement, tooltip, sky projection)
  styles/               design tokens (light + dark) and layout
public/_headers         security headers (Content-Security-Policy etc.) for the deployed site
test/                   unit tests for the Worker normalizers (incl. a real DONKI fixture)
```

- **Free-plan friendly:** static files are served from Cloudflare's asset store (free); only `/api/*` runs the Worker. A full refresh makes about 10 upstream requests. The 0.8 MB exoplanet catalog is streamed through without parsing, which keeps the Worker far under the free plan's 10 ms CPU limit. No database, no cron jobs, no paid services.
- **Secret handling:** `NASA_API_KEY` exists only as a Worker secret (Cloudflare) or in `.dev.vars` (local, gitignored). It is never sent to the browser, never logged, and redacted (`api_key=***`) from the request log shown in each panel's "Details".
- **Why `npm run dev` runs `scripts/dev.mjs`:** Cloudflare's local runtime (workerd) doesn't yet trust the certificate chain used by `*.jpl.nasa.gov`, so the launcher hands it Node's bundled Mozilla root certificates. Nothing is installed system-wide; production on Cloudflare doesn't need this.

### Adding a panel (planned for v2)

1. **Backend:** add `worker/sources/<name>.ts` implementing `SourceModule`, register it in `worker/sources/index.ts`, and add its types to `shared/contract.ts`.
2. **Frontend:** add `src/panels/<name>.ts` implementing `PanelDefinition` (`load`, `render`, optional `summarize`/`controls`), and register it in `src/panels/index.ts`.

Ready-made hooks for the v2 ideas:

- **Cosmic explosions (GCN Circulars) on an all-sky map** and **Webb/Hubble targets on a sky map** — reuse `src/viz/sky.ts` (Hammer–Aitoff equatorial projection with graticule and galactic plane), already used by the exoplanet host-star map.
- **Live auto-refresh with GOES X-rays** — every panel exposes `refresh()` through `PanelHost`, so a live mode is a timer over chosen panels. The flare band in the solar timeline already uses the GOES log-flux scale.
- **3D solar system** — a panel's `render()` can `await import("three")` so the 3D library only downloads when that panel is shown.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the local dashboard at http://localhost:5173 |
| `npm test` | Run the unit tests |
| `npm run typecheck` | Type-check browser and Worker code |
| `npm run build` | Production build into `dist/` |
| `npm run check` | All three of the above |

## Deployment

Live at **https://astronomy-monitor.almefty.workers.dev** (Cloudflare Workers, free plan).

- **Code:** private GitHub repository `Almefty/astronomy-monitor`. Cloudflare Workers Builds is connected to it: every push to `main` rebuilds (`npm run build`) and redeploys (`npx wrangler deploy`) automatically, usually within a minute or two.
- **Secret:** `NASA_API_KEY` is stored as a Worker **Secret** under *Workers & Pages → astronomy-monitor → Settings → Variables and Secrets* (Production). To change it, edit it there and deploy; no code change is needed.
- **Build status and logs:** *Workers & Pages → astronomy-monitor → Deployments*.

## Known limitations

- **DONKI may be unreachable from your own network** (CCMC blocks some networks), so locally the solar panel can't load live data; the deployed site does. Locally, use the clearly marked saved sample.
- CME positions on the "in transit" map assume constant speed; real CMEs speed up or slow down. Earth-arrival times and Kp ranges are WSA-ENLIL model output, not certainties.
- Asteroid sizes are estimated from brightness unless JPL has a measurement (it rarely does for small objects).
- Exoplanet radii for non-transiting planets are often estimated by the archive from mass. That creates the horizontal "stripe" of giant planets near 13 R⊕.
- The Exoplanet Archive is sometimes slow (up to ~25 s). If its count query times out, the total is counted from the catalog instead.
- The DEMO_KEY allows only a handful of requests per hour, which matters only if the APOD fallback is used.
