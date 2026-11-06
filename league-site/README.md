# League Site

Live league site for Booty Lickers Unite (Sleeper dynasty), going on payrollgm.com. The plan is in `PLAN.md`, and the league rules are in `important_info.md`.

This folder is self-contained: it has its own dependencies, server, scripts and data cache, and imports nothing from outside it. Move it into another repo as-is.

## Run

Needs Node 23.6 or newer (the server runs TypeScript directly, with no build step).

```bash
cp .env.example .env   # optional locally; required on the server (NODE_ENV=production, REFRESH_TOKEN)
./start.sh             # start in the background (installs dependencies first if needed) → http://localhost:3457
./restart.sh           # restart after an update
./restart.sh --pull    # git pull first, then restart (works from inside any git repo)
./stop.sh              # stop
./refresh.sh           # force a full re-download of all league history from Sleeper
```

Logs go to `logs/server.log`. History also refreshes automatically every night at midnight Eastern (`REFRESH_TZ`).

For development, `npm run dev` runs in the foreground and restarts on server file changes.

## Site settings

`data/site.config.json` sets the site-wide defaults: title, theme, Apple style, smooth scroll and glide, fade-in, the default odds model, the last-8 sample size and last-season weight, and the trade deadline / rookie draft times for the countdowns. Edits apply within 10 seconds, without a restart. Visitors can override the look and the model for themselves from the gear menu.

## Recap archive

Drop exported weekly recap images into `site/recaps/`, named like `2026-week-08.png`. They show up under History → More, newest first.

## Projections page

`/projections` (payrollgm.com/projections) shows this week's matchups for BLU and El Diablo with projected scores, win chances and per-player projections, plus standings with playoff and last-place odds. The code is `server/projections.ts` and `site/js/projections.js`.

- It runs the `~/blu/projection-system` method in Node: each starter's outcomes come from the 200 historical player-games with the nearest Sleeper projection (2022–2024), scaled so the average equals their Sleeper projection under the league's scoring. 100,000 simulations per matchup.
- Those historical outcomes live in `data/pools/blu.json` and `data/pools/diablo.json`. If a league changes its scoring, the log warns; re-export with `python3 scripts/export_pools.py --league blu=<id> --league diablo=<id>` from `projection-system`.
- Projections are frozen when each NFL game kicks off (`data/cache/kickoff-projections/`). During a game, the unplayed share is scaled by the clock from ESPN's scoreboard.
- A starter ruled Out, Doubtful, IR, suspended or on PUP (Sleeper's latest status, so it also catches in-game rulings) keeps his points so far and is projected 0 from there.
- Refreshes are shared by every viewer. Automatic ones run only on game days: at 12:30am Central the server looks up that day's games, then refreshes every 10 minutes on the clock from the first kickoff until all of that day's games are final (one last refresh after). Anyone can press Refresh any time once the 1-minute cooldown after the last refresh ends. The server also refreshes once at start.

## Production notes

- `GET /healthz` returns 200 once league data has loaded (503 before). Point nginx or uptime checks at it.
- Set `SITE_URL` (e.g. `https://payrollgm.com`) so link previews in group chats use the right address.
- Responses are gzipped, and the expensive pages are pre-computed at start and after every refresh.
- The app icons and link-preview image live in `site/icons/`. Bump `VERSION` in `site/sw.js` if you ever change files the service worker caches and see stale copies.
