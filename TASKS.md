# Task list — Version 1

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
- [x] Worker source: APOD (apod-basic primary, api.nasa.gov fallback with placeholder rejection)
- [x] Secret handling: NASA_API_KEY, DEMO_KEY fallback + UI notice, .dev.vars placeholder
- [x] Local dev fix: workerd lacks the CA for *.jpl.nasa.gov → scripts/dev.mjs passes Node's Mozilla roots
- [x] Frontend shell: header, refresh-all (+ Shift+R), per-panel refresh, theme (auto/light/dark), "Right now" strip
- [x] Panel framework with per-panel error isolation and last-snapshot restore
- [x] Panel: close approaches (time × distance chart, closest list, stats, table)
- [x] Panel: solar activity (flare/CME/Kp timeline with forecast zone, heliosphere CME map, lists)
- [x] Panel: exoplanets (discovery-space scatter, sky map, per-year bars, newest cards, table)
- [x] Panel: APOD (image/video, explanation, 8-day filmstrip)
- [x] Unit tests for worker normalizers (13 tests, real DONKI fixture)
- [x] Security headers (CSP etc.) via public/_headers; verified with a production preview
- [x] Verified locally in browser: 1440/1200/1000 px, 375/360 px, light + dark, failure isolation
- [x] README with local run, key setup, architecture and v2 extension points

## Deployment
- [x] Private GitHub repository `Almefty/astronomy-monitor` created and pushed
- [x] Connected to Cloudflare Workers Builds (auto-deploy on push to `main`)
- [x] `NASA_API_KEY` added as a Worker secret (DEMO_KEY notice gone on the live site)
- [x] Live at https://astronomy-monitor.almefty.workers.dev; all four panels verified with live data, including DONKI
- [x] Fix: close-approach chart headroom and label readability (verified live)

## Optional for you
- [ ] Paste your NASA key into `.dev.vars` for local development (see README)

## Later versions (structure prepared, not built)
- [ ] Cosmic explosions (NASA GCN Circulars) on an all-sky map
- [ ] Webb & Hubble targets on a sky map
- [ ] Live auto-refresh mode with real-time GOES X-ray data
- [ ] 3D solar system view
