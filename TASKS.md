# Task list

**Current state (2026-10-11):** Version 1 is complete and live at https://astronomy-monitor.almefty.workers.dev
(Cloudflare Workers Builds deploys every push to `main`; private repo `Almefty/astronomy-monitor`; `NASA_API_KEY`
set as a Worker secret). All four panels verified on the live site with live data. 19 unit tests pass.
Next: version 2 (see "Later versions" at the bottom).

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
- [ ] Cosmic explosions (NASA GCN Circulars) on an all-sky map
- [ ] Webb & Hubble targets on a sky map
- [ ] Live auto-refresh mode with real-time GOES X-ray data
- [ ] 3D solar system view
