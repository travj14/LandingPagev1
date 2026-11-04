import { round2, type Game, type History, type PlayerScore, type Side } from './history.ts';
import type { StatKey } from './sleeper.ts';
import { computeStandings } from './standings.ts';

export interface Cutoff {
  season: number;
  week: number;
}

export const within = (g: { season: number; week: number }, c: Cutoff) => g.season < c.season || (g.season === c.season && g.week <= c.week);

export const f2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const where = (g: { season: number; week: number; playoff?: boolean }) =>
  `${g.season} Wk ${g.week}${g.playoff ? ' (Playoffs)' : ''}`;

export const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

export type RecordGroup = 'Team' | 'Matchup' | 'Player' | 'Stat lines' | 'Weird' | 'Season' | 'YTD' | 'Streaks';
export const RECORD_GROUPS: RecordGroup[] = ['Team', 'Matchup', 'Player', 'Stat lines', 'Weird', 'Season', 'YTD', 'Streaks'];

type Fmt = 'pts' | 'int' | 'pct' | 'games' | 'weeks';

export interface RecordRow {
  value: number;
  display: string;
  holderId: string | null;
  holder: string;
  detail: string;
  season: number;
  week: number;
  active?: boolean; // streaks still going
  parties?: [string | null, string | null]; // matchup rows: [winner, loser]
}

export type Tone = 'good' | 'bad' | 'neutral';
export interface Credit {
  ownerId: string;
  tone: Tone;
}

export interface RecordEntry extends RecordRow {
  key: string;
  label: string;
  group: RecordGroup;
  lowerIsBetter: boolean;
  top: RecordRow[]; // #1 first, up to 5
  broken?: boolean;
  prev?: { display: string; holder: string; detail: string } | null;
  tone: Tone | 'matchup';
  credits: Credit[]; // good/bad tally credit for the #1 holder(s)
}

export interface SideCtx {
  g: Game;
  side: Side;
  opp: Side | null;
}

export function sidesOf(games: Game[]): SideCtx[] {
  return games.flatMap((g): SideCtx[] => (g.bye ? [{ g, side: g.a, opp: null }] : [{ g, side: g.a, opp: g.b }, { g, side: g.b, opp: g.a }]));
}

const fmt = (f: Fmt, v: number) => {
  if (f === 'pts') return f2(v);
  if (f === 'pct') return `${(v * 100).toFixed(1)}%`;
  if (f === 'games') return `${v} game${v === 1 ? '' : 's'}`;
  if (f === 'weeks') return `${v} week${v === 1 ? '' : 's'}`;
  return Math.round(v).toLocaleString('en-US');
};

// ---------- Good vs. bad records (the league's call) ----------

const GOOD = new Set([
  'highScore', 'maxPfWeek', 'studs', 'byeScore',
  'totalYds', 'passYds', 'rushYds', 'recYds', 'tds', 'receptions', 'bigPlays',
  'playerHigh', 'playerQB', 'playerRB', 'playerWR', 'playerTE', 'playerYds', 'playerTds', 'passTds', 'longTd',
  'seasonPF', 'seasonMaxPF', 'seasonWins', 'seasonHighs', 'seasonEff',
  'ytdPF', 'ytdMaxPF', 'ytdWins', 'ytdHighs', 'ytdEff',
  'winStreak', 'bestStart', 'over200', 'aboveAvg', 'topScorer', 'has30',
]);
const BAD = new Set([
  'lowScore', 'turnovers', 'sacks', 'drops', 'duds', 'donuts', 'worstEff', 'worstStarter', 'playerTurnovers',
  'seasonLowPF', 'seasonLowMaxPF', 'seasonLosses', 'seasonLows', 'seasonWorstEff',
  'ytdLowPF', 'ytdLowMaxPF', 'ytdLosses', 'ytdLows', 'ytdWorstEff',
  'lossStreak', 'worstStart', 'under200', 'belowAvg', 'bottomScorer',
]);
// Matchups: blowout winner good / loser bad; highest-scoring both good; lowest-scoring both bad; closest neutral.
const MATCHUP_TONE: Record<string, [Tone, Tone]> = {
  blowout: ['good', 'bad'],
  upset: ['good', 'bad'],
  combined: ['good', 'good'],
  snoozer: ['bad', 'bad'],
};
// Everything else is neutral: highest score in a loss, lowest score in a win, most PA (season and YTD), all bench records, closest game.

function toneOf(key: string): Tone | 'matchup' {
  if (MATCHUP_TONE[key]) return 'matchup';
  return GOOD.has(key) ? 'good' : BAD.has(key) ? 'bad' : 'neutral';
}

function creditsFor(key: string, row: RecordRow): Credit[] {
  const pair = MATCHUP_TONE[key];
  if (pair && row.parties) {
    return row.parties.flatMap((ownerId, i) => (ownerId ? [{ ownerId, tone: pair[i] }] : []));
  }
  const tone = toneOf(key);
  return tone !== 'matchup' && tone !== 'neutral' && row.holderId ? [{ ownerId: row.holderId, tone }] : [];
}

const chrono = (x: { season: number; week: number }, y: { season: number; week: number }) => x.season - y.season || x.week - y.week;

/** Rank candidates; ties keep the earlier achiever on top. */
function rank<T extends RecordRow>(rows: T[], lowerIsBetter: boolean, n = 5): T[] {
  return rows
    .filter((r) => Number.isFinite(r.value))
    .sort((x, y) => (lowerIsBetter ? x.value - y.value : y.value - x.value) || chrono(x, y))
    .slice(0, n);
}

const sumStat = (players: PlayerScore[], keys: StatKey[]) => {
  if (players.some((p) => p.stats === null)) return NaN; // no stats for that week
  return players.reduce((s, p) => s + keys.reduce((t, k) => t + (p.stats?.[k] ?? 0), 0), 0);
};

// ---------- Team-week records (one row per team per week) ----------

interface TeamWeekDef {
  key: string;
  label: string;
  group: RecordGroup;
  fmt: Fmt;
  lower?: boolean;
  value: (c: SideCtx) => number | null;
  finalOnly?: boolean; // skip the in-progress week (low/"worst" records)
  detail?: (c: SideCtx) => string;
}

const won = (c: SideCtx) => !!c.opp && c.side.pts > c.opp.pts;
const lost = (c: SideCtx) => !!c.opp && c.side.pts < c.opp.pts;
const yds: StatKey[] = ['pass_yd', 'rush_yd', 'rec_yd'];
const tds: StatKey[] = ['pass_td', 'rush_td', 'rec_td'];

const TEAM_WEEK: TeamWeekDef[] = [
  { key: 'highScore', label: 'Highest team score', group: 'Team', fmt: 'pts', value: (c) => c.side.pts },
  { key: 'lowScore', label: 'Lowest team score', group: 'Team', fmt: 'pts', lower: true, finalOnly: true, value: (c) => (c.side.pts > 0 ? c.side.pts : null) },
  { key: 'highLoss', label: 'Highest score in a loss', group: 'Team', fmt: 'pts', value: (c) => (lost(c) ? c.side.pts : null) },
  { key: 'lowWin', label: 'Lowest score in a win', group: 'Team', fmt: 'pts', lower: true, finalOnly: true, value: (c) => (won(c) ? c.side.pts : null) },
  { key: 'maxPfWeek', label: 'Highest Max PF in a week', group: 'Team', fmt: 'pts', value: (c) => c.side.maxPts },
  { key: 'benchPts', label: 'Most bench points in a week', group: 'Team', fmt: 'pts', value: (c) => round2(c.side.bench.reduce((s, p) => s + p.pts, 0)) },
  {
    key: 'benchLeft',
    label: 'Most points left on the bench',
    group: 'Team',
    fmt: 'pts',
    finalOnly: true,
    value: (c) => round2(c.side.maxPts - c.side.pts),
    detail: (c) => `scored ${f2(c.side.pts)} of a possible ${f2(c.side.maxPts)} · ${where(c.g)}`,
  },
  { key: 'studs', label: 'Most starters with 25+ points', group: 'Team', fmt: 'int', value: (c) => c.side.starters.filter((p) => p.pts >= 25).length || null },
  { key: 'totalYds', label: 'Most total yards by starters', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.starters, yds) },
  { key: 'passYds', label: 'Most passing yards by starters', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.starters, ['pass_yd']) },
  { key: 'rushYds', label: 'Most rushing yards by starters', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.starters, ['rush_yd']) },
  { key: 'recYds', label: 'Most receiving yards by starters', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.starters, ['rec_yd']) },
  { key: 'tds', label: 'Most combined TDs by starters', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.starters, tds) },
  { key: 'receptions', label: 'Most receptions by starters', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.starters, ['rec']) },
  { key: 'bigPlays', label: 'Most 40+ yard plays by starters', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.starters, ['rush_40p', 'rec_40p']) || null },
  { key: 'benchTds', label: 'Most TDs left on the bench', group: 'Stat lines', fmt: 'int', value: (c) => sumStat(c.side.bench, ['rush_td', 'rec_td', 'pass_td']) || null },
  { key: 'turnovers', label: 'Most turnovers by starters (INT + fumbles lost)', group: 'Weird', fmt: 'int', value: (c) => sumStat(c.side.starters, ['pass_int', 'fum_lost']) || null },
  { key: 'sacks', label: 'Most sacks taken by starting QBs', group: 'Weird', fmt: 'int', value: (c) => sumStat(c.side.starters, ['pass_sack']) || null },
  { key: 'drops', label: 'Most dropped passes by starters', group: 'Weird', fmt: 'int', value: (c) => sumStat(c.side.starters, ['rec_drop']) || null },
  { key: 'duds', label: 'Most starters with 5 or fewer points', group: 'Weird', fmt: 'int', finalOnly: true, value: (c) => c.side.starters.filter((p) => p.pts <= 5).length || null },
  { key: 'donuts', label: 'Most starters scoring zero or less', group: 'Weird', fmt: 'int', finalOnly: true, value: (c) => c.side.starters.filter((p) => p.pts <= 0).length || null },
  {
    key: 'worstEff',
    label: 'Worst lineup efficiency (PF ÷ Max PF)',
    group: 'Weird',
    fmt: 'pct',
    lower: true,
    finalOnly: true,
    value: (c) => (c.side.maxPts > 0 ? c.side.pts / c.side.maxPts : null),
    detail: (c) => `${f2(c.side.pts)} of ${f2(c.side.maxPts)} · ${where(c.g)}`,
  },
  { key: 'byeScore', label: 'Best score in a bye week', group: 'Weird', fmt: 'pts', value: (c) => (c.opp ? null : c.side.pts) },
];

// ---------- Matchup records (one row per game) ----------

interface MatchupDef {
  key: string;
  label: string;
  lower?: boolean;
  finalOnly?: boolean;
  margin?: boolean;
  value: (g: Game) => number | null;
  detail?: (g: Game) => string;
}

/** How many projected points the winner was down before kickoff (null if they were favored or no projection). */
const upsetBy = (g: Game) => {
  if (g.a.proj == null || g.b.proj == null || g.a.pts === g.b.pts) return null;
  const [w, l] = g.a.pts > g.b.pts ? [g.a, g.b] : [g.b, g.a];
  return l.proj! > w.proj! ? round2(l.proj! - w.proj!) : null;
};

const MATCHUP: MatchupDef[] = [
  { key: 'blowout', label: 'Biggest blowout', margin: true, value: (g) => round2(Math.abs(g.a.pts - g.b.pts)) },
  { key: 'closest', label: 'Closest game', margin: true, lower: true, finalOnly: true, value: (g) => round2(Math.abs(g.a.pts - g.b.pts)) },
  { key: 'combined', label: 'Highest-scoring matchup', value: (g) => round2(g.a.pts + g.b.pts) },
  { key: 'snoozer', label: 'Lowest-scoring matchup', lower: true, finalOnly: true, value: (g) => round2(g.a.pts + g.b.pts) },
  {
    key: 'upset',
    label: 'Biggest projected upset',
    margin: true,
    finalOnly: true,
    value: upsetBy,
    detail: (g) => {
      const [w, l] = g.a.pts > g.b.pts ? [g.a, g.b] : [g.b, g.a];
      return `projected ${f2(w.proj!)}–${f2(l.proj!)}, won ${f2(w.pts)}–${f2(l.pts)}`;
    },
  },
];

// ---------- Player records (one row per player-week) ----------

interface Perf {
  p: PlayerScore;
  c: SideCtx;
  pos: string;
  bench: boolean;
}

interface PlayerDef {
  key: string;
  label: string;
  group: RecordGroup;
  fmt: Fmt;
  lower?: boolean;
  bench?: boolean; // bench players instead of starters
  finalOnly?: boolean;
  showPos?: boolean;
  value: (x: Perf) => number | null;
}

const stat = (x: Perf, keys: StatKey[]) => (x.p.stats === null ? NaN : keys.reduce((s, k) => s + (x.p.stats?.[k] ?? 0), 0));
const longest = (x: Perf, keys: StatKey[]) => (x.p.stats === null ? NaN : Math.max(0, ...keys.map((k) => x.p.stats?.[k] ?? 0)));

const PLAYER: PlayerDef[] = [
  { key: 'playerHigh', label: 'Highest-scoring player (any position)', group: 'Player', fmt: 'pts', showPos: true, value: (x) => x.p.pts },
  ...['QB', 'RB', 'WR', 'TE'].map((pos): PlayerDef => ({ key: `player${pos}`, label: `Highest-scoring ${pos}`, group: 'Player', fmt: 'pts', value: (x) => (x.pos === pos ? x.p.pts : null) })),
  { key: 'benchPlayer', label: 'Highest-scoring benched player', group: 'Player', fmt: 'pts', bench: true, finalOnly: true, showPos: true, value: (x) => x.p.pts },
  { key: 'worstStarter', label: 'Worst starter (lowest points)', group: 'Weird', fmt: 'pts', lower: true, finalOnly: true, showPos: true, value: (x) => x.p.pts },
  { key: 'playerYds', label: 'Most scrimmage yards by a player', group: 'Stat lines', fmt: 'int', value: (x) => stat(x, ['rush_yd', 'rec_yd']) },
  { key: 'playerTds', label: 'Most rushing + receiving TDs by a player', group: 'Stat lines', fmt: 'int', value: (x) => stat(x, ['rush_td', 'rec_td']) || null },
  { key: 'passTds', label: 'Most passing TDs by a QB', group: 'Stat lines', fmt: 'int', value: (x) => stat(x, ['pass_td']) || null },
  { key: 'longTd', label: 'Longest TD by a starter (yards)', group: 'Stat lines', fmt: 'int', value: (x) => longest(x, ['rush_td_lng', 'rec_td_lng']) || null },
  { key: 'playerTurnovers', label: 'Most turnovers by one player', group: 'Weird', fmt: 'int', value: (x) => stat(x, ['pass_int', 'fum_lost']) || null },
];

// ---------- Streaks (consecutive regular-season weeks, across seasons) ----------

export interface TeamWeek {
  ownerId: string;
  season: number;
  week: number;
  pts: number;
  result: 'W' | 'L' | 'T' | null; // null = bye
  weekHigh: boolean;
  weekLow: boolean;
  aboveAvg: boolean;
  has30: boolean;
}

interface StreakDef {
  key: string;
  label: string;
  unit: 'games' | 'weeks';
  hit: (t: TeamWeek) => boolean;
  skipByes?: boolean; // byes neither extend nor break it
  fromStart?: boolean; // only streaks that open a season
}

const STREAKS: StreakDef[] = [
  { key: 'winStreak', label: 'Longest win streak', unit: 'games', hit: (t) => t.result === 'W', skipByes: true },
  { key: 'lossStreak', label: 'Longest losing streak', unit: 'games', hit: (t) => t.result === 'L', skipByes: true },
  { key: 'bestStart', label: 'Best start to a season (undefeated)', unit: 'games', hit: (t) => t.result === 'W', skipByes: true, fromStart: true },
  { key: 'worstStart', label: 'Worst start to a season (winless)', unit: 'games', hit: (t) => t.result === 'L', skipByes: true, fromStart: true },
  { key: 'over200', label: 'Longest streak scoring 200+', unit: 'weeks', hit: (t) => t.pts >= 200 },
  { key: 'under200', label: 'Longest streak scoring under 200', unit: 'weeks', hit: (t) => t.pts < 200 },
  { key: 'aboveAvg', label: 'Longest streak above the league average', unit: 'weeks', hit: (t) => t.aboveAvg },
  { key: 'belowAvg', label: 'Longest streak below the league average', unit: 'weeks', hit: (t) => !t.aboveAvg },
  { key: 'topScorer', label: 'Most straight weeks as the top scorer', unit: 'weeks', hit: (t) => t.weekHigh },
  { key: 'bottomScorer', label: 'Most straight weeks as the lowest scorer', unit: 'weeks', hit: (t) => t.weekLow },
  { key: 'has30', label: 'Longest streak with a 30-point starter', unit: 'weeks', hit: (t) => t.has30 },
];

export interface StreakRun {
  key: string;
  label: string;
  unit: 'games' | 'weeks';
  ownerId: string;
  length: number;
  start: { season: number; week: number };
  end: { season: number; week: number };
  active: boolean;
}

/** One row per team per regular-season week (byes included), oldest first. */
export function teamWeeks(h: History, cutoff: Cutoff): TeamWeek[] {
  const out: TeamWeek[] = [];
  for (const s of h.seasons) {
    const games = s.games.filter((g) => !g.playoff && g.played && within(g, cutoff));
    const byWeek = new Map<number, SideCtx[]>();
    for (const c of sidesOf(games)) byWeek.set(c.g.week, [...(byWeek.get(c.g.week) ?? []), c]);
    for (const [week, cs] of [...byWeek].sort((a, b) => a[0] - b[0])) {
      const pts = cs.map((c) => c.side.pts);
      const hi = Math.max(...pts);
      const lo = Math.min(...pts);
      const avg = pts.reduce((x, y) => x + y, 0) / pts.length;
      for (const c of cs) {
        out.push({
          ownerId: c.side.ownerId!,
          season: s.season,
          week,
          pts: c.side.pts,
          result: c.opp ? (c.side.pts > c.opp.pts ? 'W' : c.side.pts < c.opp.pts ? 'L' : 'T') : null,
          weekHigh: c.side.pts === hi,
          weekLow: c.side.pts === lo,
          aboveAvg: c.side.pts > avg,
          has30: c.side.starters.some((p) => p.pts >= 30),
        });
      }
    }
  }
  return out;
}

export function streakRuns(tws: TeamWeek[]): StreakRun[] {
  const byOwner = new Map<string, TeamWeek[]>();
  for (const t of tws) byOwner.set(t.ownerId, [...(byOwner.get(t.ownerId) ?? []), t]);
  const runs: StreakRun[] = [];
  for (const def of STREAKS) {
    for (const [ownerId, weeks] of byOwner) {
      let cur: TeamWeek[] = [];
      let seasonOpen = true; // no decided game yet this season
      const close = (active: boolean) => {
        if (cur.length) {
          runs.push({ key: def.key, label: def.label, unit: def.unit, ownerId, length: cur.length, start: cur[0], end: cur[cur.length - 1], active });
        }
        cur = [];
      };
      weeks.forEach((t, i) => {
        if (i > 0 && t.season !== weeks[i - 1].season) {
          if (def.fromStart) close(false);
          seasonOpen = true;
        }
        if (def.skipByes && t.result === null) return;
        if (def.hit(t) && (!def.fromStart || seasonOpen || cur.length > 0)) cur.push(t);
        else close(false);
        seasonOpen = false;
      });
      close(true);
    }
  }
  return runs;
}

// ---------- Assemble ----------

export function computeRecords(h: History, cutoff: Cutoff): { records: RecordEntry[]; runs: StreakRun[] } {
  const nameOf = (id: string | null) => (id && h.teams.get(id)?.name) || 'BYE';
  const playerName = (pid: string) => h.players[pid]?.name ?? pid;
  const games = h.seasons
    .flatMap((s) => s.games)
    .filter((g) => g.played && within(g, cutoff))
    .sort(chrono);
  const sides = sidesOf(games);
  const vs = (c: SideCtx) => (c.opp ? `vs ${nameOf(c.opp.ownerId)} · ` : 'bye week · ');
  const records: RecordEntry[] = [];

  const add = (key: string, label: string, group: RecordGroup, lowerIsBetter: boolean, rows: RecordRow[]) => {
    const top = rank(rows, lowerIsBetter);
    if (top.length) records.push({ key, label, group, lowerIsBetter, ...top[0], top, tone: toneOf(key), credits: creditsFor(key, top[0]) });
  };

  for (const d of TEAM_WEEK) {
    const rows: RecordRow[] = [];
    for (const c of sides) {
      if (d.finalOnly && c.g.live) continue;
      const v = d.value(c);
      if (v == null || !Number.isFinite(v)) continue;
      rows.push({
        value: v,
        display: fmt(d.fmt, v),
        holderId: c.side.ownerId,
        holder: nameOf(c.side.ownerId),
        detail: d.detail ? d.detail(c) : vs(c) + where(c.g),
        season: c.g.season,
        week: c.g.week,
      });
    }
    add(d.key, d.label, d.group, !!d.lower, rows);
  }

  for (const d of MATCHUP) {
    const rows: RecordRow[] = [];
    for (const g of games) {
      if (g.bye || (d.finalOnly && g.live)) continue;
      const [w, l] = g.a.pts >= g.b.pts ? [g.a, g.b] : [g.b, g.a];
      const v = d.value(g);
      if (v == null) continue;
      const byWinner = d.margin && g.a.pts !== g.b.pts;
      rows.push({
        value: v,
        display: d.margin && v === 0 ? 'Tie' : f2(v),
        holderId: byWinner ? w.ownerId : null,
        holder: byWinner ? nameOf(w.ownerId) : `${nameOf(w.ownerId)} & ${nameOf(l.ownerId)}`,
        detail: `${byWinner ? `over ${nameOf(l.ownerId)}, ` : ''}${d.detail ? d.detail(g) : `${f2(w.pts)}–${f2(l.pts)}`} · ${where(g)}`,
        season: g.season,
        week: g.week,
        parties: [w.ownerId, l.ownerId],
      });
    }
    add(d.key, d.label, 'Matchup', !!d.lower, rows);
  }

  const perfs: Perf[] = sides.flatMap((c) => [
    ...c.side.starters.map((p) => ({ p, c, pos: h.players[p.pid]?.pos ?? '', bench: false })),
    ...c.side.bench.map((p) => ({ p, c, pos: h.players[p.pid]?.pos ?? '', bench: true })),
  ]);
  for (const d of PLAYER) {
    const rows: RecordRow[] = [];
    for (const x of perfs) {
      if (x.bench !== !!d.bench || (d.finalOnly && x.c.g.live)) continue;
      const v = d.value(x);
      if (v == null || !Number.isFinite(v)) continue;
      rows.push({
        value: v,
        display: fmt(d.fmt, v),
        holderId: x.c.side.ownerId,
        holder: nameOf(x.c.side.ownerId),
        detail: `${playerName(x.p.pid)}${d.showPos ? ` (${x.pos})` : ''} · ${where(x.c.g)}`,
        season: x.c.g.season,
        week: x.c.g.week,
      });
    }
    add(d.key, d.label, d.group, !!d.lower, rows);
  }

  // Season records count full regular seasons once complete. YTD records compare every
  // season through the same week as the selected one (e.g. "Most PF through Week 7").
  const tws = teamWeeks(h, cutoff);
  const cur = h.seasons.find((s) => s.season === cutoff.season);
  // Last regular-season week with scores, so an unplayed current week doesn't compare 7 games to 8.
  const ytdWeek = Math.max(0, ...(cur?.games ?? []).filter((g) => !g.playoff && g.played && within(g, cutoff)).map((g) => g.week));
  const seasonRowsThrough = (seasons: typeof h.seasons, weekOf: (s: (typeof h.seasons)[number]) => number) =>
    seasons.flatMap((s) => {
      const week = weekOf(s);
      return computeStandings(s, week, nameOf).map((r) => {
        const mine = tws.filter((t) => t.season === s.season && t.week <= week && t.ownerId === r.ownerId);
        return {
          ...r,
          season: s.season,
          week,
          highs: mine.filter((t) => t.weekHigh).length,
          lows: mine.filter((t) => t.weekLow).length,
          eff: r.maxpf ? r.pf / r.maxpf : 0,
        };
      });
    });
  const doneSeasons = h.seasons.filter((s) => s.season < cutoff.season || (s.season === cutoff.season && cutoff.week >= s.regWeeks));
  const seasonRows = seasonRowsThrough(doneSeasons, (s) => s.regWeeks);
  const ytdRows =
    ytdWeek >= 1
      ? seasonRowsThrough(
          h.seasons.filter((s) => s.season <= cutoff.season && s.regWeeks >= ytdWeek),
          () => ytdWeek,
        )
      : [];
  type SeasonRow = (typeof seasonRows)[number];
  const wl = (r: SeasonRow) => `${r.w}-${r.l}${r.t ? `-${r.t}` : ''}`;
  const seasonRec = (key: string, label: string, lower: boolean, f: Fmt, value: (r: SeasonRow) => number, display?: (r: SeasonRow) => string) => {
    const row = (r: SeasonRow, detail: string): RecordRow => ({
      value: value(r),
      display: display ? display(r) : fmt(f, value(r)),
      holderId: r.ownerId,
      holder: r.name,
      detail,
      season: r.season,
      week: r.week,
    });
    add(`season${key}`, `${label} in a season`, 'Season', lower, seasonRows.map((r) => row(r, `${r.season} regular season`)));
    if (ytdRows.length) {
      add(`ytd${key}`, `${label} through Week ${ytdWeek}`, 'YTD', lower, ytdRows.map((r) => row(r, `${r.season} · Weeks 1–${ytdWeek}`)));
    }
  };
  seasonRec('PF', 'Most PF', false, 'pts', (r) => r.pf);
  seasonRec('LowPF', 'Fewest PF', true, 'pts', (r) => r.pf);
  seasonRec('PA', 'Most points against', false, 'pts', (r) => r.pa);
  seasonRec('MaxPF', 'Highest Max PF', false, 'pts', (r) => r.maxpf);
  seasonRec('LowMaxPF', 'Lowest Max PF', true, 'pts', (r) => r.maxpf);
  seasonRec('Wins', 'Most wins', false, 'int', (r) => r.w, wl);
  seasonRec('Losses', 'Most losses', false, 'int', (r) => r.l, wl);
  seasonRec('Highs', 'Most weekly high scores', false, 'int', (r) => r.highs);
  seasonRec('Lows', 'Most weekly low scores', false, 'int', (r) => r.lows);
  seasonRec('Eff', 'Best lineup efficiency', false, 'pct', (r) => r.eff);
  seasonRec('WorstEff', 'Worst lineup efficiency', true, 'pct', (r) => r.eff);

  const runs = streakRuns(tws);
  for (const def of STREAKS) {
    const rows = runs
      .filter((r) => r.key === def.key)
      .map(
        (r): RecordRow => ({
          value: r.length,
          display: fmt(def.unit, r.length),
          holderId: r.ownerId,
          holder: nameOf(r.ownerId),
          detail: `${r.start.season} Wk ${r.start.week} – ${r.end.season === r.start.season ? '' : `${r.end.season} `}Wk ${r.end.week}${r.active ? ' · active' : ''}`,
          season: r.end.season,
          week: r.end.week,
          active: r.active,
        }),
      );
    add(def.key, def.label, 'Streaks', false, rows);
  }

  return { records, runs };
}

/** Records as of the cutoff, flagging any set during the cutoff week. */
export function recordsWithBreaks(h: History, cutoff: Cutoff) {
  const now = computeRecords(h, cutoff);
  const before = new Map(computeRecords(h, { season: cutoff.season, week: cutoff.week - 1 }).records.map((r) => [r.key, r]));
  for (const r of now.records) {
    const prev = before.get(r.key);
    if (r.group === 'YTD') {
      // Last week's YTD window was a week shorter, so compare holders, not values: it's news when
      // this season takes over the #1 spot. "Previous" is the best mark from anyone else.
      const held = prev && prev.season === r.season && prev.holderId === r.holderId;
      const other = r.top.find((x) => !(x.season === r.season && x.holderId === r.holderId));
      if (r.season === cutoff.season && !held && other) {
        r.broken = true;
        r.prev = { display: other.display, holder: other.holder, detail: other.detail };
      }
      continue;
    }
    if (prev && r.season === cutoff.season && r.week === cutoff.week && r.value !== prev.value) {
      r.broken = true;
      r.prev = { display: prev.display, holder: prev.holder, detail: prev.detail };
    }
  }
  return now;
}
