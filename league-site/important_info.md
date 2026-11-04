# Important Info — Booty Lickers Unite (Sleeper Dynasty)

## League IDs
| Season | League ID | Status |
|---|---|---|
| 2026 (Year 2) | `1311995439410581504` | in season |
| 2025 (Year 1 / Startup) | `1231390002533896192` | complete |

The previous season's ID is available from the API at `previous_league_id` on the league object.

## Team 8 = BYE (critical rule)
- **Team 8 (roster_id 8, no owner) is a bye week, not a real opponent.**
- Points scored in a Team 8 week **DO count** toward that team's **PF** and **Max PF**.
- The team facing Team 8 **does NOT get a win** (and doesn't get a loss either). The week counts as no decision in W-L.
- Sleeper's built-in `wins` / `losses` **include** results against Team 8. **Never use Sleeper's W-L directly.** Recompute records from weekly matchups and skip any game against roster_id 8.
- Team 8 is excluded from standings, playoff odds, scoring highs, and leaderboards.
- Sleeper always reports Team 8 at 0.00 points.

## Owner Mapping
| Sleeper username | Name | roster_id (2026) |
|---|---|---|
| TravJ14 | Travis | 1 |
| Xx49ersKittlexX (49ersKittle) | Josh | 2 |
| fartsniffer3billion | Caden | 3 |
| Drocks02 (Drocks) | Derek | 4 |
| Walljumpersunit (WallJumpersUnit) | Antonio | 5 |
| yajatnarayan (yajatnarayn) | Yajat | 6 |
| Henrick69 | Henry | 7 |
| — | BYE (Team 8) | 8 |

Match names by `owner_id` → user, not by roster_id, because roster_ids can differ between seasons. Use case-insensitive username matching as a fallback.

## League Settings (from API, 2026)
- 8 rosters (7 real teams + bye), 4 playoff teams
- Regular season: Weeks 1–14. Playoffs start Week 15.
- Trade deadline: Sleeper setting `trade_deadline: 11`, which means **kickoff of the first game of Week 12**
  - Hand-entered: **Thu Nov 26, 2026, 1:00 PM ET** (Thanksgiving). Stored in `data/manual.json`.
- Rookie draft: 5 rounds, linear
- Lineup: 2 QB, 3 RB, 4 WR, 2 TE, 4 FLEX, 1 SUPER_FLEX
- Rookie draft order: non-playoff teams by **lowest Max PF first** (picks 1–3), then playoff teams in **reverse standings** (picks 4–7)
- **7 picks per round.** Team 8 does not get picks.
- Standings tiebreaker: **Points For**

## Historical Notes (for recap flavor)
- 2025: Travis's winless streak ended in Week 6.
- 2025: Derek held the undefeated-start record at 4-0.
- 2026 Pool: $437.56 (as of the Week 7 recap), up $87+ since the 2025 Startup draft.
