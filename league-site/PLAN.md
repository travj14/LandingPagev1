# League Site — Plan

Goal: a **live, always-current league site** for Booty Lickers Unite. The weekly recap is a snapshot of one week, and this site answers "where does everything stand *right now*?" any time someone opens it.

League rules (Team 8 = bye, owner mapping, PF tiebreaker, pick order) are in `important_info.md`. The compute code (standings, Max PF, odds, picks) started as a copy of the weekly recap's, whose `PLAN.md` describes how each is calculated.

---

## 1. Scope

### In
- Home: live scoreboard, countdowns, auto headline, this week's playoff stakes
- Standings, playoff odds, what-if simulator, clinch/elimination, odds-over-time, power rankings, all-play and luck
- Matchups: matchup pages, head-to-head grid, rivalry pages, points left on the bench
- Team / owner pages, roster, draft capital, career stats, trophy case
- Transactions: trade log, waiver/FA feed, activity leaderboard
- Rookie draft order projection (standings + Max PF + traded picks)
- History: live record book, season archive, "this week in league history", milestones
- Weekly awards, Hall of Shame, recap archive, pool display
- Site features: mobile-first, bottom tabs, deep links, avatars, add-to-home-screen, caching, **Apple style and smooth scroll both switchable off**

### Out (by request)
- Live in-game **win probability**. Deferred, not cancelled. When it's built it uses the game models in §3.
- "Who won the trade" grading
- Trade analyzer
- Draft board and all other draft features: no live draft, no draft hindsight/steals/busts. **The only draft feature is the rookie draft order projection.**
- Trash talk / pick'em board
- Survivor pool and side bets

With pick'em and side bets out, **nothing needs user accounts or a database.** The server only reads from Sleeper and caches.

---

## 2. Architecture

The site is a **Node.js app on the Contabo server**. The server does all the fetching and math. The browser only renders pages and calls the server's API.

**Self-contained folder:** everything lives in `league-site/`, with its own `package.json`, server, front end, scripts, `.env` and data cache. It imports nothing from outside the folder, so it can be moved into the main repo as-is. The recap editor (`blu/`) stays separate and local, on port 3456; the site defaults to port 3457.

**Shared code is copied, not linked:** `config`, `types`, `sleeper`, `history`, `standings`, `odds`, `picks` and `refresh` were copied from the recap's `server/`, and more modules (`records`, `storylines`, `pool`) get copied when a phase needs them. Fixing a calculation bug means fixing it in both projects.

```
league-site/
├── start.sh  restart.sh  stop.sh  refresh.sh
├── package.json  tsconfig.json  .env.example  .gitignore
├── PLAN.md  README.md  important_info.md
├── scripts/common.sh        # shared setup for the .sh scripts
├── server/                  # Sleeper client, cache, history, standings, odds, picks, refresh (copied from the recap)
│   ├── site.ts              # public site server — read-only API + static files (built: skeleton)
│   ├── models.ts            # NEW: game models (coin flip / last-8 sample) — §3
│   └── sim.ts               # NEW: playoff odds, stakes, what-if, clinch, pick odds
├── site/                    # NEW: public front end
│   ├── index.html           # app shell, bottom tab bar
│   ├── js/main.js           # router (#home, #standings, #team/henry, #week/9 …)
│   ├── js/pages/*.js        # one module per tab
│   ├── site.css             # themes/tokens copied from the recap's blocks.css + mobile-page.css
│   └── recaps/              # exported weekly recap PNGs for the archive
├── logs/                    # server.log (not in git)
└── data/
    ├── site.config.json     # NEW: site defaults (apple, smoothScroll, glide, reveal, model, theme)
    └── cache/               # Sleeper cache (not in git)
```

**Read-only:** the public site has GET endpoints only, plus the token-protected refresh. Nothing writes files except the Sleeper cache. The recap editor, which can save and delete layouts, **never goes public**.

**Data:** the server already fetches and caches Sleeper data (`server/sleeper.ts`, `history.ts`), including past seasons, the player DB, weekly stats and the pool price. The site reuses all of it. Nothing has to be baked, exported or re-uploaded.

**Refresh schedule** (built, in `server/refresh.ts`):
- **Nightly at midnight Eastern** (`REFRESH_TZ`, default `America/New_York`), a **full history refresh**: every season, every week, transactions, traded picks, stats, projections and the player DB are re-downloaded from Sleeper, ignoring all caches. Finished seasons are included, so stat corrections get picked up.
- **On demand:** force the same full refresh any time:
  - `npm run refresh` on the server. It asks the running server to refresh so its memory updates too. If no server is running, it refreshes the disk cache directly.
  - Or `POST /api/admin/refresh` (add `?wait=1` to wait for the result). `GET /api/admin/refresh` shows the last run's status, time taken and any error.
  - Protected by `REFRESH_TOKEN` (`Authorization: Bearer <token>`). With `NODE_ENV=production` a token is **required**, because behind nginx every request looks local. In development, requests from the same machine are allowed without one.
- While a refresh runs, visitors keep getting the previous data, then the new data swaps in. A full refresh currently takes about 1 s.
- **Between refreshes, the current week's scoreboard stays live** (Sleeper data cached about 60 s during games). Without that, the live scoreboard would show last night's scores.

**API (examples):** `/api/site/home`, `/api/site/standings?model=sample`, `/api/site/whatif?model=coin&picks=…`, `/api/site/team/:owner`, `/api/site/week/:season/:week`, `/api/site/h2h`, `/api/site/records`, `/api/site/picks?model=…`. Results are cached per (data version, model, picks), so repeated views are instant.

**Why compute on the server:** it's a single TypeScript codebase with no browser bundling, and the copied recap logic is used directly. Sims are fast in Node: exact coin-flip enumeration over 2¹⁸ outcomes takes well under a second, and so does a 50k-run Monte Carlo. What-if clicks are debounced and cached.

**Browser:** caches the last response in `localStorage` (wrapped in try/catch), shows it instantly, then refreshes. While a game is live, the scoreboard re-fetches about every 60 s. A small service worker handles add-to-home-screen.

**Deployment (Contabo):**
1. Move the `league-site/` folder into your main repo and push. Its `.gitignore` already keeps out `node_modules`, the cache, logs and `.env`.
2. On the server: install Node ≥ 23.6 (the code runs TypeScript natively; use the same major version as local), then pull the repo. `start.sh` installs dependencies itself.
3. In `league-site/`, copy `.env.example` to `.env` and set `NODE_ENV=production`, `PORT` and `REFRESH_TOKEN`. Start with `./start.sh`, update with `./restart.sh --pull`, refresh history with `./refresh.sh`. To survive crashes and reboots, also add a **systemd** service (or an `@reboot` cron running `start.sh`).
4. Put **nginx** in front as a reverse proxy, with HTTPS from Let's Encrypt (certbot), serving the site at the root of **payrollgm.com** (main page).
5. Update with `./restart.sh --pull`, which pulls (it works from inside any git repo), reinstalls dependencies if they changed, and restarts.
6. When a phase needs `data/manual.json` (deadline, pool settings), it's copied into `league-site/data/` and committed.

---

## 3. Game Models

Everything probabilistic uses one shared setting, **Model**, switchable on the Standings page:

| Model | How a game is decided |
|---|---|
| **Coin flip** (default) | Every remaining game is 50/50. Matches the recap. |
| **Last 8 sample** | Each team draws a random score from its **last 8 games played**. The higher score wins. |

Last 8 sample details:
- The sample is the team's 8 most recent games, **playoff and consolation weeks included**. Any week the team has a recorded score counts.
- **When a team has fewer than 8 games this season** (early in the year), fill in with its most recent games from **last season**, matched by owner rather than roster_id. Example: in Week 3, 2 games come from this year and 6 from the end of last year.
- **Last-season games count less.** Offseason roster turnover makes them weaker evidence. Each draw picks a week with probability proportional to its weight: this season = 1, last season = `offseasonWeight` (default **0.5**, set in `site.config.json`).
  - Example: in Week 3, the 2 current games carry 2 / (2 + 6×0.5) = 40% of the draws, even though they're only 25% of the games.
  - By Week 9 the sample is all current season, so the weight no longer matters.
- Each draw is a whole past week, so the team's **PF and Max PF come from the same week**. That makes the sim produce realistic PF for the tiebreaker and Max PF for the pick order.
- A bye week (vs Team 8) still counts as a sample, since the team still scored.
- An exact tie in drawn scores is a tie result, which is effectively rare.

Engine:
- **Coin flip:** exact enumeration when ≤ 2²⁰ outcomes remain (about the last 6 weeks), otherwise 50,000-run Monte Carlo. As in the recap, ties on record split the remaining playoff spots.
- **Last 8 sample:** 50,000-run Monte Carlo. Ties on record are broken by **simulated PF**, which is the real tiebreaker.
- Runs on the server and is cached, so phones never do the heavy math.

These feed: playoff odds, matchup stakes, the what-if simulator, clinch/elimination, odds-over-time and rookie pick odds.

**Win probability (deferred):** the plan, when it's built, is a pregame percentage per matchup from the selected model. Coin flip = 50%. Last 8 sample = each team's weighted share of wins across all pairings of their sampled weeks. No live in-game bar until you decide otherwise.

---

## 4. Pages

Bottom tabs: **Home · Standings · Matchups · Teams · History**

### 4.1 Home
- **Live scoreboard:** this week's matchups with current score, players left to play, and Sleeper projections (shown as projections, not win %). Updates during games.
- **Countdowns:** next kickoff, trade deadline (`manual.json` time), playoffs start (Week 15), rookie draft.
- **Auto headline:** one line from the biggest change, using the recap's storyline engine (e.g. "Henry jumps into the 4th seed").
- **This week's stakes:** every matchup's combined playoff-odds swing under the selected model, sorted biggest first. Same math as Matchup of the Week (odds with each side winning, swings added together).
- **Weekly awards** (last completed week): high score, low score, biggest blowout, closest game, Lucky Win (won below the league median), Unlucky Loss (lost above the median).

### 4.2 Standings
- Table: seed, record (bye games excluded), PF, Max PF, playoff odds %, streak, plus the "outside the cut" line.
- **Model toggle:** Coin flip / Last 8 sample.
- **What-if simulator:** tap a winner for any remaining game, and the standings, seeds and odds recompute instantly. "Reset" clears picks. Picks are kept in the URL hash so a scenario can be shared.
- **Clinch / elimination:** "clinched", "eliminated", or "clinches with N more wins" (worst case, model-independent).
- **Odds over time:** line chart of each team's odds by week, recomputed as of each week.
- **Power rankings:** a weighted mix of all-play win %, PF and the last-3-weeks trend. Formula shown on the page.
- **All-play record and luck index:** actual wins minus all-play expected wins.

### 4.3 Matchups
- **Week browser:** any week of any season, with results, lineups, and points left on the bench (Max PF − PF) per side. Flags games lost because of the lineup (the loser's optimal lineup would have won).
- **Matchup page:** both lineups, optimal-lineup comparison, H2H record, last meeting.
- **H2H grid:** 7×7 all-time regular-season records (playoffs separate). Tap a cell to open the rivalry.
- **Rivalry page:** series record, every meeting, biggest blowout, closest game, current streak.

### 4.4 Teams
- **Owner page:** avatar, team name, roster grouped by position, record, PF/PA, a weekly score chart, best and worst week, current streak.
- **Draft capital:** every future pick the team owns (via `traded_picks`), with the projected slot for this year's picks.
- **Career:** all-time record, playoff appearances, titles, best season.
- **Trophy case:** championships, weekly high scores, records currently held (from the record book).
- **Transactions:** this team's trades and adds/drops.

### 4.5 Transactions (inside Teams, plus a league-wide feed)
- **Trade log:** every trade, showing who got what. No grading.
- **Waiver/FA feed:** adds and drops with FAAB, and points the player has scored for the team since the add.
- **Activity leaderboard:** trades, adds and FAAB spent per team.

### 4.6 Rookie Draft Order Projection (inside Standings)
- **"If the season ended today":** non-playoff teams by **lowest Max PF first** (picks 1–3), then playoff teams in **reverse standings** (picks 4–7). 7 picks per round, none for Team 8. Same rule as `server/picks.ts` (copied from the recap).
- **Traded picks applied:** each slot shows its current owner and original team, e.g. "1.02 — Travis (via Antonio)". All 5 rounds, with rounds 2–5 collapsed.
- **Pick odds:** a grid from the selected model's sim showing each team's chance of landing each slot. Under coin flip, Max PF is projected forward at each team's current per-game pace. Under last 8 sample, it comes from the drawn weeks.
- Simple list/cards UI. No draft board.

### 4.7 History
- **Record book:** the existing 73 records, live and searchable, with the same groups, good/bad dots and active streaks.
- **Season archive:** final standings, playoff bracket and champion for each season.
- **This week in league history:** results and notable moments from the same week in past seasons.
- **Milestones:** upcoming round numbers, such as career PF, wins or 200-point games ("Travis is 12 pts from 10,000 career PF").
- **Hall of Shame:** lowest scores, worst lineup losses, biggest blowouts suffered.
- **Recap archive:** your exported weekly recap PNGs, listed by week (dropped into `site/recaps/`).
- **Pool:** current value, priced live by the server (same as the recap's pool block).

---

## 5. Look & Feel

- Mobile-first, reusing the mobile editor's themes, fonts and tokens, copied in from the recap's `mrender.js` THEMES, `blocks.css` and `mobile-page.css`. Light and dark.
- **Apple style:** frosted cards, hairlines, pill buttons, springy taps. **On/off.**
- **Smooth scroll:** momentum glide copied from the editor (`smoothScroll` in the recap's `mrender.js`), with a glide strength amount. **On/off.**
- **Reveal-on-scroll fade.** On/off.
- How the switches work:
  - **Site defaults** in `data/site.config.json` (`apple`, `smoothScroll`, `glide`, `reveal`) set what everyone gets.
  - A **Settings sheet** (gear icon) lets each viewer override them on their own device, saved in `localStorage`.
  - `prefers-reduced-motion` turns smooth scroll and reveal off automatically.
  - With smooth scroll off, the page uses plain native scrolling and the glide script never loads.
- Deep links for every page (`#team/henry`, `#week/2026/9`, `#rivalry/josh-henry`, `#whatif/…`).
- Add-to-home-screen manifest and icon.

---

## 6. Build Phases

**Status (Nov 4, 2026):** phases 1–9 built. Every tab works on phones and desktop (≥1000px: sidebar navigation and a two-column layout). Only deployment (phase 10) is left.

Phase 9 added: home-screen install (manifest, icons, service worker for the app shell), link previews (`og:` tags, `site/icons/og.jpg`), per-page tab titles, loading skeletons, friendly error/404 pages with Try again, an offline banner, a "data as of" footer, gzip, cache warm-up at start and after every refresh, `/healthz`, reduced-motion support, visible keyboard focus, and desktop shortcuts (1–5 tabs, ←/→ weeks, `/` record search). Also: roster GS / PPG / Win% when started, the league pool beside the home headline, "Newest record" / "Newest top-3 entry" sorts in the record book, and milestones reached each week (Home and History → More).

Server: `sim.ts` (both models, exact enumeration, clinch/magic numbers, pick-slot odds), `models.ts` (last-8 pools), `api.ts` (Home/Standings/draft JSON, cached by a fingerprint of completed games and transactions), `teams.ts`, `matchups.ts`, `archive.ts` (record book, seasons, history, milestones, Hall of Shame, recaps, pool), `records.ts` (copied from the recap), `pool.ts`, `siteConfig.ts`. `history.ts` now also loads rosters, every transaction, winners brackets and avatars.

Front end (`site/js/`): `main.js` router, `settings.js` (themes, sheet), `chart.js`, and one module per tab in `pages/`.

Verified: coin-flip odds match the recap's numbers exactly; Week 9 Josh–Henry stakes are 67.0 pts (coin) / 71.8 (last 8); what-if agrees with the stakes math; Henry shows as 2025 champion; all 11 page types render without errors at 375px and desktop widths.

Notes: Sleeper fills in the current season's bracket from live standings, so brackets only count once a season's playoffs start. Unfinished simulated odds show ">99.9%" / "<0.1%" instead of 100% / 0% unless clinched or eliminated.

1. ✅ **Foundation:** `server/site.ts` (read-only API + static files), `site/` shell, router, bottom tabs, Settings sheet (Apple / smooth scroll / reveal toggles), config, browser cache.
2. ✅ **Standings:** table, coin-flip odds (verify they match the recap exactly), clinch/elimination, rookie draft order projection with traded picks.
3. ✅ **Game models:** last-8 sample (playoffs included, weighted last-season backfill), server-side sim + cache, model toggle, pick odds.
4. ✅ **Home:** live scoreboard, countdowns, stakes, headline, weekly awards.
5. ✅ **What-if simulator** and odds over time.
6. ✅ **Teams:** owner pages, draft capital, career, trophy case, transactions feed, activity leaderboard.
7. ✅ **Matchups:** week browser, bench points, H2H grid, rivalry pages.
8. ✅ **History:** record book, season archive, this week in history, milestones, Hall of Shame, recap archive, pool.
9. ✅ **Polish:** power rankings, all-play/luck, service worker, home-screen install, performance pass.
10. **Deploy:** git repo, Contabo setup (Node, pm2/systemd, nginx, HTTPS), deploy script.

Each phase is usable on its own, so the site can go live after phase 2.

---

## 7. Decisions

- Hosted as a Node.js app on the Contabo server, from the self-contained `league-site/` folder, which gets moved into the main repo. The recap editor stays local; the public site is read-only.
- The site lives on the main page of payrollgm.com.
- The server fetches, caches and computes everything. Full history refresh nightly at midnight ET, or forced with `npm run refresh` / `POST /api/admin/refresh`. The current week stays live.
- No accounts, no database.
- Default model is coin flip. The other model is last 8 sample: playoff weeks included, last-season backfill weighted 0.5. No other models.
- Matchup and playoff probabilities only. No live in-game win probability for now.
- The only draft feature is the rookie order projection: standings + Max PF + traded picks.
- No trade grading, trade analyzer, draft board, pick'em, survivor pool or side bets.
- Apple style, smooth scroll and reveal are each switchable, both site-wide and per viewer.

## 8. Open Questions

- **Other apps on the Contabo box:** something already runs there. Before deploying, work out how it shares nginx, the ports and payrollgm.com's main page with this site.
