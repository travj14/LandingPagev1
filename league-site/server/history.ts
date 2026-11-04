import { LEAGUE_ID, OWNER_NAMES } from './config.ts';
import { get, getPlayers, invalidateCache, getWeekProjections, getWeekStats, type StatLine } from './sleeper.ts';
import type {
  PlayerInfo,
  SleeperDraftPick,
  SleeperLeague,
  SleeperMatchup,
  SleeperRoster,
  SleeperState,
  SleeperBracketMatch,
  SleeperTransaction,
  SleeperUser,
} from './types.ts';

export interface Team {
  ownerId: string;
  name: string;
  username: string;
  avatar: string | null; // Sleeper avatar id
}

export interface PlayerScore {
  pid: string;
  pts: number;
  stats: StatLine | null; // null when Sleeper has no stats for that week
}

export interface Side {
  rid: number;
  ownerId: string | null; // null = bye team (Team 8)
  pts: number;
  maxPts: number;
  proj: number | null; // Sleeper's projection for the starters used (null if unavailable)
  starters: PlayerScore[];
  bench: PlayerScore[];
}

export interface Game {
  season: number;
  week: number;
  matchupId: number;
  a: Side; // on a bye game, `a` is always the real team
  b: Side;
  bye: boolean;
  playoff: boolean;
  played: boolean;
  live: boolean; // current week, still in progress
}

export interface SeasonData {
  season: number;
  leagueId: string;
  name: string;
  status: string;
  regWeeks: number;
  lastWeek: number;
  playoffTeams: number;
  draftRounds: number;
  tradeDeadlineWeek: number;
  owners: string[];
  ownerByRid: Map<number, string | null>;
  ridByOwner: Map<string, number>;
  games: Game[];
  tradedPicks: SleeperDraftPick[];
  trades: SleeperTransaction[];
  transactions: SleeperTransaction[]; // every completed transaction (current season only)
  rosters: Map<number, string[]>; // roster_id -> player ids, as of now
  bracket: SleeperBracketMatch[]; // winners bracket
}

export interface History {
  seasons: SeasonData[]; // oldest -> newest
  current: SeasonData;
  currentWeek: number;
  teams: Map<string, Team>;
  players: Record<string, PlayerInfo>;
  builtAt: number; // when this copy was assembled (ms)
}

const MIN = 60e3;
const HOUR = 60 * MIN;

// Lineup slot -> eligible positions.
const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Best possible lineup score. Slots are filled most-restrictive first, each
 * taking the best remaining eligible player. This is optimal because the slot
 * eligibilities are nested (QB ⊂ SUPER_FLEX, RB/WR/TE ⊂ FLEX ⊂ SUPER_FLEX).
 */
export function optimalPoints(
  playerIds: string[],
  points: Record<string, number>,
  players: Record<string, PlayerInfo>,
  slots: string[],
): number {
  const order = slots
    .filter((s) => SLOT_ELIGIBILITY[s])
    .sort((x, y) => SLOT_ELIGIBILITY[x].length - SLOT_ELIGIBILITY[y].length);
  const pool = playerIds
    .map((id) => ({ id, pts: points[id] ?? 0, pos: players[id]?.positions ?? [] }))
    .sort((x, y) => y.pts - x.pts);
  const used = new Set<string>();
  let total = 0;
  for (const slot of order) {
    const elig = SLOT_ELIGIBILITY[slot];
    const pick = pool.find((p) => !used.has(p.id) && p.pos.some((pos) => elig.includes(pos)));
    if (pick) {
      used.add(pick.id);
      total += pick.pts;
    }
  }
  return round2(total);
}

function computeCurrentWeek(league: SleeperLeague, state: SleeperState, lastWeek: number) {
  if (league.status === 'complete') return lastWeek;
  if (league.status !== 'in_season' && league.status !== 'post_season') return 0;
  if (state.season !== league.season) return lastWeek;
  return Math.min(Math.max(state.week, 1), lastWeek);
}

async function loadSeason(
  league: SleeperLeague,
  state: SleeperState,
  players: Record<string, PlayerInfo>,
  teams: Map<string, Team>,
  isCurrent: boolean,
): Promise<{ season: SeasonData; currentWeek: number }> {
  const id = league.league_id;
  const done = league.status === 'complete';
  const s = league.settings;
  const regWeeks = (s.playoff_week_start || 15) - 1;
  const playoffTeams = s.playoff_teams || 4;
  const lastWeek = regWeeks + Math.ceil(Math.log2(Math.max(2, playoffTeams)));
  const currentWeek = isCurrent ? computeCurrentWeek(league, state, lastWeek) : lastWeek;

  const weekTtl = (week: number) => {
    if (done) return Infinity;
    if (week === currentWeek) return MIN;
    if (week > currentWeek) return HOUR;
    return week === currentWeek - 1 ? HOUR : 6 * HOUR;
  };
  const metaTtl = done ? Infinity : 5 * MIN;

  const weeks = Array.from({ length: lastWeek }, (_, i) => i + 1);
  const statWeeks = weeks.filter((w) => done || w <= currentWeek);
  const [users, rosters, matchupsByWeek, tradedPicks, txByWeek, statsByWeek, projByWeek, bracket] = await Promise.all([
    get<SleeperUser[]>(`/league/${id}/users`, metaTtl),
    get<SleeperRoster[]>(`/league/${id}/rosters`, metaTtl),
    Promise.all(weeks.map((w) => get<SleeperMatchup[]>(`/league/${id}/matchups/${w}`, weekTtl(w)))),
    isCurrent ? get<SleeperDraftPick[]>(`/league/${id}/traded_picks`, metaTtl) : Promise.resolve([]),
    isCurrent
      ? Promise.all(
          weeks
            .filter((w) => w <= Math.max(currentWeek, 1))
            .map((w) => get<SleeperTransaction[]>(`/league/${id}/transactions/${w}`, w === currentWeek ? MIN : HOUR)),
        )
      : Promise.resolve([]),
    Promise.all(statWeeks.map((w) => getWeekStats(Number(league.season), w, weekTtl(w)).catch(() => null))),
    Promise.all(
      statWeeks.map((w) =>
        w > regWeeks
          ? null
          : getWeekProjections(Number(league.season), w, id, league.scoring_settings ?? {}, w === currentWeek ? HOUR : weekTtl(w)).catch(() => null),
      ),
    ),
    get<SleeperBracketMatch[] | null>(`/league/${id}/winners_bracket`, metaTtl).catch(() => null),
  ]);

  const userById = new Map(users.map((u) => [u.user_id, u]));
  const ownerByRid = new Map<number, string | null>();
  const ridByOwner = new Map<string, number>();
  for (const r of rosters) {
    ownerByRid.set(r.roster_id, r.owner_id);
    if (!r.owner_id) continue; // Team 8 / bye
    ridByOwner.set(r.owner_id, r.roster_id);
    if (!teams.has(r.owner_id)) {
      const username = userById.get(r.owner_id)?.display_name ?? r.owner_id;
      teams.set(r.owner_id, {
        ownerId: r.owner_id,
        username,
        name: OWNER_NAMES[username.toLowerCase()] ?? username,
        avatar: userById.get(r.owner_id)?.avatar ?? null,
      });
    }
  }

  const slots = league.roster_positions.filter((p) => SLOT_ELIGIBILITY[p]);
  const seasonNum = Number(league.season);
  const games: Game[] = [];

  matchupsByWeek.forEach((matchups, i) => {
    const week = i + 1;
    const weekStats = statsByWeek[statWeeks.indexOf(week)] ?? null;
    const statOf = (pid: string) => (weekStats ? (weekStats[pid] ?? {}) : null);
    const weekProj = projByWeek[statWeeks.indexOf(week)] ?? null;
    const groups = new Map<number, SleeperMatchup[]>();
    for (const m of matchups) {
      if (m.matchup_id == null) continue;
      groups.set(m.matchup_id, [...(groups.get(m.matchup_id) ?? []), m]);
    }
    for (const [matchupId, pair] of groups) {
      if (pair.length !== 2) continue;
      const [x, y] = pair.map((m): Side => {
        const pp = m.players_points ?? {};
        const starterIds = (m.starters ?? []).filter((p) => p && p !== '0');
        const starterSet = new Set(starterIds);
        return {
          rid: m.roster_id,
          ownerId: ownerByRid.get(m.roster_id) ?? null,
          pts: round2(m.custom_points ?? m.points ?? 0),
          maxPts: optimalPoints(m.players ?? [], pp, players, slots),
          proj: weekProj && starterIds.length ? round2(starterIds.reduce((t, pid) => t + (weekProj[pid] ?? 0), 0)) : null,
          starters: starterIds.map((pid) => ({ pid, pts: pp[pid] ?? 0, stats: statOf(pid) })),
          bench: (m.players ?? []).filter((p) => !starterSet.has(p)).map((pid) => ({ pid, pts: pp[pid] ?? 0, stats: statOf(pid) })),
        };
      });
      const bye = !x.ownerId || !y.ownerId;
      const [a, b] = bye && !x.ownerId ? [y, x] : [x, y];
      if (!a.ownerId) continue; // two bye teams, nothing to record
      games.push({
        season: seasonNum,
        week,
        matchupId,
        a,
        b,
        bye,
        playoff: week > regWeeks,
        played: bye ? a.pts > 0 : a.pts > 0 || b.pts > 0,
        live: isCurrent && !done && week === currentWeek,
      });
    }
  });

  const transactions = txByWeek
    .flat()
    .filter((t) => t.status === 'complete')
    .sort((x, y) => x.status_updated - y.status_updated);
  const trades = transactions.filter((t) => t.type === 'trade');

  return {
    currentWeek,
    season: {
      season: seasonNum,
      leagueId: id,
      name: league.name,
      status: league.status,
      regWeeks,
      lastWeek,
      playoffTeams,
      draftRounds: s.draft_rounds || 5,
      tradeDeadlineWeek: s.trade_deadline || 0,
      owners: [...ridByOwner.keys()],
      ownerByRid,
      ridByOwner,
      games,
      tradedPicks,
      trades,
      transactions,
      rosters: new Map(rosters.map((r) => [r.roster_id, r.players ?? []])),
      bracket: bracket ?? [],
    },
  };
}

async function build(): Promise<History> {
  const [state, players] = await Promise.all([get<SleeperState>('/state/nfl', MIN), getPlayers()]);
  const teams = new Map<string, Team>();
  const seasons: SeasonData[] = [];
  let currentWeek = 0;
  let leagueId: string | null = LEAGUE_ID;

  while (leagueId) {
    const isCurrent = seasons.length === 0;
    const league: SleeperLeague = await get<SleeperLeague>(`/league/${leagueId}`, isCurrent ? 5 * MIN : HOUR);
    const loaded = await loadSeason(league, state, players, teams, isCurrent);
    if (isCurrent) currentWeek = loaded.currentWeek;
    seasons.unshift(loaded.season);
    leagueId = league.previous_league_id && league.previous_league_id !== '0' ? league.previous_league_id : null;
  }

  return { seasons, current: seasons[seasons.length - 1], currentWeek, teams, players, builtAt: Date.now() };
}

let memo: { at: number; promise: Promise<History> } | null = null;
let lastGood: History | null = null;
let refreshing: Promise<History> | null = null;
let refreshedAt: number | null = null;

/** When the last full refresh finished (null if none since the server started), and whether one is running. */
export const refreshState = () => ({ refreshedAt, refreshing: !!refreshing });

/** Full league history (all seasons), memoized briefly so rapid requests share one load. */
export function loadHistory(): Promise<History> {
  // While a full refresh runs, keep serving the last good data instead of waiting on it.
  if (refreshing && lastGood) return Promise.resolve(lastGood);
  if (memo && Date.now() - memo.at < 30e3) return memo.promise;
  const promise = build();
  memo = { at: Date.now(), promise };
  promise.then(
    (h) => (lastGood = h),
    () => (memo = null),
  );
  return promise;
}

/**
 * Re-fetch all history from Sleeper, ignoring every cache (finished seasons and
 * the player DB included), then swap it in. Calls during a refresh share it.
 */
export function refreshHistory(): Promise<History> {
  if (refreshing) return refreshing;
  invalidateCache();
  refreshing = build()
    .then((h) => {
      lastGood = h;
      refreshedAt = Date.now();
      memo = { at: Date.now(), promise: Promise.resolve(h) };
      return h;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}
