# Go Wild Tracker

A free, self-hosted tracker for Frontier **GoWild Pass** seats. Scheduled GitHub Actions runs check Frontier's own booking pages, and a web app (installable on your phone) shows the results:

- **Seats left.** For every flight: the GoWild fare, **GoWild seats remaining**, Discount Den fare and seats, and when it was last checked. Seat counts are color-coded with a text label (`1 left`, `4 left`, `Available`, `Sold out`).
- **Everywhere from / Everywhere to.** Every GoWild flight out of, or into, your airport on a date, grouped by airport. You can filter by nonstop, minimum seats, or departure window, and sort by time, price, seats, or duration.
- **Date strip + full calendar.** GoWild counts per day for the next two weeks, plus a 12-month calendar heat map that includes the history kept so far.
- **Day trips ("no hotel").** Out in the morning and back the same night, with GoWild seats both ways, ranked by hours at the destination.
- **Hidden connections.** Two separate GoWild tickets through a connecting airport that Frontier won't sell as one itinerary. Destinations you can *only* reach this way are listed first.
- **Seat and fare history.** Each flight's seats-left and fare over time, and each route's lowest GoWild fare by departure date (60 days kept).
- **Trackr.** Press and hold any flight (or tap ☆) to pin it. Share your Trackr with friends as a link.
- **Scanner health.** The header pill shows data age and whether Frontier blocked the last run.

> Not affiliated with Frontier Airlines. Always confirm on flyfrontier.com before you head to the airport.

## How it works

```
GitHub Actions (every 30 min)
  └─ scraper/run.js  ── headless Chromium ──▶ booking.flyfrontier.com/Flight/InternalSelect
        │  reads window.FlightData (GoWild fare, seats remaining, legs, times)
        ▼
  data branch (JSON, one squashed commit)  ──▶  GitHub Pages site (web/ + data/)
```

- Frontier has no public API. Each origin/destination/date search page embeds its results as JSON, and the scraper reads that with Playwright. Frontier's bot protection rejects plain HTTP requests, so a real browser is required.
- **Scheduling is per page.** Each tier in `config.json` sets how stale a route/date may get. Each run scans the most overdue pages first, nearest dates first, up to `maxPagesPerRun`.
- Routes that keep coming back empty are skipped for a week, and the route network (which nonstops exist) is learned from the results.
- Data lives on a `data` branch that's force-pushed as a single commit, so the repo doesn't grow.

## Setup (one time)

1. **Pages:** go to repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **First scan:** go to **Actions → "Scan Frontier & deploy" → Run workflow**. Leave the inputs blank to scan whatever is due, or set `route` to `DEN-LAS` for a quick one-page test.
3. Open `https://<your-user>.github.io/go_wild/`. On a phone, use **Share → Add to Home Screen**.

After that it runs on its own every 30 minutes, plus extra runs just after midnight in US time zones, when next-day GoWild seats open.

> GitHub pauses scheduled workflows after 60 days with no commits to the repo. If scans stop, push any commit or re-enable the workflow in the Actions tab.

## Configure — `config.json`

| Key | What it does |
|---|---|
| `homeAirports` | Airports scanned **to and from every Frontier airport**. Add a friend's home airport here. Each one adds roughly 250 pages per date. |
| `hubs` | Connecting airports whose nonstops are also scanned, which powers hidden connections. |
| `tiers` | `{ scope: home \| hubs \| routes, daysAhead: [...], everyMinutes }`. Default: today and tomorrow every hour, the next 2–10 days every 12 hours, and hub nonstops every 3 hours. |
| `concurrency`, `maxPagesPerRun`, `maxMinutes` | Volume controls. Lower them to be gentler on Frontier. |
| `abortAfterConsecutiveBlocks` | Stop a run early if Frontier starts blocking. |
| `extraAirports` | Add airports missing from `web/lib/airports.js`: `{ "code", "city", "region", "lat", "lon", "tz" }`. |

With the defaults and one home airport, a steady state is roughly 600–700 page loads per hour. For a lighter footprint, set `daysAhead` to `[0, 1]` only, raise `everyMinutes`, or drop hubs.

## If Frontier blocks GitHub's servers

Bot protection sometimes blocks datacenter IPs. If the status pill says **Scanner blocked**, run the scanner from your own computer, which has a home IP, and push the data:

```bash
npm ci && npx playwright install chromium
git clone --branch data https://github.com/dylanott18/go_wild.git data   # skip if no data yet
npm run scrape
```

Then commit the `data/` folder to the `data` branch, or set up a cron job on a home machine that does this. The Pages workflow picks up the latest data branch on its next run.

## Develop

```bash
npm test          # parser, merge/history, day trips, hidden connections
npm run demo      # FAKE sample data + local server on :8080 to preview the UI
npm run plan      # show what the next scan would fetch, without touching Frontier
npm run scrape -- --route=DEN-LAS --date=2026-11-05 --headed   # watch one real fetch
```

Layout: `scraper/` (Frontier client, scheduler, JSON store) · `web/` (static app, no build step) · `.github/workflows/scan.yml`.

## Caveats

- This automates searches on Frontier's site, which Frontier's terms of service likely prohibit. Use it at personal volume. Search pages don't require login, so the scanner never uses your account.
- Seat counts are as of the last check and can change in seconds. Frontier sometimes shows GoWild availability without a count; the app marks those flights as **Available**.
- If Frontier changes its booking page, the parser in `scraper/frontier.js` may need updating. Runs will show errors in the status panel.
