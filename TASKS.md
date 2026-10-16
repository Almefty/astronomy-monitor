# Task list

The project's working log: state per version, verification notes, known issues and lessons learned.
Newest first. Commit hashes refer to this repository's history.

**Current state (2026-10-13):** Version 2 is live at https://astronomy-monitor.almefty.workers.dev and verified
there with live data (all six panels, light/dark, 1440/375/360 px, live mode). Adds cosmic explosions (GCN
Circulars), space telescopes (Webb/Hubble schedules) and live mode with real-time GOES X-rays.
61 unit tests pass. Version 1 notes below still apply.
**2026-10-14:** hardening for a public site — Workers Cache on `/api`, per-client rate limit, safer links and
embeds, APOD credits always shown (see "Hardening"). 72 unit tests pass.
**2026-10-14 (UI fixes):** unavailable buttons look unavailable (faint, flat, `not-allowed`, no hover; only
`.is-busy` shows the progress cursor); GOES shows the latest reading's age with a tooltip on NOAA's delay;
the circular reader runs oldest → newest (1 = first report) with first/newest, a position button and a
jump list. The GCN archive list has no dates, so the jump list shows dates only for circulars already read.
**2026-10-15 (v3):** 3D Solar System panel (see "Version 3"). 83 unit tests pass.
**2026-10-15 (v3.1):** 3D view readability + navigation pass (see "Version 3.1").
**2026-10-15 (public):** the repository is public at https://github.com/Almefty/astronomy-monitor (MIT; history
rewritten to remove personal details, commit times shown in UTC, so commit hashes differ from the private
archive `Almefty/astronomy-monitor-archive`). Workers Builds deploys from the public repository.
**2026-10-16 (APOD archive):** date picker, Random day and shareable `?apod=` links for the whole APOD
archive since 16 Jun 1995 (see "APOD archive browsing"). 97 unit tests pass.
**2026-10-15 (fix):** "Refresh all" undercounted since the Workers Cache: it counted a panel as updated only if
its `fetchedAt` was newer than the click, so cached answers looked like failures ("0 of 7 panels updated").
It now counts requests that succeeded (a request overtaken by a newer refresh of the same panel takes that
one's outcome) and says "7 of 7 panels loaded · oldest data 25 min old", naming failed panels.

# APOD archive browsing (2026-10-16)

- [x] Source verified live (16 Oct 2026): `apod-basic` takes `date_from`/`date_to` as **YYMMDD** (4-digit years →
      400), max **25 per page**, newest first, `_fields=date` works, `order=asc` is ignored, `search=` is ignored.
      A missing day returns `[]`. Archive starts **1995-06-16**; no entry for 1995-06-17…19 and 2000-06-30
      (scanned 1995–2000 and 2008–2012). 11,436 entries. No `api.nasa.gov` (offline 1 Dec 2026).
- [x] Worker source `apod-archive?week=` (date → Monday, clamped to 16 Jun 1995 … today, junk → current week):
      1 upstream call per week; for an empty week 2 date-only calls name the nearest days. Past weeks
      `public, max-age=86400, s-maxage=2592000`; the week holding today (or ending yesterday) 30 min
      (`cacheFor()`); failures `no-store`. New `SourceModule.browserMaxAge`.
- [x] Old entries: placeholder `hdurl` → picture from the page body (`<img>` + wrapping link), `/content/dam/`
      JPEG/PNG resized via `/dynamicimage/assets/` (GIF 404s there), media types `video`/`iframe`/`null`,
      Flash/MPEG/QuickTime → `videoKind: "external"` (poster + "Watch on NASA's site"; CSP unchanged),
      empty entries (1997-03-04, 2011-05-26) → "no preview" + link, credit labels cleaned (incl. 1997 title
      line and 2008 "Credit & Copyright" without colon), 2009 digg leftovers stripped.
- [x] Panel: day bar (shown date = native date picker overlay, "Today's picture" / "This week" / "From the
      archive"), Random day, Back to today, status line (missing day → nearest days incl. the next week;
      before 1995-06-16 / future → explained), week filmstrip ("Week of …", 7 columns), dark tiles for
      entries without thumbnails. `?apod=YYYY-MM-DD` follows the shown day (`replaceState`); a linked day is
      offered with a button (no fetch without a press), restored from memory after a refresh.
- [x] Random day: uniform date → its week → random entry ≠ current; ≤ 4 quiet retries; 429 stops; never
      an error state. Buttons disabled while loading; weeks kept in memory for the visit.
- [x] Tests: `test/apod.test.ts` (14, real rows in `test/fixtures/apod-archive-2026-10-16.json`). 97 in total.
- [x] Verified locally (production preview): 1280 / 375 / 360 px, light + dark, no horizontal scroll,
      missing days, out-of-range dates, linked day, Random day ×6, YouTube embed (2008-11-25), Flash entry
      (2009-04-05), no console errors. **Playwright WebKit** (iPhone 13 emulation at 390/375/360 px incl.
      dark, and desktop): the tap lands on and focuses the native date input, linked day, missing day, Random
      day and Back to today work, no errors, no horizontal scroll.

## Lessons learned (APOD archive)
- **Don't reset an `<input type="date">` before the new day has loaded**: a second `change` (Playwright's
  `fill` sends one, so can a picker) then re-opened the old day. Reset it only when nothing new opens.
- **A long browser cache outlives a fix**: testing kept serving a pre-fix 30-day response from the browser
  cache. Long-lived answers now send a short `max-age` for browsers and a long `s-maxage` for Cloudflare.
- **`assets.science.nasa.gov/content/dam/…` ignores `?w=`**; the same path under `/dynamicimage/assets/` resizes.

# Version 3.1 — 3D readability and navigation (2026-10-15)

- [x] Calm by default: every asteroid is a dot; its orbit (and in Near Earth, its path relative to Earth
      with day ticks) is drawn only when selected or hovered — in the view or on a list row.
- [x] Layers popover (top right of the view; icon only on phones): asteroid orbits Selected / Upcoming /
      All (default Selected), planet orbits (on), labels (on). Not saved across visits, like the rest of the view.
- [x] Colour by meaning + legend: planets/Moon neutral; planet orbits neutral, 1.6 px (`Line2`), opaque and
      pre-mixed into the background; asteroid orbits 1 px, status colour (blue; PHA `--series-2`), fainter
      (bulk 0.2 / 0.09 once passed; selected 0.5) so planet orbits always lead. "Already passed" = faded.
      One draw call for all bulk orbits (per-vertex RGBA picks which are shown).
- [x] Planets always visible: planet dots 9 px minimum (asteroids 6), true-size sphere only once it is at least
      as large as the dot. Labels for the Sun, Earth and planets always shown (Labels layer on); placement
      tries 8 spots beside the dot, then steps outwards with a leader line; planets placed first, asteroids
      after; labels avoid each other and planet dots. Only dots that are on screen get a label.
- [x] Pan: right-drag (trackpad two-finger click-drag), shift+drag, two fingers on touch; scroll/pinch zoom
      and left/one-finger rotate unchanged. Panning stops following the Sun/Earth; "Re-centre" (bottom left
      of the view) appears and flies back. Changing view also re-centres. Hint under the view mentions pan
      (short version on phones). Taps only select with the primary button, no shift, one finger.
- [x] Verified: dev + production preview, light/dark, 1280 / 375 / 360 px (no horizontal scroll), Inner /
      Outer / Near Earth, no overlapping or dropped labels (checked with bounding rects), no console errors.
- [x] Deployed (4f5ced2, Workers Builds success) and verified live: Layers control, new hint and legend,
      Outer view with all nine labels, no console errors.
- Note: there is no "follow an asteroid" mode; Re-centre returns to the Sun (Inner/Outer) or Earth (Near Earth).

- [x] Time bar regrouped: Now | ◀ ❚❚ ▶ + speed, divided; the date heading (calendar icon) opens the
      native date picker (`showPicker()`, hidden input underneath) instead of a "Jump to" field. Phones: speed
      is a dropdown, so Now/play/speed fit one row and the slider is full width below (dates under it).

## Lessons learned (v3.1)
- **iOS WebKit opens a date picker only when the tap lands on the `<input type="date">` itself**;
  `showPicker()`/`click()` on a hidden input do nothing there. The input is now a transparent overlay over
  the heading (desktop clicks still call `showPicker()`, the button underneath keeps keyboard + label).
  Checked with Playwright WebKit (iPhone 13 emulation + desktop): taps hit and focus the input.
- **A transparent wide line (`LineMaterial`) looks dotted**: alpha doubles where segments overlap. Use an
  opaque colour pre-mixed with the background instead of opacity.
- **OrbitControls already pans** with right-drag and with ctrl/meta/shift + left-drag; detect a pan by the
  target moving during `controls.update()` (rotate and zoom keep the target).

# Version 3 — 3D Solar System (2026-10-15)

Status: `[x]` done · `[~]` in progress · `[ ]` to do

## Source verification (live, 2026-10-15)
- [x] JPL "Approximate Positions of the Planets" Table 1 + error table — live page matches the constants
      in `shared/orbit.ts` (no API; built into the code).
- [x] JPL SBDB Query API: full-precision elements (`full-prec=true`), `pha` flag, epoch, condition code,
      data arc. **`EQ` rejects spaces** ("bad character(s)") despite the docs → anchored `RE`.
      **502 once `sb-cdata` passes ~1,000 chars** (~46 designations; docs say 2,048) → ≤ 700 chars per
      request, parallel. **`sb-group=neo`: ~1 s instead of 13–17 s** per query. No CORS (Worker only).
- [x] JPL Horizons API (vectors, ecliptic J2000, DE441) — used only to build the test fixture.
- [x] CNEOS CAD — same query as the asteroid panel; PHA flags from SBDB match CAD's `pha=true` list
      (524522, 2001 KF54, 2016 NV on 15 Oct).

## Build
- [x] `shared/orbit.ts`: Kepler (elliptic/hyperbolic/parabolic), JPL Table 1 planets, Earth = EMB − Moon
      share, Meeus Moon (main terms, precessed to J2000), closest-approach search; UTC↔TDB (69.184 s)
- [x] Accuracy vs Horizons (3 epochs): inner planets ≤ 27,000 km, Saturn ≤ 3.1 million km (all within
      JPL's stated errors), Moon ≤ 58 km; asteroid miss distances vs CNEOS: median 0 %, p90 2 % (83 objects)
- [x] Worker source `orbits` (`/api/sources/orbits?past&ahead`, 1 h cache, same params as `neo`; degraded
      → `no-store`): CAD + 3–4 parallel SBDB queries (≤ 5 subrequests)
- [x] Panel `solarsystem` (span-12, after APOD): time bar (Now, ◀ ❚❚ ▶, 1 h/s…1 yr/s, slider over the
      CAD window with "now" and selected-CA marks, jump to date 1900–2049), views (Inner / Outer / Near
      Earth following Earth), list + details (official vs model approach, agreement tag, orbit quality,
      epoch warning), planet/Moon/Sun cards, hover tooltips, "Right now" summary (nearest asteroid now)
- [x] `src/viz/orrery3d.ts` (lazy chunk, three 0.186.1): on-demand rendering, single draw call for all
      asteroid orbits, dots ↔ true-size spheres, Moon orbit + 0.05 au ring + relative path (day ticks) near
      Earth, DOM labels with overlap/edge handling, tap/click picking (26 px on touch), scale bar, theme,
      context-loss recovery, colours converted to sRGB in the custom point shader
- [x] Off-screen / hidden tab: no frames, playback paused (resumes without a jump); reduced motion: no
      damping, instant camera moves; no WebGL 2 → clear message, controls/list/details still work
- [x] Linked with the asteroid panel (`astro:show-in-3d` / `astro:show-in-neo` window events): 3D buttons in
      "Closest upcoming"; "Show in close-approach chart" highlights the dot and opens its tooltip
- [x] Tests: `test/orbit.test.ts` (11 tests, Horizons + CAD + SBDB fixture)
- [x] Verified locally: dev + production preview (CSP unchanged, 3D chunk fetched only when scrolled into
      view), 1280/1440 px, 375/360 px (no horizontal scroll), light + dark, playback, jump, hidden-tab pause,
      reduced motion, WebGL fallback, all seven panels load
- [x] Deployed (fb503a3, Workers Builds success) and verified live: `/api/sources/orbits` loads 84/84
      orbits from Cloudflare (CAD + 3 SBDB calls, ≤ 1 s each), `public, max-age=3600`, repeats are
      `cf-cache-status: HIT` with the same `fetchedAt` (junk parameters hit the same entry); "Refresh all"
      updates all seven panels; the 3D chunk loads only when the panel scrolls into view; 1280 px light and
      375 px dark (no horizontal scroll); the 3D button in the asteroid panel selects the object in Near
      Earth view; no console errors

## Lessons learned (v3)
- **The Claude desktop app's in-app browser only produces animation frames while a screenshot is taken** (rAF, smooth scroll
  and IntersectionObserver wait). Take screenshots between steps when testing anything animated.
- **`vite preview` needs the CA workaround too**: `.claude/launch.json` now starts it via `scripts/dev.mjs
  preview`, otherwise every JPL call fails locally. Restart the preview after `npm run build`.
- **three.js ShaderMaterial writes linear colour**; without `#include <colorspace_fragment>` CSS colours
  come out too dark.
- **`scrollIntoView` on a list item also scrolls the page**; scroll the list container instead.
- **Two-body orbits are good enough for most close approaches but not all.** Show the official value
  next to the estimate rather than hiding the difference.

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
- [x] Cache key = path + query (not host) + Worker version, so a deploy that changes the Worker code starts
      fresh. A deploy with unchanged code (docs-only commits) keeps the cache: seen 2026-10-15, a 6 h exoplanet
      entry survived two docs-only deploys. The front Worker
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
- [x] Deployed (e73326e, Workers Builds success) and verified live: repeated requests return
      `cf-cache-status: HIT` with a rising `Age` and the **same `fetchedAt`** as the first response (so no
      Worker run and no upstream calls); `?days=007&junk=…` hits the `days=7` entry; 404 is `no-store`; all six
      panels load, no console errors; a cached panel shows its true age ("Updated 14:21 · 3 min ago").
- [~] **Rate limit deployed but not enforcing on the live site:** 400 requests from one IPv6 address in
      ~20 s all returned 200. Same as workers-sdk#16097 (free plan, workers.dev).
      Harmless (fails open); it will start working if Cloudflare fixes it. Re-test with a burst of ~400
      requests to `/api/status`.

## Lessons learned (hardening)
- **The cache is per data centre.** Requests from one machine were spread over five
  different data centres, so "MISS twice in a row" can just mean two colos. Compare `cf-ray` suffixes; check `fetchedAt` on HITs.
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
- [x] Private GitHub repository `Almefty/astronomy-monitor` created and pushed (since 2026-10-15 the public
      repository of that name; the original private history is archived as `Almefty/astronomy-monitor-archive`)
- [x] Connected to Cloudflare Workers Builds (auto-deploy on push to `main`)
- [x] `NASA_API_KEY` added as a Worker secret (DEMO_KEY notice gone on the live site)
- [x] Live at https://astronomy-monitor.almefty.workers.dev; all four panels verified with live data, including DONKI
- [x] Fix: close-approach chart headroom and label readability (verified live)
- [x] Fix: numeric table headers right-aligned, columns sized to content; frosted sticky header
- [x] Fix: APOD action buttons on phones; heliosphere orbit labels spaced and haloed
- [x] Renamed: no brand name; package/Worker/folder are `astronomy-monitor`; workers.dev subdomain `almefty`

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
- The Cloudflare dashboard Worker logs / `wrangler tail` haven't been used (needs a Cloudflare login); each API
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
- [x] v3: 3D Solar System with planets, the Moon and the close-approach asteroids from JPL orbits
