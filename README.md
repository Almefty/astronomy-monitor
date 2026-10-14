# Astronomy Monitor

**Live:** https://astronomy-monitor.almefty.workers.dev

A one-page dashboard showing what is happening in the sky right now:

| Panel | What you see | Source |
|---|---|---|
| **Asteroid close approaches** | Every near-Earth object passing within 0.05 au (19.5 lunar distances) from a week ago to two months ahead, plotted by time and distance, sized by estimated diameter, hazardous objects flagged | JPL SSD/CNEOS Close Approach Data API |
| **Solar activity & space weather** | A real-time GOES X-ray flux chart (1-minute data, last 6 or 24 hours, current flare class), plus flares (X-ray class), CMEs (speed, direction) and geomagnetic storms (Kp) on one timeline, WSA-ENLIL predicted CME arrivals at Earth, and a top-down map of CMEs travelling through the inner Solar System | NOAA SWPC (GOES) · NASA DONKI (hosted by CCMC) |
| **Cosmic explosions** | Gamma-ray bursts, gravitational-wave candidates and high-energy neutrinos from the last 3/7/14 days of NASA GCN Circulars, on an all-sky map with their error regions, plus an in-page reader for every circular | NASA GCN Circulars archive |
| **Space telescopes** | What Webb and Hubble are observing right now and next, their targets for the coming days on an all-sky map (with the zone Webb can point at today), and the schedule as a timeline | STScI published schedules · MAST · CDS Sesame |
| **Exoplanet discoveries** | All ~6,400 confirmed planets in "discovery space" (orbit vs size), their host stars on an all-sky map, discoveries per year, and cards for the newest additions | NASA Exoplanet Archive (TAP) |
| **Astronomy Picture of the Day** | Today's picture or video with explanation, plus the last week as a filmstrip | NASA APOD |

Data is fetched **when you press a button** — "Refresh all" at the top, or a panel's own ↻ button. Your last results are kept in your browser so the page isn't empty when you come back. Each panel loads independently: if one source is down, the rest still work (inside the solar panel, the X-ray chart and the DONKI events also load and fail independently).

**Live mode** (the **Live** switch at the top) is the one exception: while it is on *and the page is visible*, the fast-changing sources refresh themselves — X-ray flux every minute, DONKI solar events every 15 minutes, GCN Circulars every 10 minutes. It is off every time you open the page, it pauses whenever the tab is hidden or the computer is offline (a hidden tab makes no requests at all), and it backs off when a source fails. A green square on the switch means it is running; amber means paused.

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

## Sources added in version 2 (verified against the live services, 13 Oct 2026)

- **NASA GCN Circulars** — read from the public archive at `gcn.nasa.gov/circulars` (no account, no Kafka stream). The archive list (IDs and subjects, newest first, filtered by date) comes from the archive page's own data route, with the page's HTML as a fallback; each circular's text comes from its official JSON export `gcn.nasa.gov/circulars/<id>.json`. Events are grouped by the designation in the subject (GRB 261013A, IceCube-261012A, S251117dq; "GRB 261007A / EP261007a" merges the Einstein Probe name into the GRB). Because the free plan allows 50 upstream requests per request, a refresh reads the texts of up to 40 of the most informative circulars (enhanced Swift-XRT positions, optical afterglows, IceCube's own alerts first). Positions are extracted from that text by a strict parser (decimal and sexagesimal formats, IceCube's ± containment, stated 90% errors); the smallest stated error wins, and only if it agrees with the coarser positions of the same event. No gravitational-wave candidates were circulated in the weeks before 13 Oct 2026 (the newest LIGO/Virgo/KAGRA circulars in the archive date from November 2025), so that category may be empty; when present, GW candidates are listed with their sky-map area and classification and a link to GraceDB, not drawn as points.
- **STScI observing schedules** — Webb: the weekly "report" text files linked from `stsci.edu/jwst/science-execution/observing-schedules`; Hubble: the weekly timelines in `stsci.edu/ftp/observing/weekly_timeline/`. There is no API, so the parser finds the columns from each report's own header and dashed separator line, validates every row (dates, durations, IDs, coverage range) and **rejects the whole report with an explanation if anything doesn't look as expected** — the panel then says "Schedule format not recognised" for that telescope instead of guessing. The current week plus next week (once published) are read.
- **Target positions** — the schedules name targets but have no coordinates. In order: **MAST** (STScI's archive API; Webb's *planned* observations carry the scheduled pointing; for Hubble, earlier observations of the same target in the same program), coordinates **encoded in the target name** (e.g. `J095236+405249`, `2MASS-J04285053+1844361`), and the **CDS Sesame** name resolver for catalog names (`NGC-855` → NGC 855). Every position is then checked against the telescope's Sun-angle limits at the time of the observation (Webb 85–135° from the Sun, Hubble ≥ 50°); impossible ones are dropped. On 13 Oct 2026 this placed 63/63 Webb and 46/48 Hubble sky targets, none rejected. Solar System targets (they move) are listed but not drawn.
- **NOAA SWPC GOES X-rays** — `services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json` (and `xrays-6-hour.json` for live updates), 1-minute data from the primary GOES satellite (GOES-18 in Oct 2026), both channels, plus SWPC's flare list. SWPC caches these for 60 s, which matches live mode's 1-minute cadence. In eclipse season (around the equinoxes) the satellite passes through Earth's shadow once a day and the flux drops to zero for up to ~70 minutes; the chart shows that as a "data gap".

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
  index.ts              front door for /api/*: rate limit, canonical URL → cached `Api` entrypoint
  api.ts                routes: /api/status, /api/sources/:id, /api/exoplanets/catalog, /api/gcn/circulars/:id;
                        Cache-Control per response
  lib/params.ts         declared query parameters per source (values clamped; also the cache key)
  lib/ratelimit.ts      per-client limit (IPv4 address / IPv6 /64), fails open
  lib/upstream.ts       fetch with timeouts, typed errors, API-key redaction, call log shown in the UI
  lib/coords.ts         strict sky-coordinate parsing from circular text and from target names
  sources/*.ts          one module per data source → normalized JSON (see shared/contract.ts)
                        (v2: gcn.ts, telescopes.ts, goes.ts)
shared/contract.ts      the JSON contract between Worker and browser
shared/astro.ts         time, Sun position, angular separation, small circles (Worker + browser; base for v3)
src/                    browser app (TypeScript + D3 scales, no framework)
  core/panel.ts         panel framework: loading, errors, snapshots, per-panel isolation, live feeds, in-place updates
  core/live.ts          live mode: per-feed timers, pauses when hidden/offline, back-off on failures
  core/reader.ts        the GCN Circular reader (dialog)
  panels/*.ts           one module per panel (fetch → render → summary for the "Right now" strip)
  viz/                  shared chart pieces (axes, hover layer, label placement, tooltip, sky projection)
  styles/               design tokens (light + dark) and layout
public/_headers         security headers (Content-Security-Policy etc.) for the deployed site
test/                   unit tests for the Worker normalizers (incl. a real DONKI fixture)
```

- **Free-plan friendly:** static files are served from Cloudflare's asset store (free); only `/api/*` runs the Worker. The 0.8 MB exoplanet catalog is streamed through without parsing, which keeps the Worker far under the free plan's 10 ms CPU limit. No database, no cron jobs, no paid services. Version 2 keeps to the same limits: the telescope panel asks for Webb and Hubble in two parallel requests (halves CPU per request; Hubble's ~200 KB timeline is only cut into columns inside the display window), the JWST schedules page is scanned with `indexOf` and abandoned after the first links, a GCN refresh stays under the 50-subrequest limit (≤ 5 list pages + ≤ 40 circulars), and live updates fetch the 6-hour X-ray file (~160 KB) and merge it into the day already shown. With one open tab, live mode costs at most ~1,500 Worker requests per day (free plan: 100,000).
- **Caching and rate limit:** Cloudflare's Workers Cache sits in front of the API. Each response says how long it may be reused — GOES X-rays 60 s, GCN 5 min, DONKI 10 min, APOD 30 min, close approaches and telescope schedules 1 h, exoplanets 6 h — always shorter than the live-mode interval for live feeds. A repeated request within that time is answered by Cloudflare without running the Worker or calling NASA/NOAA/STScI. Errors, partial failures and sample data are never cached. The time shown on each panel is when the data was actually fetched. Per client, `/api/*` allows 120 requests a minute (a "Refresh all" is about 10); beyond that the panels keep their data and say "Too many requests".
- **Content-Security-Policy unchanged:** every upstream call goes through the Worker (`connect-src 'self'`), the sky maps are drawn locally (no external scripts or map tiles), and "View sky in Aladin" is an ordinary link that opens CDS's Aladin Lite in a new tab. Embedding Aladin Lite would have needed its script host, WebAssembly (`'wasm-unsafe-eval'`) and its image-tile servers in the CSP, so it was not embedded.
- **Secret handling:** `NASA_API_KEY` exists only as a Worker secret (Cloudflare) or in `.dev.vars` (local, gitignored). It is never sent to the browser, never logged, and redacted (`api_key=***`) from the request log shown in each panel's "Details".
- **Why `npm run dev` runs `scripts/dev.mjs`:** Cloudflare's local runtime (workerd) doesn't yet trust the certificate chain used by `*.jpl.nasa.gov`, so the launcher hands it Node's bundled Mozilla root certificates. Nothing is installed system-wide; production on Cloudflare doesn't need this.

### Adding a panel

1. **Backend:** add `worker/sources/<name>.ts` implementing `SourceModule`, register it in `worker/sources/index.ts`, and add its types to `shared/contract.ts`.
2. **Frontend:** add `src/panels/<name>.ts` implementing `PanelDefinition` (`load`, `render`, optional `summarize`/`controls`/`live`/`migrate`), and register it in `src/panels/index.ts`.
   - `load(signal, params, prev)` gets the result currently shown, so a partial refresh can keep what it doesn't reload (the solar panel's GOES and DONKI feeds).
   - `render()` may return a view with `update(result)` to apply new data in place (live mode keeps hover, open lists and scroll position).
   - `live: [{ label, everyMs, params }]` opts a panel into live mode; `migrate()` upgrades snapshots saved by an older version.

### Ready for version 3 (3D Solar System)

- **Panel slot and lazy loading:** add `src/panels/solarsystem.ts`; its `render()` can `await import("three")` so the 3D library only downloads when the panel is shown (no CSP change: bundled, served from `'self'`).
- **Data:** JPL's SBDB / Horizons orbital elements fit the existing pattern — a `worker/sources/orbits.ts` module returning compact elements for planets and the close-approach asteroids (the asteroid panel already has their designations and SBDB links).
- **Math:** `shared/astro.ts` already has Julian dates, obliquity, ecliptic↔equatorial conversion and the Sun's position (unit-tested); add a Kepler-equation solver there and propagate positions in the browser every frame — no extra requests.
- **Real-time animation:** `LiveMode.isActive()` and the `livechange` event tell an animation loop when the page is hidden, so it can pause exactly like live updates do.

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

- **DONKI may be unreachable from your own network** (CCMC blocks some networks), so locally the solar panel's event catalogue can't load live data (the live X-ray chart above it works); the deployed site loads both. Locally, use the clearly marked saved sample.
- **GCN positions are machine-read from free text.** The parser is strict and cross-checks positions within an event, but a circular can describe more than one source; the reader is one click away, and the tooltip names the circular a position came from. A refresh reads at most 40 circular texts, so events with only low-priority circulars may show "no position read yet". GW candidates aren't drawn (their localizations are sky maps, not points).
- **Telescope schedules are plans.** Webb runs an event-driven schedule and Hubble's can change after publication, so actual times can differ by hours. STScI publishes the next week's schedule only a few days ahead; until then the timeline says "not yet published". A format change makes that telescope's part say so (by design) until the parser is updated.
- **Some telescope targets have no position**: Solar System targets (they move), and fixed targets that are neither in MAST nor resolvable by name. Positions taken from coarse names (e.g. `J2150-4652`) are marked "approx." (good to about a degree).
- **Live mode is only as live as the sources:** SWPC's 1-minute X-ray data typically appears 1–3 minutes after the measurement.
- CME positions on the "in transit" map assume constant speed; real CMEs speed up or slow down. Earth-arrival times and Kp ranges are WSA-ENLIL model output, not certainties.
- Asteroid sizes are estimated from brightness unless JPL has a measurement (it rarely does for small objects).
- Exoplanet radii for non-transiting planets are often estimated by the archive from mass. That creates the horizontal "stripe" of giant planets near 13 R⊕.
- The Exoplanet Archive is sometimes slow (up to ~25 s). If its count query times out, the total is counted from the catalog instead.
- The DEMO_KEY allows only a handful of requests per hour, which matters only if the APOD fallback is used.
- **Cached data can be up to one lifetime old** (e.g. 60 s for X-rays, 5 min for GCN); "Refresh" within that window returns the same data.
- **APOD images belong to their credited authors** (many are copyrighted). The dashboard shows them as NASA publishes them, with the credit, and doesn't relicense them.
