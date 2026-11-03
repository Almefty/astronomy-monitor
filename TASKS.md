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
**2026-11-01 (v4, PR 1 of 3):** topocentric astronomy math for the coming "Sky tonight" panel
(`shared/sky.ts`, no UI yet; see "Version 4 — Sky tonight" and `docs/plans/sky-tonight.md`). 127 unit tests pass.
**2026-11-01 (v4, PR 2 of 3):** spacecraft elements and visible passes: Worker source `satellites` (CelesTrak)
and `src/viz/passes.ts` (SGP4 via satellite.js, not loaded by the page yet). 156 unit tests pass after the
ultrareview fixes (see PR 2 below).
**2026-11-01 (v4, PR 3 of 3):** the "Sky tonight" panel (`src/panels/sky.ts`, after APOD): location picker,
tonight's events, Moon, planets, spacecraft passes, sky dome, "Right now" summary. 182 unit tests pass. Not deployed
yet (see PR 3 below for what was and wasn't verified).
**2026-11-03 (v4, PR 3 layout pass):** the sky panel simplified without removing features (see "PR 3 layout pass"
below). 188 unit tests pass.
**2026-11-03 (v4, CelesTrak fallback):** passes keep working when CelesTrak fails from Cloudflare (HTTP 522
after ~20 s): saved elements in the browser and, best effort, on the server; timeout 25 → 12 s (see "CelesTrak
fallback" below). 199 unit tests pass. Server copy not yet verified on Cloudflare.
**2026-11-01 (v4, PR 3 review fixes):** nine fixes from the maintainer's review, incl. CelesTrak requests in parallel
(see "PR 3 review fixes" below). 187 unit tests pass.

# Version 4 — Sky tonight (in progress, plan in `docs/plans/sky-tonight.md`)

## PR 1 — topocentric math (2026-11-01)
- [x] `shared/sky.ts` (pure, no DOM, no three.js, not imported by the frontend yet, so the bundle is
      unchanged): GMST (IAU 1982), J2000 → date precession (IAU 1976), equatorial → horizontal, WGS 84
      observer position and topocentric parallax, Sæmundsson/Bennett refraction (display only), Meeus ch. 25
      Sun (with aberration), Moon via `moonGeocentric`, planets via `planetPosition − earthPosition` with one
      light-time iteration, Moon phase (illumination, phase angle, name, age, principal-phase times), planet
      magnitudes (Mallama & Hilton 2018) and Sun elongation, a generic crossing finder (10-min scan +
      bisection to 1 s), rise/transit/set with `normal` / `always-up` / `never-up`, night events from the
      observer's solar noon to the next (`nightWindow`, `nightDate`) with `time` / `always-above` /
      `always-below` / `none`, `Intl` time-zone helpers (display only), preset places, 0.01° rounding. `shared/astro.ts` `sunPosition` untouched (the telescope panel uses it).
- [x] Sources verified live (2026-11-01): JPL Horizons API observer tables (`EPHEM_TYPE`, not
      `EPHEMERIS_TYPE`; `CENTER='coord@399'`, `SITE_COORD='E-lon,lat,km'`, `TLIST` in UT), USNO
      `api/rstt/oneday` (only civil twilight; polar cases say "Object continuously above/below the Horizon")
      and `api/moon/phases/date`. Fixture `test/fixtures/sky-reference.json` (49 KB), rebuilt by
      `scripts/fetch-sky-fixtures.mjs`. Nautical/astronomical twilight references come from Horizons' Sun
      elevation at 1-minute steps (USNO's one-day API doesn't give them).
- [x] Accuracy (Jakarta, Tromsø, Cape Town; 6 epochs 2026-11 → 2027-09; 4 days incl. Tromsø polar night
      and polar day). Worst cases vs Horizons: Sun 0.003°, Moon 0.007°, Mercury–Mars ≤ 0.010°, Uranus/Neptune
      ≤ 0.014°, Jupiter 0.038°, **Saturn 0.076°** (JPL Table 1's error, up to 600″, so it may exceed 0.1° on
      other dates); magnitudes ≤ 0.04 (Saturn 0.038 — its ring term uses the Earth's tilt only; Mars 0.027; Uranus 0.0014
      and Neptune 0.0003 once the phase terms apply only beyond 3.1°/1.9°); Moon illumination 0.003
      percentage points. Twilight/sunrise/sunset vs Horizons ≤ 0.04 min; Sun and Moon rise/transit/set and
      civil twilight vs USNO ≤ 0.93 min; 24 principal Moon phases vs USNO ≤ 1.8 min. Test limits are the
      plan's (0.1° / 0.2° / 2 min / 0.2 mag).
- [x] Speed (warm, Node, cloud container): `nightEvents` ≈ 0.3 ms per night (the Sun's altitude is
      sampled once at 10-min steps and all four limits are refined from those samples); `moonPhase` ≈ 0.15 ms
      (new-moon search seeded from the Moon−Sun longitude difference, ±1.5 days; matched a full scan at
      2,923 instants over 2026–2028); rise/transit/set for the Moon + 7 planets with magnitudes ≈ 15 ms.
      A whole night ≈ 16 ms. Measure on a phone in PR 3.
- [x] Ultrareview fixes (2026-11-01): the night window was the display zone's wall-clock noon, so with a
      zone far from the observer's longitude (Jakarta coordinates, New York zone) it began at night and
      sunrise came back `none`; it now runs between the Sun's upper transits at the observer's longitude
      (`solarNoon`, equation of time included), and `nightDate(ms, obs)` picks "tonight" from solar time.
      `nightEvents(obs, date)` no longer takes a time zone (the panel uses one only to format times).
      `skyPosition`/`moonPhase` reuse `topocentricVector`.
- Known limits: nutation and planetary aberration ignored (≤ 0.006°); UT1 = UTC; Horizons applies the
  Mercury polynomial beyond the paper's 170° phase angle, so we do too; a horizon dip shorter than the
  10-min scan can be missed (a body grazing the horizon near the poles).

## PR 3 — the panel (2026-11-01)
- [x] **Loading model** (the plan's preferred option): the Sun, Moon and planets are computed as soon as a location
      exists, with no request: `PanelDefinition.initial()` gives `PanelHost` a result to show before anything is
      loaded or saved (header: "Spacecraft orbits not loaded"). Only `/api/sources/satellites` waits for a press
      (↻, "Refresh all", or the panel's "Load spacecraft passes"). A failed orbit fetch doesn't throw: `load()`
      keeps the previous orbits, the error shows inside the passes section, and `PanelResult.failed` makes "Refresh
      all" count the panel as failed, puts the text in the header and skips saving. `restoredNotice()` replaces the
      generic "last data you loaded" note (only the orbits are old; the sky is always computed for now).
      `RenderContext.notify()` redraws the "Right now" strip after a location change or new passes.
- [x] **Location**: opt-in, never prompted on load. "Use my location" (Geolocation API, on press only), six preset
      cities (Jakarta, London, New York, Tromsø, Cape Town, Sydney, each with its IANA zone), or latitude/longitude
      typed as a number plus N/S, E/W (phones' decimal keypads have no minus key). Stored via `core/storage.ts`
      (`sky:location`), rounded to 0.01°, validated on load; "Forget my location" removes it. Never sent to `/api`,
      never in the URL. Manual and device locations use the browser's zone and say which; a place more than 3 h of
      longitude from that zone gets a note. **`public/_headers` had `geolocation=()`**, which blocks the API
      entirely; now `geolocation=(self)` (checked in the production preview with a granted permission).
- [x] **Content**: stats (sunset + civil dusk, "dark sky" = Sun below −18°, sunrise + civil dawn, Moon % with an SVG
      phase drawn with its lit side towards the Sun as seen facing the Moon, zenith up), plain sentences for polar
      day, polar night, white nights and no full darkness; one row per planet ("visible" = above 5° while the Sun is
      below −6° and ≥ 10° from it; otherwise the reason: glare, daylight only, stays low, below the horizon, sky not
      dark) with best time, direction, altitude, visible interval, rise/set and magnitude (binoculars beyond 5.5);
      passes for the next 4 nights (6 shown, "Show all"), brightest marked, start/end causes (Earth's shadow,
      twilight), "No visible passes tonight. Next: …", or an explanation when there are none in 4 nights;
      per-satellite errors and missing objects listed; element epochs shown.
- [x] **Sky dome** (SVG, `src/viz/sky-model.ts` geometry): azimuthal equidistant, zenith centre, N up, E left, 30°/60°
      rings; Sun, Moon (phase, lit side along the great circle to the Sun), planets sized by magnitude (open circles
      beyond 5.5), the selected pass's track with direction arrow and its position during the pass; labels placed to
      avoid each other and the dots; `src/viz/tooltip.ts` on hover/tap. Time slider sunset → sunrise (noon → noon
      without them, labelled with dates), "Now" (follows the clock, 1-minute ticker, paused while hidden), arrows ±10
      min, Shift ±1 min; opened in the afternoon it shows the start of darkness. Selecting a pass on a later night
      moves the dome to that night. `role="img"` with a text summary; the lists are the text equivalent. No animation
      anywhere, so reduced motion needs nothing extra.
- [x] **"Right now" strip**: "Sky tonight · Jakarta — ISS 19:39 — Pass, mag −1.3 · Moon 54%, Saturn up", or
      "Moon 54% — Last Quarter · Mars, Jupiter and Saturn tonight", or "Pick a location".
- [x] **satellite.js in the build**: the first production build with `passes.ts` imported failed: satellite.js 7's
      entry re-exports its WebAssembly runtimes, and Vite tried to bundle the multi-thread one as a Web Worker (IIFE,
      top-level await). `vite.config.ts` aliases `#wasm-single-thread` / `#wasm-multi-thread` (only reached through
      functions this app never calls) to `src/viz/satellite-no-wasm.ts`. Result: `passes-*.js` 25.7 kB (12.6 kB gzip),
      loaded with `import()`; SGP4 code is not in `index-*.js` (checked by its field names). Main bundle 184.3 → 224.9 kB
      (66.5 → 82.1 kB gzip): the panel, `shared/sky.ts` and `sky-model.ts`. No WASM files in `dist/`.
- [x] Tests: `test/sky-panel.test.ts` (26): dark intervals vs the Sun, planet visibility and best time vs a 2-minute
      brute-force scan (6 site/date cases incl. polar day/night and London midsummer), rise/set vs `riseTransitSet`
      (< 0.1 min), best time = transit when it culminates in the dark, polar sentences, Moon lit side points to the Sun
      (great-circle check), dome orientation, stored-location validation, coordinate parsing, formatting. The PR 2
      bundle test now runs against a real panel (`src/panels/sky.ts` uses only `import type` + `import()`).
- [x] Speed. `computeTonight` (events, Moon, 7 planets) ≈ 16 ms warm in Node (first version 50 ms: it sampled every
      planet twice through `riseTransitSet`; rise/set and best time now come from one set of samples per body).
      Headless Chromium, production build, first (cold) run per page load: tonight 42–61 ms, 4-night passes 26–36 ms;
      with **4× CPU throttling** (DevTools' mid-tier-phone setting): tonight 208 ms, passes 193 ms, both once per page
      load (the passes after the async chunk load, so they don't block the first paint). This is above the plan's
      "well under 100 ms on a phone" for a cold run on a slow phone; warm runs are 5–10× faster. **Not measured on a
      real phone** — do that after deploying.
- [x] **Verified locally** (Playwright Chromium, dev server and production preview; the satellites response served
      from the PR 2 CelesTrak fixture by request interception, because local workerd can't reach upstreams from the
      cloud container): light and dark at 1280, 375 and 360 px with no horizontal scroll; Jakarta, Cape Town, London,
      Tromsø, typed southern coordinates (45.87° S, 170.50° E, with the zone note), device location (granted
      permission, Cape Town); Tromsø polar night (21 Dec 2026) and polar day (21 Jun 2027) with a fixed clock; no
      location; orbits failing (inline error, header, "Refresh all" lists the panel, sky still drawn, previous passes
      kept); snapshot restore after reload; slider keyboard steps; no console errors.
- [ ] **Not verified yet**: the deployed site (needs a merge to `main`), `/api/sources/satellites` from Cloudflare
      (Workers Builds preview), a real phone (speed, Safari geolocation prompt, iOS keypad), Playwright WebKit.
- Not built: Webb/Hubble targets on the dome (the plan's optional item): it would read the telescope panel's saved
  result and couple the panels, which the plan said to skip.
- Known limits: the dome draws planets lost in twilight or glare too (it is a position chart; the tooltip says
  "lost in the Sun's glare"); visibility uses fixed thresholds (5°, −6°, 10° from the Sun), not limiting magnitude
  or sky brightness; times for manual coordinates are in the browser's zone, not the place's.

## PR 3 review fixes (2026-11-01)
1. **Coordinate sign vs hemisphere select**: "-33.87" with S became 33.87° N (sign × select). One rule now
   (`coordinateFromInput` in `src/viz/sky-model.ts`): a typed sign (ASCII minus, Unicode minus or plus) wins and the select switches to
   match, as you type and on submit; without a sign the select decides. Unit tests for both, and a browser check
   ("-33.87" + S → 33.87° S; "+74.01" with W picked → 74.01° E).
2. **Default hemispheres** were S/E with no saved location; now N/E (`defaultHemispheres`). Tested, and checked in the browser.
3. **New night not detected in a hidden tab**: the clock compared the night with the shared `tonightCache`, which the
   strip's `summarize()` refreshes every minute even while the panel isn't redrawn, so the panel kept showing last
   night. The render now remembers the night it drew (`drawnNight`). Browser check with Playwright's clock (Jakarta,
   tab hidden across solar noon, then shown): the old code kept the 1 Nov slider range and the chosen 22:10, the new
   code moves to 2 Nov.
4. On a new night `view.ms`, `view.domeNight`, `view.passKey` (and "Show all") are reset before `build()`, so an
   afternoon view picks the new night's start of darkness again.
5. **Late geolocation answers** are ignored when another location was chosen meanwhile (`locationVersion`) or the
   render was destroyed. Browser check: answer delayed 1.5 s, Jakarta picked meanwhile → stays Jakarta.
6. An unusable position (rejected by `toObserver`) re-enables "Use my location" and removes `is-busy`, like the error path.
7. The time-zone note's solar offset is wrapped to [−12, 12) h (`solarOffsetHours`): Tonga, Samoa and Kiritimati
   (west longitudes on UTC+13/+14) no longer get a false note; Ürümqi on Beijing time still does. Tested.
8. The dome tooltip uses the planet's `glare` status and the footnote `GLARE_ELONGATION` instead of a literal 10.
9. **CelesTrak in parallel**: the maintainer saw CelesTrak answering in 5–10 s per request on the preview; one after
   another that was ~24 s in production, and the preview hit the 15 s default timeout on the first call. The three
   requests now run in parallel (still one per object, never retried), each with a **25 s** timeout
   (`REQUEST_TIMEOUT_MS`; a timeout costs a 10-minute failure cache, so it is generous; the browser waits up to 100 s).
   Any non-200 other than "No GP data found", a timeout or a network error makes the answer a failure (502) or a
   partial one with a warning, both cached for 600 s, so no request leaves that data centre for 10 minutes. The
   trade-off: in parallel the other two calls are already sent when one fails (at most two extra requests per
   error), where the sequential version skipped them. Results keep the list order; `unavailable` no longer says
   "Not requested after an earlier CelesTrak error". Tests: the three requests start before any finishes (~40 ms
   total with 40 ms stubs), timeouts and network errors count as failures, any other 404 is a failure.
   CLAUDE.md's CelesTrak rule updated. **Not verified against the live CelesTrak** from here (cloud container); check
   the response time on the next Workers Builds preview.
- `npm run check` passes (187 tests); production preview re-checked at 360 px light, 375 px dark and 1280 px, no
  horizontal scroll, no console errors.

## CelesTrak fallback (2026-11-03)
From Cloudflare, CelesTrak often answers HTTP 522 after ~20 s (from elsewhere ~1 s), so the live panel regularly
said "Orbital elements for Hubble couldn’t be loaded…" or lost all three spacecraft.
1. **Browser copy (`src/viz/sky-elements.ts`)**: the last good elements per spacecraft in localStorage (`sky:elements`
   via `core/storage.ts`, newest epoch wins). When the server can't load a spacecraft (`unavailable[].kind: "failed"`;
   new field, missing on older answers = failed) or the whole request fails, its passes are predicted from the copy
   if the **elements' epoch** is at most 3 days old (stricter than the save time: the epoch is what limits SGP4's
   accuracy). Older copies are dropped and the panel shows the usual message. The passes section says it per
   spacecraft: "Hubble: orbit from 5 h ago (saved in this browser), CelesTrak didn’t answer." (whole request
   failed: "…, the latest orbits couldn’t be loaded.", under the error box). If storage is blocked, the elements on
   screen are used. `CelesTrak has no elements` (`kind: "missing"`) is not filled in. A whole failure is still
   `PanelResult.failed`; a filled partial answer isn't. Logic in `loadElements()`, tested with an in-memory store
   (`test/sky-elements.test.ts`, 8 tests); the panel only injects `core/storage.ts`.
2. **Server copy (best effort, not yet verified on Cloudflare)**: Cloudflare's Cache API doesn't work on workers.dev
   (forum answer; the docs only promise it on custom domains), so it uses **Workers Cache's `stale-if-error`**
   instead. Cloudflare's Workers Cache configuration page (found via search, 2026-11-03; developers.cloudflare.com
   isn't reachable from the cloud container, so not read directly) says a cached entry is served when the Worker
   throws, times out or answers 5xx while revalidating it, within `stale-if-error`; `s-maxage`, `must-revalidate`
   or `proxy-revalidate` disable it; without the directive the default is to serve stale indefinitely.
   - Each object has an internal route `/api/internal/celestrak/<id>` (`celestrakObject()` in
     `worker/sources/satellites.ts`), fetched by the `satellites` source through `SourceContext.internal`, which
     goes back through `ctx.exports.Api` (the cached entrypoint), so each object has its own cache entry. In tests
     and without a loopback, `handleApi` calls itself directly (no cache). `canonicalApiPath` never forwards
     `/api/internal/*`, so the front Worker answers 404 for them.
   - Success: `public, max-age=7200, stale-if-error=259200`. Failure: 502 `no-store` (never replaces the copy).
     "No GP data found": 200, `max-age=7200` without `stale-if-error`.
   - The aggregate recognises a saved copy by the copy's own `fetchedAt` (older than 2 h + 5 min can only come
     from `stale-if-error`), marks it `saved: true` with `fetchedAt`, adds a warning ("CelesTrak didn’t answer for
     Hubble; using the copy this site saved 5 h ago.") and so caches the answer 600 s. A saved copy whose epoch is
     more than 3 days old is treated as a failure. Every object now carries `fetchedAt`.
   - CelesTrak's policy is unchanged or better: the aggregate's 600-s failure cache still limits retries to one per
     object per 10 minutes per data centre, and after a partial failure only the failed object is asked again (the
     others' internal entries are still fresh for 2 h; before, all three were re-asked).
   - Cost: a cache miss on the aggregate is now 1 + 3 Worker requests (each internal call counts), still far below
     the 100k/day quota; CPU is three small JSON parses.
   - Tested with a model of Workers Cache (`workersCache()` in `test/satellites.test.ts`: max-age, no-store,
     `stale-if-error` on 5xx): saved copy served and flagged after a 522, the failure doesn't replace it, only the
     failed object is asked again after 10 min, 3-day epoch limit, internal route not forwardable.
   - Limits: Cloudflare may evict a rarely used entry long before 3 days; the cache is per data centre; a deploy
     that changes the Worker code starts a new cache (TASKS "Hardening"), so the server copy is lost on each deploy.
   - **To verify on the preview URL / after deploy:** `/api/sources/satellites` lists each object with `fetchedAt`
     and, when it came from the server copy, `"saved": true` (plus the warning notice). It needs a success first,
     then a CelesTrak failure more than 2 h later in the same data centre. If `saved` never appears while the panel
     shows CelesTrak failures (`unavailable[].kind: "failed"`, HTTP 522/timeouts in `upstream`), `stale-if-error` or
     the loopback cache doesn't work on workers.dev: remove the internal route and say so here.
3. **Timeout 25 → 12 s** (`REQUEST_TIMEOUT_MS`): healthy answers take ~1 s, a 522 arrives after ~20 s. Both outcomes
   cost the same 10-minute failure cache, so giving up earlier only shortens the wait.
4. The partial-failure warning no longer says "no passes are predicted for it" (the browser may still predict them);
   the passes section says what happened per spacecraft.
- Verified on the production preview (Playwright Chromium, satellites answer intercepted, saved copies seeded):
  partial answer (Tiangong server-saved, Hubble failed and filled from the browser) and total failure (HTTP 502, all
  three from the browser) at 1280 px light, 375 px dark, 360 px light; no horizontal scroll, no console errors.
- Observation: the aggregate `/api/sources/satellites` sends no `stale-if-error`, so by Cloudflare's documented
  default an expired aggregate entry may already be served stale when the Worker answers 502. That it didn't help
  in practice fits eviction (low traffic) and per-colo caches. Left unchanged.

## PR 3 layout pass (2026-11-03)
The maintainer found the panel cluttered, especially on phones. Same features, fewer controls:
1. **Location picker**: one primary "Use my location" button and a "Choose a city…" `<select>` (was six buttons).
   Coordinates sit behind an "Enter coordinates" disclosure as **one text field** (`parseLatLon` in
   `src/viz/sky-model.ts`; replaces the two number fields and the N/S, E/W selects). It reads "-33.87, 151.21"
   as Google Maps copies it, "33.87 S, 151.21 E", "33.87°S 151.21°E", "S 33.87 E 151.21", "151.21 E, 33.87 S" (letters say
   which is which) and decimal commas when the numbers are separated by a space or semicolon. The sign rule stays:
   a typed sign wins, else the letter, else north/east. Out-of-range and unreadable input get a message and
   `aria-invalid`. Tests replaced (`coordinateFromInput`, `typedSign`, `defaultHemispheres` are gone with the
   selects). The field is prefilled Google-Maps style for a manual location. Privacy note is one line
   ("Your location stays in this browser (rounded to about 1 km).") with "Forget it".
2. **One load button**: the passes section keeps "Load spacecraft passes" (and "Try again" after a failure; it shows
   "Loading…" while busy). While it shows, the header ↻ is hidden through a new `RenderContext.setRefreshVisible()`
   (`PanelHost` resets it on every render and on errors); it returns once orbits are loaded. With no location chosen
   the header ↻ stays (no other button then). Checked in every state: exactly one of them visible.
3. "Change location" is a small text link ("Change" / "Close") next to the place name.
4. The dome's "Now" sits beside the shown time and appears only when the dome is away from now (> 1 min); pressing it
   moves focus to the slider. `.btn` sets `display`, so `[hidden]` needed explicit CSS for it and the header ↻.
5. **"How to read this"** (`<details>`, closed by default, remembered for the visit): the dome explanation, the planet
   visibility rule, the spacecraft note (pass criteria, spells, low-inclination orbits, the download happens only on
   a press, element epochs and age) and the accuracy footnote. The empty-pass state keeps one sentence.
6. **Planets not visible tonight** share one collapsed row ("Not visible tonight: Mercury and Venus"); opened, each
   says why. The "Visible"/"Not visible" tags are gone (the grouping says it).
- Verified on the production preview (Playwright Chromium, orbits from the PR 2 fixture): 375 px light and dark,
  360 px light (no location; Tromsø with every disclosure open) and dark, 1280 px light (Jakarta) and dark (typed
  coordinates, orbits failing); no horizontal scroll, no console errors; the coordinate field with both formats,
  an unreadable and an out-of-range input; the city select and the Change link.

## Lessons learned (v4, PR 3)
- **`[hidden]` doesn't hide a `.btn`**: the class sets `display`, which wins. Add a `[hidden]` rule wherever a
  button is hidden that way (the first screenshots still showed "Now" while following the clock).
- **Test against the code you are fixing**: the hidden-tab new-night check was run once against the previous
  `sky.ts` to confirm it fails there.
- **`vite preview` serves the build it started with**: restart it after `npm run build` (already noted for v3), or
  a check silently runs the old bundle.
- **A lazy library can still break the build**: tests import satellite.js in Node and passed for all of PR 2, but
  the first `vite build` with the page importing it failed on its unused WASM runtime. Run `npm run build` as soon
  as a new library reaches the page.
- **`Permissions-Policy` blocks APIs silently**: `geolocation=()` makes `getCurrentPosition` fail as if the user
  refused. Check `public/_headers` before using any browser permission.
- **Sampling twice costs twice**: `riseTransitSet` samples altitude and hour angle; deriving rise/set and the best
  time from the panel's own samples cut a night from 50 to 16 ms.

## PR 2 — spacecraft elements and visible passes (2026-11-01)
- [x] Worker source `satellites` (`worker/sources/satellites.ts`, `SatellitesData` in `shared/contract.ts`): the
      ISS (25544), Tiangong (48274) and Hubble (20580), listed once with their standard magnitudes. CelesTrak's
      `gp.php?CATNR=<id>&FORMAT=JSON` takes **one** catalog number per query (`CATNR=a,b` → "not an integer"), so
      3 calls of ~420 bytes, made **one after another** and stopped at the first non-200 answer (*changed in the PR 3
      review fixes: now in parallel*; CelesTrak's
      usage policy), except its "No GP data found" 404 (see the ultrareview fixes). The answer keeps only the OMM
      fields SGP4 needs plus name, ID and epoch. No query parameters (one cache entry for everyone). Stale epochs
      (> 7 days) → **info** notice, so the answer keeps its cache lifetime (re-downloading can't make CelesTrak's
      elements newer).
- [x] CelesTrak verified live (2026-11-01): ISS answer 420 bytes, no `Cache-Control`; an unknown catalog number is
      **HTTP 404 "No GP data found"** (text/plain); a malformed query is **HTTP 200** with a plain-text message; `FORMAT`
      defaults to CSV since 2026-05-09. **Usage policy** (https://celestrak.org/usage-policy.php, updated 2026-05-22):
      GP data updates every 2 hours, download it once per update, and stop at any non-200 answer (repeats go to the
      firewall). So `maxAge` = **7,200 s**: Cloudflare's cache answers repeats, and each data centre asks at most
      once per update.
- [x] `src/viz/passes.ts` — the only file that imports `satellite.js` (7.1.0, MIT; a test enforces it; the main
      bundle is byte-identical, `index-*.js` same hash). `json2satrec` reads CelesTrak's OMM JSON directly (no
      conversion needed). Visible = above 10°, sunlit (cylindrical shadow of the equatorial radius), observer's Sun
      below −6°. Dark intervals from the Sun's altitude (10-min samples, bisection), then a 20-s scan per
      satellite with edges bisected to 0.5 s, the peak by golden-section search, an edge cause per end
      (`horizon` / `shadow` / `twilight` / `window`), a 20-s track for the dome, and the brightest estimated
      magnitude (McCants: std − 15.75 + 2.5·log10(range² / f), f = (1 + cos phase)/2). Satellites fail
      independently (bad elements, SGP4 error, elements > 30 days from the search dates). `passSearchWindow`
      = now → end of the 4th night (tonight first).
- [x] **Skip-ahead**: while the angle at the Earth's centre between observer and satellite exceeds the largest
      angle at which it can be above 10° (polar radius, apogee radius, +1°), no pass can start before that gap
      closes at the satellite's fastest angular rate plus the Earth's rotation (+5%). ≈ 15× faster (4 sites ×
      3 spacecraft × 4 full days: 356 → 22 ms);
      a test checks it finds the same passes as the plain 20-s scan (3 spacecraft × 4 sites × 4 days).
- [x] Tests (`test/satellites.test.ts`, 23 at first, 29 after the fixes): Worker normalizer and policy behaviour
      (one call per object, stop at the first error, failure caching, stale = info and cached); **SGP4 vs Vallado et al. 2006 (AIAA
      2006-6753)** — all 31 non-error cases ≤ 1e-8 km / 1e-9 km/s; the reference was run in AFSPC mode, so 23599
      (the "Lyddane choice" deep-space case) is checked in AFSPC mode (8e-9 km) and differs by 0.96 km in
      satellite.js's default "improved" mode, by design; both error cases report errors. OMM vs TLE of the same
      update: 0.6 m over 4 days. **ISS vs JPL Horizons** (`-125544` is served, "TLE-based", elements revised 31 Oct):
      46 passes above 10° at Jakarta, Cape Town and London over 4 days, none at Tromsø (correct: 51.6° inclination);
      rise/peak/set ≤ 0.8 s, peak altitude ≤ 0.04° (≤ 0.25° above 80°, where the reference's parabola is the
      limit), 20-s positions ≤ 0.07°. Cylindrical shadow vs satellite.js's conical `shadowFraction`: 2 of
      103,680 ten-second samples differ. Fixtures: `test/fixtures/satellites-reference.json` (20 KB) and
      `sgp4-vallado.json` (65 KB), rebuilt by `scripts/fetch-satellite-fixtures.mjs [--vallado]`.
- [x] Speed (Node, cloud container, 3 spacecraft × 4 nights): **2.7–6.8 ms** per observer warm (2.4–4.5 ms
      before the between-sample searches), 43 ms for the very first call (JIT warm-up). Measure on a phone in PR 3.
- [x] **Ultrareview fixes (2026-11-01):**
      1. *CelesTrak failures were uncacheable*, so during an outage every visitor's refresh hit CelesTrak again,
         against its usage policy. Now a **deliberate exception** to CLAUDE.md's no-store rule: sources may declare
         `failureMaxAge` (`worker/sources/types.ts`; only `satellites` does, a test checks), and `worker/api.ts` caches
         their failed and partial answers — and their upstream error responses (HTTP 502) — for that long:
         **600 s** (`FAILURE_MAX_AGE`). `noCache()`, bad requests and internal errors are still never cached.
         CelesTrak's documented **"No GP data found" (HTTP 404)** is now an answer about one object: it goes to
         `unavailable` with an **info** notice, the remaining objects are still requested, and the answer keeps the
         full 2 h (one persistently missing object no longer disables caching, nor blocks the objects after it in
         the list). An HTTP 200 without usable elements is treated the same. Any other non-200 (incl. a 404 with a
         different body), a timeout or a network error stops the sequence → warning, 600 s.
         **To verify after deploy:** that Workers Cache stores a 502 with `public, max-age=600`
         (`cf-cache-status: HIT` on a repeat); Cloudflare's rules for caching error statuses may differ.
      2. *SGP4 failures* were read from `satrec.error` after the search, which a later successful propagation can
         reset. `stateAt` now records the first failure time in the search context; `predictPasses` reports an error
         ("couldn't be propagated from … UTC on") and drops that satellite's passes; `passesAboveHorizon` throws.
         Test: a decaying orbit (16.2 rev/day, high drag) fails ~29 h into the search.
      3. *Visible pieces shorter than the 20-s step were missed* (rising lit and eclipsed within a step, leaving
         the shadow and setting within one, grazing passes above 10° for seconds). Between two consecutive samples
         that are both not visible, `hiddenBetween` handles one below 10° and one above 10° in shadow (bisect the
         10° crossing; if lit there, bisect to the shadow edge), and `grazingPeak` handles a local altitude maximum
         below 10° (golden-section search within one step; then edges, or `hiddenBetween` if eclipsed at the peak).
         Test: a **2-minute** scan finds exactly the passes of a 5-s scan (same edges ± 1.5 s, same causes, 13
         pieces shorter than 2 min), and it fails with the new searches disabled.
      4. The bundle test now also fails on any static (non-`import type`) import or re-export of `src/viz/passes`
         outside tests, and matches `satellite.js` subpaths, `import()`, `require()` and re-exports (self-checked on
         sample strings). `import { type X } from` counts as static: `verbatimModuleSyntax` keeps it.
      5. `passes.ts` uses `addDaysIso` from `shared/apod.ts` instead of its own copy.
- Known limits: standard magnitudes are rough (from McCants' qs.mag via Stellarium's catalogue; ISS −2.5,
  Tiangong 1.87 — probably too faint, may predate its 2022 modules — Hubble 1.5); Heavens-Above and McCants'
  site aren't reachable from the cloud allowlist to cross-check. Real brightness varies by a magnitude or more
  with attitude. Shadow edges ±10 s (no penumbra/atmosphere). SGP4 timing degrades by seconds per day of element
  age, more after a reboost. Cloudflare Workers share outgoing IP addresses, so CelesTrak could block one for
  someone else's traffic; the panel must cope with the source failing (PR 3).

## Lessons learned (v4)
- **Node's built-in `fetch` ignores `HTTPS_PROXY`**: in the cloud container run fixture scripts with
  `NODE_USE_ENV_PROXY=1` (it returned 503s without it). curl works as is.
- **Horizons quantity 4 is airless by default** ("Atmos refraction: NO"), so it compares directly with
  geometric altitudes; quantity 1 is *topocentric* astrometric RA/Dec when `CENTER` is a site.
- **`asin` loses precision near ±90°** (alt at the zenith came out 89.999999°); `atan2(up, horizontal)` doesn't.
- **A night belongs to the observer's longitude, not the clock's time zone**: anything built on wall-clock
  noon breaks when someone looks at a far-away place (or a zone that's hours off solar time, e.g. western
  China). Use solar noon; format in the zone only at the end.
- **CelesTrak answers "not found" with HTTP 404 and bad queries with HTTP 200 + text**, so check the body, not
  just the status. Its tunnel through the cloud proxy resets intermittently; the fixture script retries network
  errors (not HTTP errors, which the usage policy says to stop at).
- **Vallado's reference SGP4 output was made in AFSPC mode** (`opsmode = 'a'` in `testmat.m`); compare in that mode
  or expect the deep-space Lyddane case (23599) to differ. The end of `tmatverDec2015.out` has a stray debug row.
- **Near the zenith, elevation against time is V-shaped**, not parabolic: a parabola through samples misses the
  peak by tenths of a degree, and azimuth swings fastest there (compare directions, not azimuths).
- Horizons takes `STEP_SIZE` as a number of intervals for sub-minute steps (`'10 s'` → "Unknown units").
- Local `npm run dev` in the cloud container can't reach any upstream (workerd ignores `HTTPS_PROXY`); verify
  Worker routes on the Workers Builds preview instead.
- arxiv.org is not on the cloud allowlist; the Mallama & Hilton coefficients were checked against Horizons'
  magnitudes instead (same model).
- **Workers Builds runs `wrangler preview` (open beta) for non-`main` branches**, and it fails unless
  `wrangler.jsonc` has a `previews` block declaring every binding (it failed on this branch from the first
  commit). Previews use `APP_ENV: "preview"` and their own rate-limit namespace (`1002`); they don't get
  the production `NASA_API_KEY` secret (`wrangler preview secret` manages preview secrets).

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
- [x] Deployed (5e1dc69, Workers Builds success) and verified live: `apod-archive` sends
      `public, max-age=86400, s-maxage=2592000` for past weeks (`max-age=1800` for the current week); a
      repeat for another day of the same week is a `cf-cache-status: HIT` with the first answer's
      `fetchedAt` (so `s-maxage` is accepted by Workers Cache); junk parameters share the entry. UI: linked
      5 Apr 2009 (Flash video → "Watch on NASA's site", credit shown), missing 30 Jun 2000 → 29 Jun / 1 Jul,
      8 random days (1997–2022, incl. the "Powers of Ten" YouTube video of 4 Dec 2022), Back to today; WebKit
      (iPhone 390/375/360 dark, desktop) and the in-app browser at 375 px light; no console errors, no
      horizontal scroll.

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
