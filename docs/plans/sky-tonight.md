# Plan: "Sky tonight" panel (version 4)

A new panel that answers *"what can I see from where I am tonight?"*: when it gets dark, the Moon,
which planets are up and how bright they are, visible passes of the ISS and other bright
spacecraft, and a local sky dome showing all of it. Every other panel shows what the universe is
doing; this is the first one about the visitor's own sky.

Read `CLAUDE.md` and `TASKS.md` first. Every hard constraint there applies (free plan, 10 ms CPU,
fetch only on a button press, panels isolate their errors, light/dark and 375/360 px checks,
English UI, the design rules).

The work lands as **three pull requests** against `main`, each small enough for a full review
(well under 8,000 changed lines). PR 1 starts from `feature/sky-tonight` (the branch holding this
plan, so the plan merges with it); PR 2 and PR 3 start from `main` after the previous PR is merged.
Do not push to `main`: pushing there deploys.

---

## Principles

- **Computed in the browser.** All positions, rise/set times and passes are computed client-side,
  like the 3D Solar System. The Worker only relays spacecraft orbital elements.
- **The location never leaves the browser.** It is not sent to `/api`, not put in the URL, not
  logged. It is kept in `localStorage` (via `src/core/storage.ts`) so the panel remembers it, rounded
  to 0.01° (~1 km). Say so in the panel ("Your location stays in this browser").
- **Location is opt-in.** No geolocation prompt on page load. The panel offers: "Use my location"
  (Geolocation API, only on press), manual latitude/longitude, and a short list of preset cities
  (include Jakarta, plus one high-latitude and one southern city). Until one is chosen, the panel
  shows a short explanation and the picker, not an error.
- **Honest accuracy.** Like the 3D panel, label what is approximate (e.g. "times ±1–2 min",
  "brightness estimated"). Don't present model output as official.
- **Reuse before adding.** `shared/orbit.ts` already has planet heliocentric positions (JPL Table 1),
  `earthPosition`, and the Moon (Meeus ch. 47). `shared/astro.ts` has `julianDate`, `obliquity`,
  `eclipticToEquatorial`, a low-precision `sunPosition`, `angularSeparation`. Build on them; keep
  `test/orbit.test.ts` passing.

---

## PR 1 — Topocentric astronomy math (no UI)

Branch `feature/sky-tonight-math`. New module `shared/sky.ts` (no DOM, no three.js), tests in
`test/sky.test.ts`.

1. **Time and frames**
   - Greenwich and local sidereal time (IAU 1982 GMST is enough).
   - Geocentric equatorial position of each planet: `planetPosition(id) − earthPosition()`,
     ecliptic J2000 → equatorial J2000 (obliquity at J2000), with light-time correction (one iteration).
   - Precession J2000 → date (IAU 1976 is enough; ~0.36° in 2026, too big to ignore near the horizon).
   - Equatorial → horizontal (altitude, azimuth from north through east) for an observer
     (latitude, longitude, height optional).
   - Standard refraction for apparent altitude (Bennett/Saemundsson), applied only for display and
     rise/set, not to geometric positions.
2. **Sun** — a better solar position than `sunPosition` in `shared/astro.ts` (Meeus ch. 25 low-accuracy
   is fine, ~0.01°). Leave the existing function alone; the telescope panel uses it.
3. **Moon**
   - Topocentric correction (parallax up to ~1°; matters for rise/set and the dome).
   - Illuminated fraction, phase angle, waxing/waning, phase name; age since new moon.
4. **Planet brightness** — apparent visual magnitude for Mercury–Neptune (Mallama & Hilton 2018;
   Saturn's ring term may be simplified, document it). Also elongation from the Sun, so the panel can
   say "too close to the Sun".
5. **Events for one night** (local evening → next morning, in the observer's time zone)
   - Sunset/sunrise (−0.833°), civil/nautical/astronomical twilight (−6/−12/−18°).
   - Rise/transit/set for the Moon (topocentric, −0.833° with parallax) and planets (−0.5667°).
   - A generic root finder on altitude(t) (coarse 10-min steps + bisection) that handles
     "never rises" / "never sets" / polar day and night, with explicit result states, not NaN.
   - Time zone: use the browser's `Intl` for preset cities via an IANA zone stored with each city;
     for manual coordinates, use the browser's own zone and say which zone is shown.
6. **Tests** against independent sources, saved as fixtures in `test/fixtures/` (same pattern as
   `test/orbit.test.ts`; record source and date in each file):
   - JPL Horizons API observer tables (`QUANTITIES='1,4,9,10'`: RA/Dec, apparent az/el, visual
     magnitude, illuminated fraction) for the Moon, Venus, Mars, Jupiter, Saturn at three observers:
     Jakarta (−6.2, 106.8), Tromsø (69.65, 18.96), Cape Town (−33.92, 18.42), several dates.
   - USNO's rise/set/twilight API (`aa.usno.navy.mil/api/rstt/oneday`) for the same places, including a
     polar-day date for Tromsø.
   - Target tolerances: positions ≤ 0.1° for planets, ≤ 0.2° for the Moon; event times ≤ 2 min;
     magnitudes ≤ 0.2 (looser for Saturn if the ring term is simplified; document it).

## PR 2 — Spacecraft elements and visible passes

Branch `feature/sky-tonight-satellites`, from `main` after PR 1 is merged.

1. **Worker source `satellites`** (`worker/sources/satellites.ts`, registered in
   `worker/sources/index.ts`; new `SatellitesData` type and `SourceId` in `shared/contract.ts`).
   - Upstream: CelesTrak GP data in OMM JSON,
     `https://celestrak.org/NORAD/elements/gp.php?CATNR=<id>&FORMAT=json`. Verified live 2026-11-01:
     ISS = 420 bytes; it sends no `Cache-Control`.
   - A fixed, small list: ISS (25544), Tiangong (48274), Hubble (20580). Keep the list in one place
     with each object's standard magnitude (for brightness estimates). Do not fetch whole groups
     (`GROUP=visual` is 156 objects / 65 KB with no magnitudes) unless a later version needs it.
   - **CelesTrak's usage policy**: elements update roughly every 2 hours and they block clients that
     download the same data more often. Set `maxAge` to at least 2 hours (7,200 s), and fetch the list
     in as few upstream calls as the API allows. Check the policy page for the current rule before
     choosing the number and note it in TASKS.md.
   - Slim the response to the fields SGP4 needs plus name, ID and epoch. Warn (notice) if an epoch is
     older than 7 days: predictions degrade fast.
   - Tests with a saved fixture, like `test/worker.test.ts`.
2. **Client-side SGP4**
   - Use the `satellite.js` package (MIT). It must stay out of the main bundle: only the sky panel
     loads it with `import()`, like three.js in the 3D panel. Check that the installed version can read
     OMM JSON directly; if not, convert OMM fields to its satrec input in one small function.
3. **Visible-pass prediction** for tonight (and the next 3 nights, so the list is rarely empty):
   - A pass is **visible** when the spacecraft is above 10°, it is sunlit (not in Earth's shadow;
     a cylindrical shadow is enough, say so), and the observer's Sun is below −6°.
   - For each pass: start/peak/end time, azimuth at each (compass point too), peak altitude, and an
     estimated peak magnitude from the standard magnitude, range and phase angle.
   - Step at ~20 s, refine peak and edges by bisection. Keep it fast: a 4-night search for 3 objects
     should run well under 100 ms on a phone; measure and note the time in TASKS.md.
   - Tests: SGP4 against the Vallado test vectors shipped with or documented for satellite.js; pass
     times for the ISS against JPL Horizons (check whether Horizons serves the ISS as a target, e.g.
     ID −125544, for a topocentric az/el table; if not, record what was used instead).

## PR 3 — The panel

Branch `feature/sky-tonight-panel`, from `main` after PR 2 is merged. `src/panels/sky.ts`, registered in
`src/panels/index.ts` (place it right after the APOD panel; decide `span` by how it lays out).

1. **Loading model.** Planet, Moon and Sun data need no network: decide with `PanelHost`
   (`src/core/panel.ts`) whether the panel computes immediately once a location exists, and only the
   spacecraft part waits for a refresh press (preferred), or whether the whole panel follows the normal
   refresh. Either way the "fetch only on a press" rule holds for `/api/sources/satellites`, and a failed
   satellite fetch must leave the rest of the panel working.
2. **Content**
   - Location row: the picker described in Principles, current place name or coordinates, time zone.
   - "Tonight" summary: sunset, darkness (astronomical twilight) start/end, sunrise; Moon phase
     (illustration drawn in SVG), illumination, rise/set. Handle polar day/night with plain sentences.
   - Planets: one row per planet: visible tonight or not (and why: below the horizon, too close to the
     Sun, only in daylight), best time, direction, max altitude, magnitude.
   - Passes: the next visible passes, with a "brightest" marker; empty state that explains when the
     next one is.
   - **Sky dome**: an SVG all-sky view (zenith in the centre, horizon as the circle, N up and E left as
     seen looking up; label it). Planets, Moon and Sun when up, and the selected pass's track. A time
     slider across tonight (sunset → sunrise) with "Now". Use `src/viz/tooltip.ts` for hovers. Colours
     from `src/styles/tokens.css`; orange→red stays reserved for severity.
   - Optional, if it stays simple: Webb/Hubble targets above the horizon, read from the telescope panel's
     saved result. Skip it if it couples the panels.
3. **"Right now" strip summary** — e.g. "Next ISS pass 19:42, mag −3.1" or "Moon 64%, Jupiter up".
4. **Accessibility** — the dome has a text equivalent (the planet and pass lists), keyboard-usable
   slider, and `prefers-reduced-motion` respected.
5. **Docs** — README: a "What it shows" row, the CelesTrak and JPL credit lines, the privacy note about
   location. TASKS.md: a "Version 4 — Sky tonight" section in the existing style (source verification,
   build log, known issues, lessons learned).
6. **Checks before calling it done** — the full "Before calling UI work done" list in CLAUDE.md,
   including the production build (`npm run check`), light/dark, 375 px and 360 px, and a location in
   each hemisphere plus a polar case.

---

## Running this in cloud sessions

- The cloud environment's network allowlist must include the upstreams used for fixtures and
  verification: `celestrak.org`, `ssd.jpl.nasa.gov`, `ssd-api.jpl.nasa.gov`, `aa.usno.navy.mil`
  (plus the npm registry for `satellite.js`). If a domain is blocked, stop and report it rather than
  inventing fixture values.
- One PR per session. Each session ends with: `npm run check` passing, the branch pushed, a pull request
  opened against `main` with a summary of what was verified and against what.
- After each PR is opened, the maintainer runs `/code-review ultra <PR number>` and the findings are
  fixed on the same branch before merging.
