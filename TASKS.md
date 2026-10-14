# Task list

**Current state (2026-10-13):** Version 2 is live at https://astronomy-monitor.almefty.workers.dev and verified
there with live data (all six panels, light/dark, 1440/375/360 px, live mode). Adds cosmic explosions (GCN
Circulars), space telescopes (Webb/Hubble schedules) and live mode with real-time GOES X-rays.
61 unit tests pass. Version 1 notes below still apply.
**2026-10-14:** hardening for a public site — Workers Cache on `/api`, per-client rate limit, safer links and
embeds, APOD credits always shown (see "Hardening"). 72 unit tests pass.
Next: version 3 (3D Solar System, see "Later versions").

# Hardening (2026-10-14)

The site stays public (portfolio), without Cloudflare Access, on the free plan.

- [x] Workers Cache — confirmed in Cloudflare's docs (14 Oct 2026): available on every plan, works on
      workers.dev, needs Wrangler ≥ 4.69 (`exports` per entrypoint ≥ 4.107; we have 4.149). Cache hits run no
      Worker code and no upstream calls (no CPU) but still count as requests. **With caching on the default
      entrypoint, static-asset requests would also be billed as requests**, so only the `Api` entrypoint is
      cached; the uncached front Worker forwards `/api/*` to it via `ctx.exports.Api` (default since compat
      date 2025-11-17).
- [x] Lifetimes (`maxAge` per source): GOES 60 s (live 1 min) · GCN 5 min (live 10 min) · DONKI 10 min
      (live 15 min) · APOD 30 min · close approaches 1 h · telescopes 1 h · exoplanets + catalog 6 h ·
      GCN circular 6 h · status 5 min. `no-store`: errors, 404/405/429, dev sample, partial failures.
- [x] Cache key = path + query (not host) + Worker version, so each deploy starts fresh. The front Worker
      forwards only a canonical URL (declared params, clamped, fixed order; no client headers), so junk
      query strings or an `Authorization` header can't bypass the cache.
- [x] Rate Limiting binding `API_RATE_LIMIT`: 120 requests / 60 s per IPv4 address or IPv6 /64, fails open.
      Cloudflare's docs don't state plan availability, and an open bug (workers-sdk#16097, Oct 2026) reports
      the binding never blocking on free workers.dev accounts. Enforced locally (`npm run dev`): 429 + `Retry-After`.
- [x] 429 in the UI: panels showing data keep it and the header says "Too many requests — data not updated";
      empty panels show the message with "Try again".
- [x] `src/viz/chart.ts` point links go through `safeUrl`; APOD iframe sandboxed (`allow-scripts
      allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox`), host check exact
      (`www.youtube-nocookie.com`, `player.vimeo.com`), forced https. YouTube verified playing in the sandbox;
      Vimeo's player loads but the in-app test browser can't play Vimeo even unsandboxed (codec), not the sandbox.
- [x] APOD: credit & copyright always shown ("see the entry on NASA’s site" when missing), repeated
      "Image Credit:" labels stripped, rights note + "About APOD" link under the filmstrip.
- [x] Git history scan (17 commits): no secrets, keys, tokens, `.dev.vars` or `dist/` ever committed.
- [ ] Verify on the live site: second request served from cache (`cf-cache-status: HIT`, unchanged
      `fetchedAt`, no new upstream calls), static assets unaffected, rate limit behaviour.

## Lessons learned (hardening)
- **Workers Cache applies heuristic lifetimes** when `Cache-Control` is missing (2 h for a 200), so every
  `/api` response states its policy explicitly.
- **Panels show `fetchedAt`** ("Updated 14:16"), so a cached response is honest about its age.

# Version 2

Status: `[x]` done · `[~]` in progress · `[ ]` to do

## Source verification (live, 2026-10-13)
- [x] NASA GCN Circulars: archive list via the archive page's data route
      (`/circulars?startDate=YYYY-MM-DD&limit=100&page=N&_data=routes%2Fcirculars._archive._index` → `{items:[{circularId,subject}],totalPages,totalItems}`),
      HTML list as fallback; official per-circular JSON `/circulars/<id>.json` (eventId, subject, body, createdOn,
      submitter). No CORS, so it goes through the Worker. ~130 circulars/week. No GW circulars since Nov 2025.
- [x] STScI JWST weekly reports (`_documents/YYYYMMDD_report_YYYYMMDD.txt`, linked from the schedules page,
      newest first; fixed-width with header + dashed separator; no coordinates)
- [x] STScI HST weekly timelines (`/ftp/observing/weekly_timeline/timeline_MM_DD_YY`, ~200 KB; "SMS Start … End"
      coverage line; fixed-width; proposal titles at the end; no coordinates)
- [x] MAST `Mast.Caom.Filtered` (POST form `request=`): JWST planned observations (`calib_level = -1`) have
      `s_ra/s_dec` for scheduled targets (61/63 on 13 Oct); HST has no planned observations, only earlier ones
- [x] CDS Sesame batch resolver (`nph-sesame/-o/SNV?name1&name2…`, text `%J ra dec`), sometimes slow (2–37 s)
- [x] NOAA SWPC GOES `json/goes/primary/xrays-{6-hour,1-day}.json` (1-min, both channels, `cache-control: max-age=60`,
      CORS *), `xray-flares-latest.json`, `xray-flares-7-day.json`

## Build
- [x] Shared contract types (gcn, telescopes, goes) and `shared/astro.ts` (Sun position, separations, small circles)
- [x] Worker: `lib/coords.ts` — strict position parser for circular text (decimal, sexagesimal, IceCube ±,
      instrument attribution per paragraph) and for target names (J-names, 2MASS, SDSS, DW…P/M…)
- [x] Worker source `gcn`: list → events (aliases, preliminary-name merge) → budgeted body reads (≤ 40) →
      best consistent position, trigger time, GW area/class; `/api/gcn/circulars/:id` for the reader
- [x] Worker source `telescopes`: JWST + HST parsers with column detection and full validation; MAST → name →
      Sesame positions; Sun-angle sanity check; one telescope per request (`?telescope=JWST|HST`)
- [x] Worker source `goes`: 24 h or 6 h, both channels, SWPC floor/zero values treated as gaps, flare list
- [x] Panel framework: `load(…, prev)`, quiet refresh (no dimming; on failure keep data + "Live update failed"),
      in-place `update()`, snapshot `migrate()`, `live` feeds, render context `refresh(params)`
- [x] Live mode (`core/live.ts`): off by default and not remembered, pauses when hidden/offline, per-feed intervals
      (GOES 1 min, DONKI 15 min, GCN 10 min), exponential back-off; Live switch + status line
- [x] Solar panel: DONKI and GOES as independent feeds (own errors, inline retry/sample), live X-ray chart
      (log flux, class bands, R1 line, flare peaks, flare-in-progress band, data gaps, crosshair, 6 h/24 h),
      headline includes a flare in progress; v1 snapshots migrated
- [x] Cosmic explosions panel: stats, type filter, all-sky map with true error circles + Sun, event list,
      circular reader (dialog, older/newer, arrow keys, linkified URLs, e-mails stripped), table
- [x] Space telescopes panel: now/next cards, sky map (Webb's 85–135° zone shaded, current targets ringed,
      click → Aladin), schedule Gantt, table, per-telescope format/stale/unreachable messages; redraws each minute
- [x] Tests: 61 in total, 42 new (real circulars, real JWST report, real HST timeline excerpt, GOES sample, mocked end-to-end)
- [x] Verified locally: 1440 px and 375/360 px (no horizontal scroll), light + dark, production build + CSP,
      live mode on/hidden/off, DONKI failure isolated from GOES
- [x] Deployed (Workers Builds); verified on the live site: every panel loads with live data, including DONKI;
      all new upstreams (GCN, STScI, MAST, CDS Sesame, SWPC) reachable from Cloudflare; heaviest request
      (GCN 14 d) = 42 upstream calls (limit 50), no CPU-limit errors; reader works (full-screen on phones);
      live mode refreshes GOES every minute in place and makes no requests while hidden

## Known issues (v2)
- GCN positions are machine-read; a circular describing several sources can still mislead (mitigated by the
  consistency check; the reader is one click away). Events whose only circulars are low-priority (e.g. MASTER
  reports) may have no position.
- STScI publishes next week's schedules only a few days ahead. JWST plans are event-driven; times can shift.
- MAST has no planned observations for Hubble; new Hubble targets rely on names and Sesame (2/48 unplaced on 13 Oct).
- CPU time per request can't be measured from here; parsers were benchmarked (warm: HST 2–3 ms, JWST < 1 ms,
  40 circulars 1–4 ms). Check *Workers & Pages → astronomy-monitor → Metrics → CPU time* if errors appear.

## Lessons learned (v2)
- **GOES eclipse season:** around the equinoxes GOES-18 passes through Earth's shadow daily (~09 UTC); the flux
  ramps down and SWPC reports 0 (flagged `electron_contaminaton: true`). Values ≤ 1e-9 are SWPC's floor/missing.
- **In-place updates must not keep a restored view:** the "Showing the last data you loaded" note lives only in
  the DOM, so a refresh with unchanged data kept it (fixed 2026-10-14: `PanelHost.showingRestored`).
- **SWPC occasionally serves a half-written file** (rewritten every minute): seen once on 2026-10-13 18:11 UTC
  ("not JSON (starts with [{"time_tag"…"), 0 of 40 in a follow-up test. The Worker now retries once after
  1.5 s; live mode keeps the previous data if the retry fails too.
- **Swift circulars report BAT, XRT and UVOT positions in one text** — attribute positions by paragraph, and in
  ground-based follow-ups label by the subject (instrument names there are citations).
- **The browser pane counts as a hidden tab** to the page, so live mode is paused there — test by overriding
  `document.hidden` and dispatching `visibilitychange` (timers are not throttled there; verified 5 s ticks).
- **Python string replacements eat backslashes** (`\b` became a backspace character). Use the Edit tool or raw
  strings for code with regexes.

# Version 1

Status: `[x]` done · `[~]` in progress · `[ ]` to do

## Source verification (live, 2026-10-09)
- [x] JPL SSD/CNEOS Close Approach Data API — works as documented
- [x] NASA Exoplanet Archive TAP — works (`pscomppars` + `ps.releasedate` for new additions)
- [x] NASA DONKI — **moved**: `api.nasa.gov/DONKI/*` now 301-redirects to a CCMC notice page.
      New official home `https://ccmc.gsfc.nasa.gov/DONKI-API/get/*` (no key, same JSON, max 60-day range).
      Verified working from Cloudflare's edge; CCMC refuses connections from the development network.
- [x] NASA APOD — `api.nasa.gov/planetary/apod` returns placeholder data (title "NASA Science", NASA logo image)
      after APOD moved to science.nasa.gov. Official replacement `science.nasa.gov/wp-json/wp/v2/apod-basic` works.

## Build
- [x] Project scaffold (Vite + Cloudflare Worker + static assets, TypeScript)
- [x] Shared API contract types
- [x] Worker: router, upstream fetch helper (timeouts, key redaction), source registry
- [x] Worker source: close approaches (CAD + PHA flag)
- [x] Worker source: solar activity (DONKI FLR/CME/GST via CCMC) + dev-only saved sample
- [x] Worker source: exoplanets (recent additions + catalog passthrough, optional count)
- [x] Worker source: APOD (apod-basic JSON → official RSS feed → api.nasa.gov, newest entry wins, placeholder rejection)
- [x] Secret handling: NASA_API_KEY, DEMO_KEY fallback + UI notice, .dev.vars placeholder
- [x] Local dev fix: workerd lacks the CA for *.jpl.nasa.gov → scripts/dev.mjs passes Node's Mozilla roots
- [x] Frontend shell: header, refresh-all (+ Shift+R), per-panel refresh, theme (auto/light/dark), "Right now" strip
- [x] Panel framework with per-panel error isolation and last-snapshot restore
- [x] Panel: close approaches (time × distance chart, closest list, stats, table)
- [x] Panel: solar activity (flare/CME/Kp timeline with forecast zone, heliosphere CME map, lists)
- [x] Panel: exoplanets (discovery-space scatter, sky map, per-year bars, newest cards, table)
- [x] Panel: APOD (image/video, explanation, 8-day filmstrip)
- [x] Unit tests for worker normalizers and APOD source selection (19 tests, real DONKI fixture)
- [x] Security headers (CSP etc.) via public/_headers; verified with a production preview
- [x] Verified locally in browser: 1440/1200/1000 px, 375/360 px, light + dark, failure isolation
- [x] README with local run, key setup, architecture and v2 extension points

## Deployment
- [x] Private GitHub repository `Almefty/astronomy-monitor` created and pushed
- [x] Connected to Cloudflare Workers Builds (auto-deploy on push to `main`)
- [x] `NASA_API_KEY` added as a Worker secret (DEMO_KEY notice gone on the live site)
- [x] Live at https://astronomy-monitor.almefty.workers.dev; all four panels verified with live data, including DONKI
- [x] Fix: close-approach chart headroom and label readability (verified live)
- [x] Fix: numeric table headers right-aligned, columns sized to content; frosted sticky header
- [x] Fix: APOD action buttons on phones; heliosphere orbit labels spaced and haloed
- [x] Renamed: no brand name; package/Worker/folder are `astronomy-monitor`; workers.dev subdomain `almefty`

## Optional for you
- [ ] Paste your NASA key into `.dev.vars` for local development (see README)

## Known issues
- **DONKI doesn't load locally** on the development network: CCMC (`ccmc.gsfc.nasa.gov` and the legacy
  `kauai.ccmc.gsfc.nasa.gov`, both 169.154.198.x) refuses TCP connections from it. Works from Cloudflare.
  Locally, use the solar panel's "Preview with saved sample (9 Oct 2026)" (dev-only, `?sample=1`, labelled,
  stripped from production builds). A VPN would probably work (untested).
- **APOD JSON API can be blocked or lag.** science.nasa.gov sometimes answers `wp-json/wp/v2/apod-basic` with a
  JavaScript "Checking your browser" page (HTTP 403, `_hcc` cookie; WordPress VIP) — seen for ~10 min on
  2026-10-11 from both Cloudflare and outside. The Worker then uses the official RSS feed and says why.
- **api.nasa.gov/planetary/apod** returns placeholder records ("NASA Science" + NASA logo, dates off by one)
  and is reported to go offline 2026-12-01. Kept only as a last fallback; placeholders are rejected.
- **Exoplanet Archive TAP** response time varies 1–25 s; timeouts are generous and the count query is optional.
- The Cloudflare dashboard Worker logs / `wrangler tail` haven't been used (needs the user's login); each API
  response carries an `upstream` list (name, status, ms, redacted URL) shown under each panel's "Details".

## Lessons learned (read before changing things)
- **NASA endpoints move.** DONKI left `api.nasa.gov` on 2026-09-30 (now `https://ccmc.gsfc.nasa.gov/DONKI-API/get/*`,
  no key, max 60-day range per request); APOD moved to science.nasa.gov. Verify against the live API first.
- **Test network reachability from Cloudflare, not just the development machine.** The Cloudflare Workers Playground
  (workers.cloudflare.com/playground, no login) runs code on Cloudflare's edge — that's how DONKI was verified.
- **Local TLS:** workerd's bundled CA list lacks the Sectigo R46 chain used by `*.jpl.nasa.gov` ("internal error"
  on fetch). `npm run dev` runs `scripts/dev.mjs`, which writes Node's Mozilla roots to `.wrangler/ca/` and sets
  `NODE_EXTRA_CA_CERTS`. Production doesn't need this. Run `npx vite …` directly and JPL fails locally.
- **The Vite Cloudflare plugin copies `.dev.vars` into `dist/<worker>/`** for `vite preview`. `dist/` is gitignored
  and not uploaded as a secret, but never commit `dist/`.
- **CSS minifier (production only) bit us twice:** it dropped the standard `backdrop-filter` when it came before
  the `-webkit-` one, and minified `blur(24px) saturate(160%)` to `blur(24px)saturate(160%)`, which the browser
  rejected. Put the standard property last, prefer single-function filters, and check the deployed CSS.
- **Vite inlines tiny font subsets as `data:` URIs** — the CSP in `public/_headers` allows `font-src 'self' data:`.
- **Running `npm run build` while the dev server runs can break the dev server**, and changing `wrangler.jsonc`
  can leave Vite's dependency cache stale (page hangs on `d3-*.js`). Restart dev (`--force` clears the cache).
- **Free-plan CPU:** parsing the 1.2 MB exoplanet catalog in the Worker would risk the 10 ms limit, so it is
  streamed and parsed in the browser; the APOD RSS parser stops after 10 items (~425 KB feed).
- **DONKI data quirks:** several CME analyses can carry `isMostAccurate: true` (take the newest);
  `isEarthMinorImpact` counts as a glancing blow; WSA-ENLIL `kp_180` is worst case, so severity uses the low end.
- **Workers static assets**: `run_worker_first: ["/api/*"]`; everything else is served free from the asset store.
- **Deploy confirmation:** for Worker-only changes the static files don't change; check the GitHub check run
  ("Workers Builds: astronomy-monitor") on the commit, then call the live `/api/...` endpoint.

## Later versions (structure prepared, not built)
- [x] Cosmic explosions (NASA GCN Circulars) on an all-sky map — v2
- [x] Webb & Hubble targets on a sky map — v2
- [x] Live auto-refresh mode with real-time GOES X-ray data — v2
- [ ] v3: 3D Solar System with planets and approaching asteroids moving in real time from JPL orbits
      (hooks: panel registry + lazy `import("three")`, `shared/astro.ts`, `LiveMode.isActive()`/`livechange`; see README)
