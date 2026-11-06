import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { LEAGUE_ID, OWNER_NAMES } from './config.ts';
import { get, getPlayers } from './sleeper.ts';
import type { PlayerInfo, SleeperLeague, SleeperMatchup, SleeperRoster, SleeperState, SleeperUser } from './types.ts';

// payrollgm.com/projections: live matchup projections, win probabilities and
// playoff / last-place odds for two leagues, ported from ~/blu/projection-system
// (scripts/simulate_sleeper_matchups.py, "sleeper-calibrated" method).
//
// Each starter's outcome distribution is the 200 historical player-games
// (2022–2024, same position) whose Sleeper pregame PPR projection is nearest
// theirs, weighted by closeness and rescored with the league's settings
// (data/pools/<key>.json, from projection-system/scripts/export_pools.py).
// One fixed multiplier then makes its mean equal the player's Sleeper
// projection scored with the league's settings. Projections are frozen at
// kickoff; during a game the rest of the distribution is scaled by the share
// of the game left (DEF blends toward its current score instead, since its
// displayed score is provisional). Player draws are independent.
//
// Refreshes are shared by every viewer: one runs every 10 minutes on the
// clock, and anyone can ask for one, but only after a 1-minute cooldown that
// follows every refresh. Viewers hear about new data over server-sent events.

const MIN = 60e3;
const HOUR = 60 * MIN;
const AUTO_MS = 10 * MIN;
const COOLDOWN_MS = MIN;
const SIMS = 100_000;
const ODDS_RUNS = 20_000;
const NEIGHBORS = 200;
// Statuses that end a player's day: what's already scored stays, the rest of the projection goes to 0.
const RULED_OUT = new Set(['Out', 'IR', 'Doubtful', 'Sus', 'PUP']);

export const PROJECTION_LEAGUES = [
  { key: 'blu', name: 'BLU', id: LEAGUE_ID },
  { key: 'diablo', name: 'El Diablo', id: process.env.DIABLO_LEAGUE_ID ?? '1380239559324884992' },
];

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
const SNAP_DIR = path.join(DATA_DIR, 'cache/kickoff-projections');
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Outcome distributions

interface PoolFile {
  scoring: Record<string, number>; // the league's scoring when the pool was exported
  pools: Record<string, [number, number][]>;
}
const poolFiles = new Map<string, Promise<PoolFile>>();
function loadPools(key: string) {
  if (!poolFiles.has(key)) poolFiles.set(key, fs.readFile(path.join(DATA_DIR, 'pools', `${key}.json`), 'utf8').then((s) => JSON.parse(s) as PoolFile));
  return poolFiles.get(key)!;
}

const sameScoring = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

interface Dist {
  values: Float64Array; // sorted ascending
  weights: Float64Array; // sum to 1
}

/** The 200 nearest historical outcomes for a projection, Gaussian-weighted by distance (raw200). */
function neighbors(pool: [number, number][], q: number): Dist {
  const scale = Math.max(2, q * 0.2);
  const d = pool.map(([p], i) => ({ i, d: ((p - q) / scale) ** 2 }));
  d.sort((x, y) => x.d - y.d || x.i - y.i);
  const near = d.slice(0, NEIGHBORS);
  const pairs = near.map((x) => ({ v: pool[x.i][1], w: Math.exp(-(x.d - near[0].d) / 2) }));
  pairs.sort((x, y) => x.v - y.v);
  const total = pairs.reduce((s, x) => s + x.w, 0);
  return { values: Float64Array.from(pairs, (x) => x.v), weights: Float64Array.from(pairs, (x) => x.w / total) };
}

const distCache = new Map<string, Dist>();
/** Neighbors scaled by one fixed multiplier so the mean equals `target` (PregameCalibration). */
function calibrated(key: string, pos: string, pool: [number, number][], q: number, target: number): Dist {
  const ck = `${key}|${pos}|${q}|${target}`;
  const hit = distCache.get(ck);
  if (hit) return hit;
  const raw = neighbors(pool, q);
  let mean = 0;
  for (let i = 0; i < raw.values.length; i++) mean += raw.values[i] * raw.weights[i];
  const mult = mean > 0 ? target / mean : 0;
  const dist = { values: raw.values.map((v) => v * mult), weights: raw.weights };
  if (distCache.size > 5000) distCache.clear();
  distCache.set(ck, dist);
  return dist;
}

function quantile(d: Dist, q: number) {
  let c = 0;
  for (let i = 0; i < d.values.length; i++) if ((c += d.weights[i]) >= q) return d.values[i];
  return d.values[d.values.length - 1];
}

/** Walker alias table: O(1) weighted draws. */
function aliasTable(weights: Float64Array) {
  const n = weights.length;
  const prob = new Float64Array(n);
  const alias = new Int32Array(n);
  const scaled = Array.from(weights, (w) => w * n);
  const small: number[] = [], large: number[] = [];
  scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
  while (small.length && large.length) {
    const s = small.pop()!, l = large.pop()!;
    prob[s] = scaled[s];
    alias[s] = l;
    scaled[l] += scaled[s] - 1;
    (scaled[l] < 1 ? small : large).push(l);
  }
  for (const i of [...small, ...large]) prob[i] = 1;
  return { prob, alias, n };
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// NFL game state (ESPN scoreboard for the clock; Sleeper's schedule as a fallback)

interface NflGame {
  state: 'pre' | 'in' | 'post';
  kickoff: string | null;
  left: number; // share of the game still to play, 0..1
  label: string; // "Sun 12:00 PM CT", "Q3 4:12", "Final"
}
const ESPN_TEAM: Record<string, string> = { WSH: 'WAS' };

async function nflGames(season: number, week: number): Promise<Map<string, NflGame>> {
  const out = new Map<string, NflGame>();
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`);
    if (!res.ok) throw new Error(`ESPN scoreboard -> HTTP ${res.status}`);
    const body = (await res.json()) as { events?: any[] };
    for (const e of body.events ?? []) {
      const st = e.status ?? {};
      const state = st.type?.state === 'post' ? 'post' : st.type?.state === 'in' ? 'in' : 'pre';
      const period = Number(st.period) || 0;
      const clock = Number(st.clock) || 0;
      const left = state === 'pre' ? 1 : state === 'post' ? 0 : Math.max(0, Math.min(1, ((4 - period) * 900 + (period <= 4 ? clock : 0)) / 3600));
      const label =
        state === 'post' ? 'Final' : state === 'in' ? (st.type?.name === 'STATUS_HALFTIME' ? 'Half' : `${period > 4 ? 'OT' : `Q${period}`} ${st.displayClock ?? ''}`.trim()) : '';
      const g: NflGame = { state, kickoff: e.date ?? null, left, label };
      for (const c of e.competitions?.[0]?.competitors ?? []) {
        const abbr = c.team?.abbreviation;
        if (abbr) out.set(ESPN_TEAM[abbr] ?? abbr, g);
      }
    }
    if (out.size) return out;
  } catch (err) {
    console.warn('Projections: ESPN scoreboard unavailable, using Sleeper schedule:', (err as Error).message);
  }
  const sched = await get<{ status: string; week: number; home: string; away: string; date: string }[]>(
    `https://api.sleeper.com/schedule/nfl/regular/${season}`,
    0,
  ).catch(() => []);
  for (const g of sched) {
    if (g.week !== week) continue;
    const state = g.status === 'complete' ? 'post' : g.status === 'in_progress' ? 'in' : 'pre';
    const game: NflGame = { state, kickoff: null, left: state === 'pre' ? 1 : state === 'post' ? 0 : 0.5, label: state === 'post' ? 'Final' : state === 'in' ? 'Live' : '' };
    out.set(g.home, game);
    out.set(g.away, game);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sleeper projections, frozen at kickoff

interface ProjLine {
  ppr: number | null;
  stats: Record<string, number>;
  inj: string | null;
  team: string | null;
}
const PROJ_QS = POSITIONS.map((p) => `position%5B%5D=${p}`).join('&');

function weekProjections(season: number, week: number) {
  return get<Record<string, ProjLine>>(`https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular&${PROJ_QS}`, 0, (raw: any[]) => {
    const out: Record<string, ProjLine> = {};
    for (const r of raw ?? []) {
      if (!r?.player_id || !r.stats) continue;
      out[r.player_id] = { ppr: r.stats.pts_ppr ?? null, stats: r.stats, inj: r.player?.injury_status ?? null, team: r.team ?? r.player?.team ?? null };
    }
    return out;
  });
}

// Projection snapshots for players whose game hasn't started yet. Once it kicks off we keep using
// the last pregame one, since Sleeper keeps revising projections during and after games.
const snapshots = new Map<string, Record<string, ProjLine & { at: number }>>();
async function snapshotFor(season: number, week: number) {
  const name = `${season}-w${String(week).padStart(2, '0')}`;
  if (!snapshots.has(name)) {
    let saved = {};
    try {
      saved = JSON.parse(await fs.readFile(path.join(SNAP_DIR, `${name}.json`), 'utf8'));
    } catch {}
    snapshots.set(name, saved);
  }
  return { name, snap: snapshots.get(name)! };
}
async function saveSnapshot(name: string) {
  await fs.mkdir(SNAP_DIR, { recursive: true });
  await fs.writeFile(path.join(SNAP_DIR, `${name}.json`), JSON.stringify(snapshots.get(name)));
}

// ---------------------------------------------------------------------------
// One league

interface PlayerOut {
  pid: string;
  name: string;
  pos: string;
  team: string | null;
  inj: string | null;
  state: 'pre' | 'in' | 'post' | 'bye' | 'empty';
  game: string; // kickoff time / clock / Final, for display
  kickoff: string | null;
  pts: number; // points so far
  mean: number;
  p10: number;
  p90: number;
}
interface TeamOut {
  rid: number;
  name: string;
  owner: string;
  avatar: string | null;
  pts: number;
  mean: number;
  p10: number;
  p90: number;
  win: number | null;
  tie: number | null;
  starters: PlayerOut[];
}
export interface LeagueOut {
  key: string;
  name: string;
  leagueName: string;
  season: number;
  week: number;
  playoffs: boolean;
  updatedAt: number;
  error: string | null;
  matchups: { id: number; bye: boolean; teams: TeamOut[] }[];
  standings: {
    through: number;
    final: boolean;
    playoffTeams: number;
    rows: { rid: number; name: string; owner: string; avatar: string | null; w: number; l: number; t: number; pf: number; pa: number; playoff: number; last: number }[];
  };
  notes: string[];
}

async function buildLeague(def: (typeof PROJECTION_LEAGUES)[number]): Promise<LeagueOut> {
  const [league, state, users, rosters, players, pools] = await Promise.all([
    get<SleeperLeague>(`/league/${def.id}`, 0),
    get<SleeperState>('/state/nfl', 0),
    get<SleeperUser[]>(`/league/${def.id}/users`, 0),
    get<SleeperRoster[]>(`/league/${def.id}/rosters`, 0),
    getPlayers(),
    loadPools(def.key),
  ]);
  const notes: string[] = [];
  const scoring = league.scoring_settings ?? {};
  if (!sameScoring(scoring, pools.scoring)) {
    console.warn(`Projections: ${def.key} scoring changed since its pool was exported; re-run projection-system/scripts/export_pools.py`);
  }
  const season = Number(league.season);
  const s = league.settings;
  const regWeeks = (s.playoff_week_start || 15) - 1;
  const playoffTeams = s.playoff_teams || 4;
  const lastWeek = regWeeks + Math.ceil(Math.log2(Math.max(2, playoffTeams)));
  const week = Math.min(Math.max(Number(state.week) || 1, 1), lastWeek);

  // Teams. A roster with no owner is a bye (as on the main site): its games add PF only.
  const userById = new Map(users.map((u) => [u.user_id, u as SleeperUser & { metadata?: { team_name?: string } }]));
  const team = new Map<number, { name: string; owner: string; avatar: string | null; owned: boolean }>();
  for (const r of rosters) {
    const u = r.owner_id ? userById.get(r.owner_id) : undefined;
    const display = u?.display_name ?? `Team ${r.roster_id}`;
    team.set(r.roster_id, {
      name: u?.metadata?.team_name || display,
      owner: OWNER_NAMES[display.toLowerCase()] ?? display,
      avatar: u?.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null,
      owned: !!r.owner_id,
    });
  }

  const weeks = Array.from({ length: Math.max(regWeeks, week) }, (_, i) => i + 1);
  const ttl = (w: number) => (w === week ? 0 : w < week ? 6 * HOUR : HOUR);
  const [byWeek, games, proj] = await Promise.all([
    Promise.all(weeks.map((w) => get<SleeperMatchup[]>(`/league/${def.id}/matchups/${w}`, ttl(w)).catch(() => [] as SleeperMatchup[]))),
    nflGames(season, week),
    weekProjections(season, week).catch(() => ({}) as Record<string, ProjLine>),
  ]);

  // Freeze projections at kickoff.
  const { name: snapName, snap } = await snapshotFor(season, week);
  const current = byWeek[week - 1] ?? [];
  let snapChanged = false;
  for (const m of current) {
    for (const pid of m.starters ?? []) {
      const p = proj[pid];
      const g = games.get(p?.team ?? players[pid]?.team ?? '');
      if (p && (!g || g.state === 'pre')) {
        snap[pid] = { ...p, at: Date.now() };
        snapChanged = true;
      }
    }
  }
  if (snapChanged) await saveSnapshot(snapName).catch((err) => console.warn('Projections: snapshot not saved:', err.message));

  const leagueScore = (stats: Record<string, number>) => Object.entries(stats).reduce((t, [k, v]) => t + (scoring[k] != null ? v * scoring[k] : 0), 0);

  // --- This week's matchups -------------------------------------------------
  const rand = mulberry32(42 + week);
  const samples = new Map<number, Float64Array>();
  const teamOut = new Map<number, TeamOut>();
  for (const m of current) {
    const info = team.get(m.roster_id)!;
    const pp = m.players_points ?? {};
    const total = new Float64Array(SIMS);
    const starters: PlayerOut[] = [];
    let locked = 0;
    let mean = 0;
    (m.starters ?? []).forEach((pid, i) => {
      if (!pid || pid === '0') {
        starters.push({ pid: '0', name: 'Empty slot', pos: '', team: null, inj: null, state: 'empty', game: '', kickoff: null, pts: 0, mean: 0, p10: 0, p90: 0 });
        return;
      }
      const meta: PlayerInfo | undefined = players[pid];
      const live = proj[pid];
      const nflTeam = live?.team ?? meta?.team ?? null;
      const g = nflTeam ? games.get(nflTeam) : undefined;
      const pts = round2(pp[pid] ?? m.starters_points?.[i] ?? 0);
      const pos = meta?.pos || (/^[A-Z]{2,3}$/.test(pid) ? 'DEF' : '');
      const base = { pid, name: meta?.name ?? pid, pos, team: nflTeam, inj: live?.inj ?? null, kickoff: g?.kickoff ?? null, pts };
      // Final, or no NFL game this week: the score is what it is.
      if (!g || g.state === 'post') {
        locked += pts;
        mean += pts;
        starters.push({ ...base, state: g ? 'post' : 'bye', game: g ? 'Final' : 'Bye', mean: pts, p10: pts, p90: pts });
        return;
      }
      const line = (g.state === 'pre' ? live : snap[pid] ?? live) ?? null;
      const target = line ? leagueScore(line.stats) : 0;
      const q = line?.ppr ?? target;
      const pool = pools.pools[pos];
      if (!pool || !(target > 0) || !(q > 0) || RULED_OUT.has(live?.inj ?? '')) {
        // Ruled out (before or during the game), or no projection / a position we don't model:
        // only what's already scored counts. The injury status is the latest from Sleeper, not the kickoff snapshot.
        locked += pts;
        mean += pts;
        starters.push({ ...base, state: g.state, game: g.label, mean: pts, p10: pts, p90: pts });
        return;
      }
      const dist = calibrated(def.key, pos, pool, round2(q), round2(target));
      // Final score from one pregame-distribution draw v: offense and K add the unplayed share of v to
      // what they have; DEF blends from its provisional score toward v.
      const f = g.state === 'pre' ? 1 : g.left;
      const fin = pos === 'DEF' ? (v: number) => (1 - f) * pts + f * v : (v: number) => (g.state === 'pre' ? v : pts + f * v);
      const at = aliasTable(dist.weights);
      for (let k = 0; k < SIMS; k++) {
        const u = rand() * at.n;
        const j = Math.floor(u);
        total[k] += fin(dist.values[u - j < at.prob[j] ? j : at.alias[j]]);
      }
      let dm = 0;
      for (let k = 0; k < dist.values.length; k++) dm += dist.values[k] * dist.weights[k];
      const pm = fin(dm);
      mean += pm;
      starters.push({ ...base, state: g.state, game: g.state === 'pre' ? '' : g.label, mean: round1(pm), p10: round1(fin(quantile(dist, 0.1))), p90: round1(fin(quantile(dist, 0.9))) });
    });
    if (locked) for (let k = 0; k < SIMS; k++) total[k] += locked;
    samples.set(m.roster_id, total);
    const sorted = Float64Array.from(total).sort();
    teamOut.set(m.roster_id, {
      rid: m.roster_id,
      name: info.name,
      owner: info.owner,
      avatar: info.avatar,
      pts: round2(m.custom_points ?? m.points ?? 0),
      mean: round1(mean),
      p10: round1(sorted[Math.floor(SIMS * 0.1)]),
      p90: round1(sorted[Math.floor(SIMS * 0.9)]),
      win: null,
      tie: null,
      starters,
    });
  }

  const pairs = new Map<number, SleeperMatchup[]>();
  for (const m of current) if (m.matchup_id != null) pairs.set(m.matchup_id, [...(pairs.get(m.matchup_id) ?? []), m]);
  const matchups: LeagueOut['matchups'] = [];
  const weekWinProb = new Map<number, number>(); // matchup id -> chance the first listed team wins (ties split)
  for (const [id, pair] of [...pairs].sort((x, y) => x[0] - y[0])) {
    if (pair.length !== 2) continue;
    let [a, b] = pair;
    if (!team.get(a.roster_id)?.owned) [a, b] = [b, a];
    if (!team.get(a.roster_id)?.owned) continue;
    const ta = teamOut.get(a.roster_id)!, tb = teamOut.get(b.roster_id)!;
    if (!team.get(b.roster_id)?.owned) {
      matchups.push({ id, bye: true, teams: [ta] });
      continue;
    }
    const sa = samples.get(a.roster_id)!, sb = samples.get(b.roster_id)!;
    let w = 0, t = 0;
    for (let k = 0; k < SIMS; k++) {
      const d = Math.round((sa[k] - sb[k]) * 100);
      if (d > 0) w++;
      else if (d === 0) t++;
    }
    ta.win = round2((w / SIMS) * 100);
    tb.win = round2(((SIMS - w - t) / SIMS) * 100);
    ta.tie = tb.tie = round2((t / SIMS) * 100);
    weekWinProb.set(id, (w + t / 2) / SIMS);
    matchups.push({ id, bye: false, teams: [ta, tb] });
  }
  // Sleeper's order, byes last.
  matchups.sort((x, y) => Number(x.bye) - Number(y.bye) || x.id - y.id);

  // --- Standings, playoff and last-place odds ------------------------------
  const allFinal = games.size > 0 && [...games.values()].every((g) => g.state === 'post');
  const through = Math.min(regWeeks, allFinal ? week : week - 1);
  const owned = rosters.filter((r) => r.owner_id).map((r) => r.roster_id);
  const rec = new Map(owned.map((rid) => [rid, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
  const schedule: { week: number; a: number; b: number; matchupId: number }[] = [];
  for (const w of weeks) {
    if (w > regWeeks) continue;
    const groups = new Map<number, SleeperMatchup[]>();
    for (const m of byWeek[w - 1] ?? []) if (m.matchup_id != null) groups.set(m.matchup_id, [...(groups.get(m.matchup_id) ?? []), m]);
    for (const [matchupId, pair] of groups) {
      if (pair.length !== 2) continue;
      const [x, y] = pair;
      const rx = rec.get(x.roster_id), ry = rec.get(y.roster_id);
      if (w <= through) {
        const px = x.custom_points ?? x.points ?? 0, py = y.custom_points ?? y.points ?? 0;
        if (rx) rx.pf += px;
        if (ry) ry.pf += py;
        if (!rx || !ry) continue; // bye: PF only
        rx.pa += py;
        ry.pa += px;
        if (px > py) (rx.w++, ry.l++);
        else if (py > px) (ry.w++, rx.l++);
        else (rx.t++, ry.t++);
      } else if (rx && ry) {
        schedule.push({ week: w, a: x.roster_id, b: y.roster_id, matchupId });
      }
    }
  }
  const order = (ids: number[], w: Map<number, number>, l: Map<number, number>, t: Map<number, number>, tiebreak: (rid: number) => number) =>
    [...ids].sort((x, y) => w.get(y)! + t.get(y)! / 2 - (w.get(x)! + t.get(x)! / 2) || l.get(x)! - l.get(y)! || tiebreak(y) - tiebreak(x));

  const playoffHits = new Map(owned.map((rid) => [rid, 0]));
  const lastHits = new Map(owned.map((rid) => [rid, 0]));
  const P = Math.min(playoffTeams, owned.length);
  const final = !schedule.length;
  const baseW = new Map(owned.map((rid) => [rid, rec.get(rid)!.w]));
  const baseL = new Map(owned.map((rid) => [rid, rec.get(rid)!.l]));
  const baseT = new Map(owned.map((rid) => [rid, rec.get(rid)!.t]));
  if (final) {
    // Regular season over: the real standings decide it (PF tiebreaker).
    const o = order(owned, baseW, baseL, baseT, (rid) => rec.get(rid)!.pf);
    o.slice(0, P).forEach((rid) => playoffHits.set(rid, 1));
    lastHits.set(o[o.length - 1], 1);
  } else {
    // This week's games use the matchup simulation; later weeks are coin flips. Teams tied on record are
    // ordered at random, like the main site's coin model.
    const oddsRand = mulberry32(20261103 + week);
    for (let run = 0; run < ODDS_RUNS; run++) {
      const w = new Map(baseW), l = new Map(baseL);
      for (const g of schedule) {
        const pa = g.week === week && weekWinProb.has(g.matchupId) ? weekWinProb.get(g.matchupId)! : 0.5;
        const [win, lose] = oddsRand() < pa ? [g.a, g.b] : [g.b, g.a];
        w.set(win, w.get(win)! + 1);
        l.set(lose, l.get(lose)! + 1);
      }
      const flip = new Map(owned.map((rid) => [rid, oddsRand()]));
      const o = order(owned, w, l, baseT, (rid) => flip.get(rid)!);
      for (let i = 0; i < P; i++) playoffHits.set(o[i], playoffHits.get(o[i])! + 1);
      lastHits.set(o[o.length - 1], lastHits.get(o[o.length - 1])! + 1);
    }
  }
  const runs = final ? 1 : ODDS_RUNS;
  const rows = order(owned, baseW, baseL, baseT, (rid) => rec.get(rid)!.pf).map((rid) => {
    const r = rec.get(rid)!, info = team.get(rid)!;
    return {
      rid,
      name: info.name,
      owner: info.owner,
      avatar: info.avatar,
      w: r.w,
      l: r.l,
      t: r.t,
      pf: round2(r.pf),
      pa: round2(r.pa),
      playoff: round2((playoffHits.get(rid)! / runs) * 100),
      last: round2((lastHits.get(rid)! / runs) * 100),
    };
  });

  if (week > regWeeks) notes.push('Playoffs: odds are final from the regular season.');
  return {
    key: def.key,
    name: def.name,
    leagueName: league.name,
    season,
    week,
    playoffs: week > regWeeks,
    updatedAt: Date.now(),
    error: null,
    matchups,
    standings: { through, final, playoffTeams: P, rows },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Shared refresh. Automatic refreshes run only on NFL game days, every 10 minutes on the clock from the
// day's first kickoff until all of that day's games are final. At 12:30am Central each day we look up
// that day's games. Anyone can also refresh, any time, once the 1-minute cooldown after the last one ends.

const data = new Map<string, LeagueOut>();
let version = 0;
let refreshedAt = 0;
let cooldownUntil = 0;
let nextAutoAt: number | null = null;
let running: Promise<void> | null = null;
let queued = false;
const clients = new Set<Response>();

const publicState = () => ({ version, refreshedAt, cooldownUntil, nextAutoAt, refreshing: !!running, now: Date.now() });

function broadcast() {
  const msg = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) {
    res.write(msg);
    (res as Response & { flush?: () => void }).flush?.();
  }
}

async function refreshOnce() {
  const t0 = Date.now();
  for (const def of PROJECTION_LEAGUES) {
    try {
      data.set(def.key, await buildLeague(def));
    } catch (err) {
      console.error(`Projections: ${def.key} refresh failed:`, err);
      const prev = data.get(def.key);
      if (prev) prev.error = 'Last refresh failed; showing earlier data.';
    }
  }
  version++;
  refreshedAt = Date.now();
  cooldownUntil = refreshedAt + COOLDOWN_MS;
  console.log(`Projections refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/** Run a refresh. If one is already running, run another right after it (an automatic one always happens). */
function refresh(): Promise<void> {
  if (running) {
    queued = true;
    return running;
  }
  running = refreshOnce()
    .catch((err) => console.error('Projections refresh failed:', err))
    .finally(() => {
      running = null;
      broadcast();
      if (queued) {
        queued = false;
        void refresh();
      }
    });
  broadcast();
  return running;
}

// --- Game days (Central time) ---

const TZ = 'America/Chicago';
const ctFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function ctParts(t: number) {
  const p = Object.fromEntries(ctFormat.formatToParts(t).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
/** UTC ms of a Central wall-clock time (day overflow is fine, e.g. d + 1). */
function ctTime(y: number, m: number, d: number, h: number, mi: number) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = ctParts(guess);
  return guess - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess);
}
const ctDate = (t: number) => {
  const p = ctParts(t);
  return `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
};

interface GameDay {
  date: string; // YYYYMMDD, Central
  kickoffs: number[]; // ms, sorted
  done: boolean; // every game final and refreshed once after
}
let gameDay: GameDay = { date: '', kickoffs: [], done: true };

/** Today's NFL games (Central date): kickoff times and whether each is final. Null if we can't tell. */
async function todaysGames(date: string): Promise<{ kickoff: number; final: boolean }[] | null> {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${date}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { events?: any[] };
    return (body.events ?? [])
      .map((e) => ({ kickoff: Date.parse(e.date), final: e.status?.type?.state === 'post' }))
      .filter((g) => Number.isFinite(g.kickoff) && ctDate(g.kickoff) === date);
  } catch (err) {
    console.warn('Projections: ESPN scoreboard unavailable for game-day check:', (err as Error).message);
  }
  // Fallback: Sleeper's schedule has dates but no times, so assume the earliest possible kickoff (8:30am, London).
  const sched = await get<{ status: string; date: string }[]>(`https://api.sleeper.com/schedule/nfl/regular/${date.slice(0, 4)}`, HOUR).catch(() => null);
  if (!sched) return null;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6))];
  return sched.filter((g) => g.date === iso).map((g) => ({ kickoff: ctTime(y, m, d, 8, 30), final: g.status === 'complete' }));
}

async function checkGameDay() {
  const date = ctDate(Date.now());
  const games = (await todaysGames(date)) ?? [];
  const kickoffs = games.map((g) => g.kickoff).sort((a, b) => a - b);
  gameDay = { date, kickoffs, done: !kickoffs.length };
  const first = kickoffs[0];
  console.log(
    first
      ? `Projections: ${kickoffs.length} NFL game${kickoffs.length > 1 ? 's' : ''} today, first kickoff ${new Date(first).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })} CT`
      : 'Projections: no NFL games today; automatic refreshes off',
  );
  setNextAuto();
}

function scheduleDailyCheck() {
  const p = ctParts(Date.now());
  let at = ctTime(p.y, p.m, p.d, 0, 30);
  if (at <= Date.now()) at = ctTime(p.y, p.m, p.d + 1, 0, 30);
  setTimeout(() => {
    checkGameDay()
      .catch((err) => console.error('Projections: game-day check failed:', err))
      .finally(scheduleDailyCheck);
  }, at - Date.now());
}

/** Next 10-minute mark at or after `t`. */
const nextMark = (t: number) => Math.ceil(t / AUTO_MS) * AUTO_MS;

function setNextAuto() {
  const first = gameDay.kickoffs[0];
  nextAutoAt = gameDay.done || !first ? null : nextMark(Math.max(first, Date.now() + 1000));
  broadcast();
}

// One timer on the 10-minute marks; it refreshes only inside today's game window.
async function autoTick() {
  const first = gameDay.kickoffs[0];
  if (gameDay.done || !first || Date.now() < first) return;
  const games = await todaysGames(gameDay.date);
  const allFinal = !!games?.length && games.every((g) => g.final);
  await refresh();
  if (allFinal) {
    gameDay.done = true;
    console.log('Projections: all of today\'s games are final; automatic refreshes off until the next game day');
  }
}

function scheduleAuto() {
  const at = nextMark(Date.now() + 1000);
  setTimeout(() => {
    autoTick()
      .catch((err) => console.error('Projections: automatic refresh failed:', err))
      .finally(() => {
        scheduleAuto();
        setNextAuto();
      });
  }, at - Date.now());
}

export function registerProjectionRoutes(app: Express) {
  app.get('/api/projections/state', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(publicState());
  });

  app.get('/api/projections/league/:key', async (req: Request, res: Response) => {
    const key = String(req.params.key);
    if (!PROJECTION_LEAGUES.some((l) => l.key === key)) {
      res.status(404).json({ error: 'Unknown league.' });
      return;
    }
    if (!data.has(key) && running) await running;
    const d = data.get(key);
    if (!d) {
      res.status(503).json({ error: 'Projections are still loading.' });
      return;
    }
    res.set('Cache-Control', 'no-store').json({ ...d, version });
  });

  app.post('/api/projections/refresh', (_req, res) => {
    if (running || Date.now() < cooldownUntil) {
      res.status(429).json({ error: 'Refresh is cooling down.', ...publicState() });
      return;
    }
    void refresh();
    res.status(202).json(publicState());
  });

  // Server-sent events: every viewer hears about each refresh and cooldown.
  app.get('/api/projections/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`retry: 5000\nevent: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });
}

export function startProjections() {
  void refresh(); // something to show right after a start, game day or not
  void checkGameDay().catch((err) => console.error('Projections: game-day check failed:', err));
  scheduleDailyCheck();
  scheduleAuto();
}
