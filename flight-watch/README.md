# Flight Watch 機票監控

A small fare monitor. You pick a few destinations. A GitHub Actions job then scans fares every 6 hours, keeps a price history, flags deals and searches the news for airfare promotions. A static dashboard shows the results, and alerts can go to Telegram or Discord.

![dashboard](docs/screenshots/01-dashboard.png)

## How it works

```
config.yml ──▶ scanner (GitHub Actions, every 6 h) ──▶ data/*.json ──▶ index.html (dashboard)
                     │                                       │
                     ├─ Google Flights: cheapest fare per date pair
                     ├─ Google News RSS: promotion stories per destination
                     └─ Telegram / Discord: new deals and promotions only
```

- **Fares.** For each route the scanner queries every departure day you choose (by default every Friday 14–90 days out, with a 4-night stay). It keeps the cheapest itinerary. Because the departure days are fixed weekdays, the same date pairs come back scan after scan, so each one builds its own price history.
- **Deals.** A fare counts as a deal when:
  - it is at or below the route's `alert_below` target, or
  - it is `drop_pct` % (default 15 %) below the median price of that same date pair over the last `baseline_days`. This check only starts once there are `min_samples` past scans.
- **No repeat alerts.** You hear about a deal the first time it appears, and again only if it gets cheaper. That state is kept in `data/alert_state.json`.
- **Promotions.** The scanner searches Google News for `機票 優惠 <destination>`, plus any RSS/Atom feeds you list. It keeps headlines that name a destination and contain a sale keyword (`買一送一`, `早鳥`, `限時`, …). Syndicated copies of the same story are merged.
- **Data** is committed back to the repo, so GitHub Pages serves the dashboard together with its data. `history.json` is pruned after `history_days`.

## Setup

1. **Pick routes.** Edit [`config.yml`](config.yml): the origin, destinations, target prices, departure days and stay length. Any route can override the `search` settings. For example, a route with `dates: [2027-02-05]` checks only that date, and `stay_nights: [7, 10]` checks two trip lengths.
2. **Alerts (optional).** In the repo, open *Settings → Secrets and variables → Actions* and add:
   - Telegram: `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_CHAT_ID`
   - Discord: `DISCORD_WEBHOOK_URL`
   - Optionally, add a *variable* `FLIGHT_WATCH_DASHBOARD_URL` so alerts link to the dashboard.

   With no secrets set, the scan still runs. Alerts then only appear in the Actions run summary.
3. **Schedule.** [`.github/workflows/flight-watch.yml`](../.github/workflows/flight-watch.yml) runs at minute 17 every 6 hours (UTC). GitHub only runs scheduled workflows from the default branch, so the workflow must be on `main`. You can also start a scan by hand from the Actions tab (*Run workflow*).
4. **Dashboard:** https://andy78644.com/labs/flight-watch/ (once merged and Pages has deployed).

## Run locally

```bash
cd flight-watch
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m scanner.scan --no-notify            # real scan, writes data/
.venv/bin/python -m scanner.scan --only NRT --dry-run   # one route, write nothing
.venv/bin/python -m scanner.scan --provider demo --data-dir /tmp/fw   # offline fake fares
.venv/bin/python -m unittest                            # tests
python3 -m http.server 8000                             # dashboard at http://localhost:8000/
```

## Cost and limits

- **No API key is needed.** Fares come from Google Flights through the open-source [`fast-flights`](https://github.com/AWeirdDev/fast-flights) scraper. It is an unofficial interface: Google can change its page or rate-limit you, and prices can differ a little from what you see at checkout. The scanner waits `delay_seconds` between requests. With the default config, a scan is 44 requests and takes about 3 minutes.
- **If Google blocks the GitHub runners**, a scan with zero fares fails loudly and leaves the last good data in place. In that case, run the scanner on your own machine with cron, or add another provider in `scanner/providers.py`. A provider is one class with a `search()` method.
- **Promotions come from news headlines**, not from airline sites, so a sale shows up once a news site writes about it (usually the same day for big sales). Google News RSS is for personal, non-commercial feed reading. That fits this use, but don't republish the feed.
- **Scan frequency vs. repo size:** each scan adds one small commit. Every 6 hours, the data stays well under 1 MB with 180 days of history.

## Files

| Path | What it is |
|---|---|
| `config.yml` | routes, search window, alert rules, promotion keywords |
| `scanner/scan.py` | entry point: one full scan |
| `scanner/providers.py` | Google Flights provider, plus a demo provider |
| `scanner/deals.py` | median baselines, deal rules, alert de-duplication |
| `scanner/promos.py` | Google News / RSS promotion watcher |
| `scanner/notify.py` | Telegram, Discord and Actions-summary output |
| `data/latest.json` | the latest scan (what the dashboard draws) |
| `data/history.json` | per-route, per-date price history |
| `data/promos.json` | recent promotion headlines |
| `index.html` | the dashboard (no build step) |
