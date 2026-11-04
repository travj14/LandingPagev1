import { createHash } from 'node:crypto';
import { refreshState, type Game, type History, type SeasonData, type Side } from './history.ts';
import { samplePools } from './models.ts';
import { buildPickBoard } from './picks.ts';
import { poolValue } from './pool.ts';
import { get } from './sleeper.ts';
import { siteConfig, type SiteConfig } from './siteConfig.ts';
import { gameKey, remainingGames, simulate, type Model, type SimResult } from './sim.ts';
import { computeStandings, regularGames, type StandingRow } from './standings.ts';
import type { SleeperState } from './types.ts';

// Builds the JSON behind each page. Everything is computed from the shared
// history (server/history.ts) and cached by a fingerprint of the completed
// games, so live score updates don't re-run the simulations.

export interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  color: number; // 1-based categorical slot, fixed per owner
  avatar: string | null; // thumbnail URL
}

export interface Ctx {
  h: History;
  season: SeasonData;
  cfg: SiteConfig;
  completed: number; // last completed week (0 before the season)
  regThrough: number; // completed weeks that count for standings
  teams: TeamInfo[];
  byId: Map<string, TeamInfo>;
  bySlug: Map<string, TeamInfo>;
  fp: string; // fingerprint of everything the simulations depend on
}

const cache = new Map<string, unknown>();
export function memo<T>(key: string, fn: () => T): T {
  if (cache.has(key)) {
    const v = cache.get(key) as T;
    cache.delete(key);
    cache.set(key, v); // most recently used last
    return v;
  }
  const v = fn();
  cache.set(key, v);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return v;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function context(h: History): Promise<Ctx> {
  const cfg = await siteConfig();
  const season = h.current;
  const completed = season.status === 'complete' ? season.lastWeek : Math.max(0, h.currentWeek - 1);
  const regThrough = Math.min(completed, season.regWeeks);
  const owners = [...season.owners].sort((x, y) => season.ridByOwner.get(x)! - season.ridByOwner.get(y)!);
  const teams = owners.map((id, i) => {
    const name = h.teams.get(id)?.name ?? id;
    const avatar = h.teams.get(id)?.avatar;
    return { id, name, slug: slugify(name), color: i + 1, avatar: avatar ? `https://sleepercdn.com/avatars/thumbs/${avatar}` : null };
  });

  const hash = createHash('sha1');
  hash.update(`${season.season}|${completed}|${cfg.sampleSize}|${cfg.offseasonWeight}|${h.seasons.length}`);
  for (const sd of h.seasons) {
    for (const g of sd.games) {
      if (sd === season && g.week > completed) {
        hash.update(`${g.week}:${g.matchupId}:${g.a.ownerId}:${g.b.ownerId};`); // schedule only
        continue;
      }
      hash.update(`${sd.season}:${g.week}:${g.matchupId}:${g.a.pts}:${g.b.pts}:${g.a.maxPts}:${g.b.maxPts};`);
    }
  }
  for (const t of season.transactions) hash.update(t.transaction_id);
  for (const [rid, players] of season.rosters) hash.update(`${rid}:${players.join(',')}`);

  return {
    h,
    season,
    cfg,
    completed,
    regThrough,
    teams,
    byId: new Map(teams.map((t) => [t.id, t])),
    bySlug: new Map(teams.map((t) => [t.slug, t])),
    fp: hash.digest('hex').slice(0, 16),
  };
}

export const nameOf = (c: Ctx) => (id: string) => c.byId.get(id)?.name ?? c.h.teams.get(id)?.name ?? id;
export const rowsAt = (c: Ctx, week: number) => memo(`rows|${c.fp}|${week}`, () => computeStandings(c.season, week, nameOf(c)));
const poolsAt = (c: Ctx, week: number) =>
  memo(`pools|${c.fp}|${week}`, () => samplePools(c.h, c.season.season, week, { sampleSize: c.cfg.sampleSize, offseasonWeight: c.cfg.offseasonWeight }));

export const parseModel = (v: unknown, c: Ctx): Model => (v === 'coin' || v === 'sample' ? v : c.cfg.model);

/** "9-1:henry,9-2:josh" -> Map(gameKey -> ownerId). Unknown games or teams are ignored. */
export function parsePicks(c: Ctx, raw: unknown): Map<string, string> {
  const picks = new Map<string, string>();
  if (typeof raw !== 'string' || !raw) return picks;
  const open = new Map(remainingGames(c.season, c.regThrough).filter((g) => !g.bye).map((g) => [gameKey(g), g]));
  for (const part of raw.split(',').slice(0, 200)) {
    const [key, slug] = part.split(':');
    const g = open.get(key);
    const team = c.bySlug.get(slug ?? '');
    if (g && team && (g.a.ownerId === team.id || g.b.ownerId === team.id)) picks.set(key, team.id);
  }
  return picks;
}

const picksKey = (picks: Map<string, string>) => [...picks].sort().map(([k, v]) => `${k}:${v}`).join(',');

export function sim(c: Ctx, week: number, model: Model, picks = new Map<string, string>()): SimResult {
  return memo(`sim|${c.fp}|${week}|${model}|${picksKey(picks)}`, () =>
    simulate({
      season: c.season,
      throughWeek: week,
      rows: rowsAt(c, week),
      model,
      picks,
      pools: model === 'sample' ? poolsAt(c, week) : undefined,
    }),
  );
}

/** Clinch / elimination is model-independent: it always comes from the exact coin-flip pass. */
export const clinchOf = (c: Ctx, picks: Map<string, string>) => sim(c, c.regThrough, 'coin', picks).clinch;

/**
 * A simulation can put a team in (or out) every run without it being certain.
 * Show 100% / 0% only when it's clinched / eliminated; otherwise just under / over.
 */
export function honest(c: Ctx, picks: Map<string, string>, id: string, odds: number) {
  const status = clinchOf(c, picks)?.[id]?.status;
  if (odds >= 100 && status !== 'clinched') return 99.99;
  if (odds <= 0 && status !== 'eliminated') return 0.01;
  return odds;
}

// ---------------------------------------------------------------------------

export function meta(c: Ctx) {
  const { cfg } = c;
  return {
    league: c.season.name,
    season: c.season.season,
    status: c.season.status,
    currentWeek: c.h.currentWeek,
    completedWeek: c.completed,
    regWeeks: c.season.regWeeks,
    lastWeek: c.season.lastWeek,
    playoffTeams: c.season.playoffTeams,
    teams: c.teams,
    dataAsOf: c.h.builtAt,
    ...refreshState(),
    config: {
      siteTitle: cfg.siteTitle,
      theme: cfg.theme,
      apple: cfg.apple,
      smoothScroll: cfg.smoothScroll,
      glide: cfg.glide,
      reveal: cfg.reveal,
      model: cfg.model,
      sampleSize: cfg.sampleSize,
      offseasonWeight: cfg.offseasonWeight,
    },
  };
}

function scoresByWeek(season: SeasonData, through: number) {
  const out = new Map<string, number[]>();
  for (const g of regularGames(season, through)) for (const s of g.bye ? [g.a] : [g.a, g.b]) if (s.ownerId) out.set(s.ownerId, [...(out.get(s.ownerId) ?? []), s.pts]);
  return out;
}

/** Power score: 50% all-play win %, 30% PF per week, 20% last-3-weeks average (each scaled 0–1 across the league). */
function powerRankings(c: Ctx, rows: StandingRow[]) {
  const scores = scoresByWeek(c.season, c.regThrough);
  const stat = rows.map((r) => {
    const s = scores.get(r.ownerId) ?? [];
    const ap = r.allPlay.w + r.allPlay.l + r.allPlay.t ? (r.allPlay.w + r.allPlay.t / 2) / (r.allPlay.w + r.allPlay.l + r.allPlay.t) : 0.5;
    const ppw = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    const last = s.slice(-3);
    const recent = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0;
    return { id: r.ownerId, ap, ppw, recent };
  });
  const scale = (vals: number[]) => {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  };
  const sp = scale(stat.map((s) => s.ppw));
  const sr = scale(stat.map((s) => s.recent));
  const scored = stat.map((s) => ({ id: s.id, ap: s.ap, score: Math.round((0.5 * s.ap + 0.3 * sp(s.ppw) + 0.2 * sr(s.recent)) * 1000) / 10 }));
  scored.sort((x, y) => y.score - x.score);
  return new Map(scored.map((s, i) => [s.id, { rank: i + 1, score: s.score, allPlayPct: Math.round(s.ap * 1000) / 10 }]));
}

function oddsPayload(c: Ctx, model: Model, picks: Map<string, string>) {
  const r = sim(c, c.regThrough, model, picks);
  const clinch = clinchOf(c, picks);
  return {
    method: r.method,
    runs: r.runs,
    teams: Object.fromEntries(
      c.teams.map((t) => [t.id, { odds: honest(c, picks, t.id, r.odds[t.id]), seeds: r.seeds[t.id], expWins: r.expWins[t.id], clinch: clinch?.[t.id] ?? null }]),
    ),
  };
}

export function standings(c: Ctx, model: Model) {
  return memo(`standings|${c.fp}|${model}`, () => {
    const rows = rowsAt(c, c.regThrough);
    const power = powerRankings(c, rows);
    const remaining = remainingGames(c.season, c.regThrough)
      .filter((g) => !g.bye)
      .map((g) => ({ key: gameKey(g), week: g.week, a: g.a.ownerId!, b: g.b.ownerId! }));
    return {
      week: c.regThrough,
      model,
      rows: rows.map((r) => {
        const pw = power.get(r.ownerId)!;
        return {
          id: r.ownerId,
          rank: r.rank,
          w: r.w,
          l: r.l,
          t: r.t,
          pf: r.pf,
          pa: r.pa,
          maxpf: r.maxpf,
          eff: r.maxpf ? Math.round((r.pf / r.maxpf) * 1000) / 10 : null,
          gp: r.gp,
          streak: r.streak,
          allPlay: r.allPlay,
          allPlayPct: pw.allPlayPct,
          luck: Math.round((r.w + r.t / 2 - (pw.allPlayPct / 100) * r.gp) * 10) / 10,
          power: { rank: pw.rank, score: pw.score },
        };
      }),
      remaining,
      ...oddsPayload(c, model, new Map()),
    };
  });
}

export function whatIf(c: Ctx, model: Model, picks: Map<string, string>) {
  return { model, picks: Object.fromEntries(picks), ...oddsPayload(c, model, picks) };
}

export function oddsHistory(c: Ctx, model: Model) {
  return memo(`history|${c.fp}|${model}`, () => {
    const weeks: number[] = [];
    const series: Record<string, number[]> = Object.fromEntries(c.teams.map((t) => [t.id, []]));
    for (let w = 1; w <= c.regThrough; w++) {
      const r = sim(c, w, model);
      weeks.push(w);
      for (const t of c.teams) series[t.id].push(r.odds[t.id] ?? 0);
    }
    return { model, weeks, series };
  });
}

export function draft(c: Ctx, model: Model) {
  return memo(`draft|${c.fp}|${model}`, () => {
    const rows = rowsAt(c, c.regThrough);
    // Ownership as of now, so trades made this week already count.
    const board = buildPickBoard(c.season, c.season.lastWeek, rows, nameOf(c));
    const r = sim(c, c.regThrough, model);
    const firsts = board.rounds[0]?.picks ?? [];
    return {
      season: board.season,
      rounds: board.rounds.map((rd) => ({
        round: rd.round,
        picks: rd.picks.map((p) => ({ pick: p.pick, slot: p.slot, original: p.originalId, owner: p.ownerId, traded: p.traded, record: p.originalRecord, maxpf: p.originalMaxpf, rank: p.originalRank })),
      })),
      odds: c.teams.map((t) => ({
        original: t.id,
        owner: firsts.find((p) => p.originalId === t.id)?.ownerId ?? t.id,
        slots: r.slots[t.id],
      })),
      method: r.method,
      runs: r.runs,
    };
  });
}

// ---------------------------------------------------------------------------
// Home

const sideOut = (c: Ctx, s: Side) => {
  const top = s.starters.reduce<{ pid: string; pts: number } | null>((best, p) => (!best || p.pts > best.pts ? p : best), null);
  return {
    id: s.ownerId,
    pts: s.pts,
    proj: s.proj,
    maxPts: s.maxPts,
    top: top && top.pts ? { name: c.h.players[top.pid]?.name ?? top.pid, pos: c.h.players[top.pid]?.pos ?? '', pts: top.pts } : null,
  };
};

const gameOut = (c: Ctx, g: Game) => ({ key: gameKey(g), week: g.week, playoff: g.playoff, bye: g.bye, played: g.played, a: sideOut(c, g.a), b: g.bye ? null : sideOut(c, g.b) });

function awards(c: Ctx, week: number) {
  const games = c.season.games.filter((g) => g.week === week && g.played);
  if (!games.length) return null;
  const sides = games.flatMap((g) => (g.bye ? [g.a] : [g.a, g.b])).filter((s) => s.ownerId);
  const sorted = [...sides].sort((x, y) => x.pts - y.pts);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2].pts : (sorted[sorted.length / 2 - 1].pts + sorted[sorted.length / 2].pts) / 2;
  const real = games.filter((g) => !g.bye);
  const res = real.map((g) => {
    const [win, lose] = g.a.pts >= g.b.pts ? [g.a, g.b] : [g.b, g.a];
    return { win, lose, margin: Math.round((win.pts - lose.pts) * 100) / 100 };
  });
  const pick = <T>(list: T[], score: (x: T) => number) => (list.length ? list.reduce((b, x) => (score(x) > score(b) ? x : b)) : null);
  const side = (s: Side, extra: Record<string, unknown> = {}) => ({ id: s.ownerId, pts: s.pts, ...extra });
  const blowout = pick(res, (r) => r.margin);
  const closest = pick(res, (r) => -r.margin);
  const lucky = pick(res.filter((r) => r.win.pts < median), (r) => -r.win.pts);
  const unlucky = pick(res.filter((r) => r.lose.pts > median), (r) => r.lose.pts);
  const bench = pick(sides, (s) => s.maxPts - s.pts);
  return {
    week,
    median: Math.round(median * 100) / 100,
    high: side(sorted[sorted.length - 1]),
    low: side(sorted[0]),
    blowout: blowout && { winner: side(blowout.win), loser: side(blowout.lose), margin: blowout.margin },
    closest: closest && { winner: side(closest.win), loser: side(closest.lose), margin: closest.margin },
    lucky: lucky && { winner: side(lucky.win), loser: side(lucky.lose) },
    unlucky: unlucky && { winner: side(unlucky.win), loser: side(unlucky.lose) },
    bench: bench && side(bench, { left: Math.round((bench.maxPts - bench.pts) * 100) / 100 }),
  };
}

/** UTC instant for a wall-clock time in America/New_York. */
function easternTime(y: number, m: number, d: number, hh: number, mm: number) {
  for (const offset of [4, 5]) {
    const t = new Date(Date.UTC(y, m - 1, d, hh + offset, mm));
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(t);
    if (Number(local) === hh) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, hh + 5, mm));
}

/** Thursday-night kickoff of an NFL week (8:15 PM ET), from Sleeper's season start date. */
function kickoff(start: string, week: number) {
  const [y, m, d] = start.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, d));
  while (first.getUTCDay() !== 4) first.setUTCDate(first.getUTCDate() + 1);
  first.setUTCDate(first.getUTCDate() + 7 * (week - 1));
  return easternTime(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate(), 20, 15);
}

async function countdowns(c: Ctx) {
  const out: { label: string; at: string; note?: string; done: string }[] = []; // done: shown once the time passes
  const now = Date.now();
  let state: SleeperState | null = null;
  try {
    state = await get<SleeperState & { season_start_date?: string }>('/state/nfl', 60e3);
  } catch {
    // Sleeper unreachable and nothing cached: skip the schedule-based ones.
  }
  const start = (state as { season_start_date?: string } | null)?.season_start_date;
  if (start && state?.season === String(c.season.season)) {
    const next = c.completed + 1;
    if (next <= c.season.lastWeek) {
      const t = kickoff(start, next);
      if (t.getTime() > now) out.push({ label: `Week ${next} kickoff`, at: t.toISOString(), note: 'Thursday night game', done: 'Kicked off' });
    }
    const po = kickoff(start, c.season.regWeeks + 1);
    if (po.getTime() > now) out.push({ label: 'Playoffs start', at: po.toISOString(), note: `Week ${c.season.regWeeks + 1}`, done: 'Playoffs underway' });
  }
  if (c.cfg.tradeDeadline && Date.parse(c.cfg.tradeDeadline) > now) out.push({ label: 'Trade deadline', at: new Date(c.cfg.tradeDeadline).toISOString(), done: 'Deadline passed' });
  if (c.cfg.rookieDraft && Date.parse(c.cfg.rookieDraft) > now) out.push({ label: 'Rookie draft', at: new Date(c.cfg.rookieDraft).toISOString(), done: 'Draft underway' });
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/** Playoff stakes of each regular-season game in a week: odds with each side winning. */
function stakes(c: Ctx, week: number, model: Model) {
  if (week > c.season.regWeeks || week <= c.regThrough) return [];
  const base = sim(c, c.regThrough, model);
  return c.season.games
    .filter((g) => g.week === week && !g.bye && !g.playoff)
    .map((g) => {
      const key = gameKey(g);
      const aWin = sim(c, c.regThrough, model, new Map([[key, g.a.ownerId!]]));
      const bWin = sim(c, c.regThrough, model, new Map([[key, g.b.ownerId!]]));
      const side = (id: string, win: SimResult, loss: SimResult) => ({
        id,
        now: honest(c, new Map(), id, base.odds[id]),
        win: honest(c, new Map([[key, id]]), id, win.odds[id]),
        loss: honest(c, new Map([[key, id === g.a.ownerId ? g.b.ownerId! : g.a.ownerId!]]), id, loss.odds[id]),
        swing: Math.round((win.odds[id] - loss.odds[id]) * 100) / 100,
      });
      const a = side(g.a.ownerId!, aWin, bWin);
      const b = side(g.b.ownerId!, bWin, aWin);
      return { key, a, b, total: Math.round((a.swing + b.swing) * 100) / 100 };
    })
    .sort((x, y) => y.total - x.total);
}

function headline(c: Ctx, model: Model): string | null {
  const w = c.regThrough;
  if (w < 1) return null;
  const name = nameOf(c);
  const now = sim(c, w, model);
  const prevClinch = w > 1 ? sim(c, w - 1, 'coin').clinch : null;
  const clinch = sim(c, w, 'coin').clinch;
  if (clinch) {
    for (const t of c.teams) {
      const was = prevClinch?.[t.id]?.status;
      const is = clinch[t.id]?.status;
      if (is === 'clinched' && was !== 'clinched') return `${t.name} clinched a playoff spot in Week ${w}`;
    }
    for (const t of c.teams) {
      if (clinch[t.id]?.status === 'eliminated' && prevClinch?.[t.id]?.status !== 'eliminated') return `${t.name} was eliminated from playoff contention in Week ${w}`;
    }
  }
  if (w < 2) return null;
  const prev = sim(c, w - 1, model);
  const mover = c.teams.map((t) => ({ t, d: now.odds[t.id] - prev.odds[t.id] })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0];
  if (!mover || Math.abs(mover.d) < 1) return null;
  const pts = Math.round(Math.abs(mover.d));
  return `${name(mover.t.id)}'s playoff odds ${mover.d > 0 ? 'jump' : 'drop'} ${pts} pts to ${Math.round(now.odds[mover.t.id])}% after Week ${w}`;
}

export async function home(c: Ctx, model: Model) {
  const cur = c.h.currentWeek;
  const curGames = c.season.games.filter((g) => g.week === cur);
  const started = curGames.some((g) => g.a.pts > 0 || g.b.pts > 0);
  const done = c.season.status === 'complete';
  const week = done ? c.season.lastWeek : cur;
  const status: 'upcoming' | 'live' | 'final' = done ? 'final' : started ? 'live' : 'upcoming';
  const games = c.season.games.filter((g) => g.week === week).map((g) => gameOut(c, g));
  const lastResults = status === 'upcoming' && c.completed >= 1 ? c.season.games.filter((g) => g.week === c.completed).map((g) => gameOut(c, g)) : [];

  const fixed = memo(`home|${c.fp}|${model}`, () => {
    const rows = rowsAt(c, c.regThrough);
    const odds = sim(c, c.regThrough, model);
    return {
      stakes: stakes(c, c.regThrough + 1, model),
      awards: awards(c, c.completed),
      headline: headline(c, model),
      top: rows.map((r) => ({ id: r.ownerId, rank: r.rank, w: r.w, l: r.l, t: r.t, pf: r.pf, odds: honest(c, new Map(), r.ownerId, odds.odds[r.ownerId]) })),
    };
  });

  return { model, week, status, playoff: week > c.season.regWeeks, games, lastResults, countdowns: await countdowns(c), pool: await poolValue(c.cfg.pool), ...fixed };
}
