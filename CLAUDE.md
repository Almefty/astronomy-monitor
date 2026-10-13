# Astronomy Monitor — rules for working on this project

Personal astronomy dashboard: one Cloudflare Worker (`worker/`) serves `/api/*` and a static
TypeScript + D3 frontend (`src/`). Live at https://astronomy-monitor.almefty.workers.dev.
Read `README.md` (architecture, commands) and `TASKS.md` (state, known issues, lessons) first.

## Hard constraints
- **Cloudflare free plan only.** No paid services, no databases (D1/KV/R2/Durable Objects), no cron
  triggers or background jobs. Data is fetched only when the user presses a refresh button — the one
  approved exception is **Live mode** (v2): opt-in, off on every visit, only while the tab is visible,
  per-feed intervals within upstream limits (see `src/core/live.ts`).
- Keep the Worker within the free plan's **10 ms CPU per request**: stream large payloads through
  unparsed (see the exoplanet catalog), and stop parsing once you have what you need.
- **`NASA_API_KEY` is a Worker secret.** Never put it in frontend code, Git, logs, commit messages or
  chat, and never ask the user to paste it. Locally it lives in `.dev.vars` (gitignored); without it
  the app falls back to `DEMO_KEY` and shows a notice. Upstream URLs are redacted (`api_key=***`).
- **Pushing to `main` deploys to production automatically** (Cloudflare Workers Builds). Only push
  when the user asks, and confirm the change on the live site afterwards. GitHub shows the build
  result as a check run ("Workers Builds: astronomy-monitor") on each commit.
- No GitHub/Cloudflare settings changes without asking.

## Working with the user
- The user rarely uses the CLI: give **exact step-by-step instructions**, preferring the Cloudflare
  and GitHub web dashboards; when a command is unavoidable, give one command per code block.
- System-wide installs (Node, Homebrew packages, gh): tell the user what to run; don't install them.
- Verify every source against its live API before relying on it — NASA endpoints have moved before.
- UI language is English. No brand name/logo: the header label is plain "Astronomy Monitor".

## Before calling UI work done
- Check **light and dark mode**, **desktop and phone width** (375 px and 360 px; no horizontal scroll).
- Check the **production build**, not just dev: the CSS minifier has changed output before
  (see TASKS.md lessons). Confirm on the deployed site after pushing.
- One failing data source must never break other panels (each panel isolates its errors).
- Design: no cream/off-white backgrounds, no italic accent words in headings, no "01/02/03"
  section labels, no pill-shaped buttons. Chart colours follow the validated palette in
  `src/styles/tokens.css` (orange→red is reserved for severity).

## Commands
- `npm run dev` — local dashboard at http://localhost:5173 (uses `scripts/dev.mjs`, see TASKS.md)
- `npm test`, `npm run typecheck`, `npm run build`, `npm run check` (all three)
- Commit messages end with the attribution line the harness provides.
