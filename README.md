# AragoCor Opportunity Engine

Internal dashboard of **open** procurement opportunities (RFPs, tenders)
matched to AragoCor grades. Separate from the aragocorminerals.com site.

- Pulls live notices from **SAM.gov, CanadaBuys, EU TED and the World Bank**,
  keeps only those still accepting responses, and removes each one when its
  deadline passes.
- Directory of 31 more government and private-sector portals, with a form to
  log RFPs found there so they get the same deadline tracking.
- Shared team workspace: stars, notes, logged RFPs, hidden notices and search
  settings sync across devices and people.
- Password protected. Proposal drafts use only AragoCor's verified technical
  figures.

## Deploy (one time, about 10 minutes)

1. **Import the repo into Vercel.** Vercel → Add New → Project → import
   `aragocor-opportunity-engine`. Framework preset: **Other**. No build command.
   Click Deploy. (It will say the dashboard is locked — that's expected.)
2. **Add environment variables** (Settings → Environment Variables, tick
   Production and Preview):
   - `DASHBOARD_PASSWORD` — the team password (required)
   - `SAM_API_KEY` — from SAM.gov → Account Details → Public API Key
   - `RFP_KEYWORDS` — optional, locks the search keywords
3. **Add shared storage.** Storage → Create Database → **Upstash for Redis**
   (free plan) → connect it to this project. Vercel adds the connection
   variables itself.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect.
5. **Check it:** open `https://<your-project>.vercel.app/api/health`. It should
   show `"ok": true`, and each feed with `"ok": true`.
6. **Open the dashboard,** sign in with your name and the team password, and
   click **Sync feeds**.

Optional: add a repository secret `SAM_API_KEY` (GitHub → Settings → Secrets
and variables → Actions) so the daily feed check also tests SAM.gov (uses one
request a day).

## How it stays working

- **Daily feed check** (`.github/workflows/feed-check.yml`): runs the tests and
  calls every live feed each morning. If a feed goes down or changes format the
  run fails and GitHub emails you. The full report is on the `feed-check` branch.
- **`/api/health`** (public, no password): configuration flags and a live check
  of each feed. Add `?detail=1` for raw samples.
- **Caching:** each feed is cached on the server (SAM.gov for 8 hours, others 3),
  so syncing often doesn't spend the SAM.gov key's daily requests (10 a day on
  accounts without an entity role, 1,000 with one).
- **Offline-safe:** changes made while the workspace is unreachable are kept in
  the browser and sent when it's back.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The dashboard (no build step) |
| `middleware.js` | Password protection for every path except `/api/health` |
| `api/opportunities.js` | Live feeds, normalised and cached |
| `api/state.js` | Shared workspace (Upstash Redis) |
| `api/health.js` | Status and feed check |
| `lib/feeds.js` | Feed fetchers and parsers |
| `lib/store.js` | Redis REST client |
| `lib/diagnose.js` | Feed checks used by `/api/health` and the daily check |
| `scripts/test.mjs` | Offline tests (`npm test`) |
| `scripts/check-feeds.mjs` | Live feed check (`npm run check-feeds`) |

## Grade data

The grade library and proposal drafts mirror `data/technical-values.json` in the
aragocor-site repository: figures are representative analyses or published
ranges, never guaranteed minimums, and no certification is claimed beyond the
OMRI crop-fertilizer listing for AG-CAL. If the registry changes, update the
`GRADES` and `COMMON_SPECS` blocks in `index.html` to match.
