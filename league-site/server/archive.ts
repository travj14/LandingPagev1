import fs from 'node:fs/promises';
import path from 'node:path';
import { memo, nameOf, type Ctx } from './api.ts';
import type { SeasonData, Side } from './history.ts';
import { poolValue } from './pool.ts';
import { RECORD_GROUPS, recordsWithBreaks } from './records.ts';
import { computeStandings } from './standings.ts';

// History tab: record book, season archive, this week in history, milestones,
// Hall of Shame, the recap image archive and the pool.

const round2 = (n: number) => Math.round(n * 100) / 100;
const RECAP_DIR = path.resolve(import.meta.dirname, '../site/recaps');

interface Played {
  season: number;
  week: number;
  playoff: boolean;
  me: Side;
  opp: Side | null;
}

/** Every completed side in every season (byes included). */
function allSides(c: Ctx): Played[] {
  return memo(`sides|${c.fp}`, () =>
    c.h.seasons.flatMap((sd) =>
      sd.games
        .filter((g) => g.played && !g.live)
        .flatMap((g) => {
          const out: Played[] = [{ season: sd.season, week: g.week, playoff: g.playoff, me: g.a, opp: g.bye ? null : g.b }];
          if (!g.bye) out.push({ season: sd.season, week: g.week, playoff: g.playoff, me: g.b, opp: g.a });
          return out;
        })
        .filter((x) => x.me.ownerId),
    ),
  );
}

export function recordBook(c: Ctx) {
  return memo(`records|${c.fp}`, () => {
    const cutoff = { season: c.season.season, week: Math.max(1, c.completed) };
    const { records, runs } = recordsWithBreaks(c.h, cutoff);
    const name = nameOf(c);
    const tally = new Map(c.teams.map((t) => [t.id, { id: t.id, good: 0, bad: 0 }]));
    for (const r of records) {
      if (r.group === 'YTD') continue;
      for (const cr of r.credits) {
        const t = tally.get(cr.ownerId);
        if (t && cr.tone === 'good') t.good++;
        if (t && cr.tone === 'bad') t.bad++;
      }
    }
    return {
      through: cutoff,
      groups: RECORD_GROUPS,
      records: records.map((r) => ({
        key: r.key,
        label: r.label,
        group: r.group,
        display: r.display,
        holderId: r.holderId,
        holder: r.holder,
        detail: r.detail,
        season: r.season,
        week: r.week,
        tone: r.tone,
        broken: !!r.broken,
        prev: r.prev ?? null,
        top: r.top.map((x) => ({ season: x.season, week: x.week, display: x.display, holderId: x.holderId, holder: x.holder, detail: x.detail, active: !!x.active })),
      })),
      streaks: runs
        .filter((r) => r.active && r.length >= 2)
        .map((r) => {
          const rec = records.find((x) => x.key === r.key);
          return {
            label: r.label,
            unit: r.unit,
            id: r.ownerId,
            name: name(r.ownerId),
            length: r.length,
            since: `${r.start.season} Week ${r.start.week}`,
            record: rec ? { value: rec.value, holder: rec.holder } : null,
            isRecord: !!rec && rec.value === r.length && rec.holderId === r.ownerId,
          };
        })
        .sort((x, y) => (y.record ? y.length / y.record.value : 0) - (x.record ? x.length / x.record.value : 0)),
      tally: [...tally.values()].sort((x, y) => y.good - y.bad - (x.good - x.bad)),
    };
  });
}

function seasonSummary(c: Ctx, sd: SeasonData) {
  const done = sd.status === 'complete';
  const through = sd === c.season ? c.regThrough : sd.regWeeks;
  const rows = computeStandings(sd, through, nameOf(c));
  const final = done ? sd.bracket.find((m) => m.p === 1 && m.w) : null;
  const owner = (rid: number | null) => (rid ? (sd.ownerByRid.get(rid) ?? null) : null);
  // Bracket games with their scores (playoff week = regWeeks + round).
  const bracket = done
    ? sd.bracket
        .filter((m) => m.t1 && m.t2)
        .map((m) => {
          const a = owner(m.t1), b = owner(m.t2);
          const g = sd.games.find((x) => x.week === sd.regWeeks + m.r && !x.bye && ((x.a.ownerId === a && x.b.ownerId === b) || (x.a.ownerId === b && x.b.ownerId === a)));
          const pts = (id: string | null) => (g ? (g.a.ownerId === id ? g.a.pts : g.b.pts) : null);
          const label = m.p === 1 ? 'Championship' : m.p === 3 ? 'Third place' : m.p ? `${m.p}th place` : `Round ${m.r}`;
          return { round: m.r, label, a, b, aPts: pts(a), bPts: pts(b), winner: owner(m.w) };
        })
        .sort((x, y) => x.round - y.round)
    : [];
  const sides = allSides(c).filter((x) => x.season === sd.season);
  const high = sides.reduce<Played | null>((b, x) => (!b || x.me.pts > b.me.pts ? x : b), null);
  return {
    season: sd.season,
    status: done ? 'complete' : 'in progress',
    champion: owner(final?.w ?? null),
    runnerUp: owner(final?.l ?? null),
    standings: rows.map((r) => ({ id: r.ownerId, rank: r.rank, w: r.w, l: r.l, t: r.t, pf: r.pf, maxpf: r.maxpf })),
    bracket,
    high: high && { id: high.me.ownerId, pts: high.me.pts, week: high.week },
  };
}

function thisWeekInHistory(c: Ctx) {
  const week = c.h.currentWeek;
  return c.h.seasons
    .filter((sd) => sd !== c.season)
    .map((sd) => {
      const games = sd.games.filter((g) => g.week === week && g.played && !g.bye);
      if (!games.length) return null;
      const res = games.map((g) => {
        const [w, l] = g.a.pts >= g.b.pts ? [g.a, g.b] : [g.b, g.a];
        return { winner: w.ownerId, loser: l.ownerId, wPts: w.pts, lPts: l.pts, margin: round2(w.pts - l.pts) };
      });
      const sides = games.flatMap((g) => [g.a, g.b]);
      const high = sides.reduce((b, s) => (s.pts > b.pts ? s : b));
      return { season: sd.season, week, playoff: week > sd.regWeeks, results: res, high: { id: high.ownerId, pts: high.pts } };
    })
    .filter(Boolean)
    .reverse();
}

// Career milestones: round numbers of each stat. Regular-season wins only; points include playoffs and byes, games include playoffs.
const MILESTONES: { key: string; step: number; near: number; first?: boolean; unit: [string, string]; label: (n: number) => string; value: (x: Played) => number }[] = [
  { key: 'pts', step: 1000, near: 400, unit: ['pts', 'pts'], label: (n) => `${n.toLocaleString('en-US')} career points`, value: (x) => x.me.pts },
  { key: 'wins', step: 5, near: 2, unit: ['win', 'wins'], label: (n) => `${n} career wins`, value: (x) => (!x.playoff && x.opp && x.me.pts > x.opp.pts ? 1 : 0) },
  { key: 'games', step: 25, near: 2, unit: ['game', 'games'], label: (n) => `${n} career games`, value: (x) => (x.opp ? 1 : 0) },
  { key: 'big', step: 5, near: 2, unit: ['game', 'games'], label: (n) => `${n} career 200-point games`, value: (x) => (x.me.pts >= 200 ? 1 : 0) },
  { key: 'huge', step: 5, near: 1, first: true, unit: ['game', 'games'], label: (n) => (n === 1 ? 'first career 250-point game' : `${n} career 250-point games`), value: (x) => (x.me.pts >= 250 ? 1 : 0) },
];

const sumOf = (list: Played[], m: (typeof MILESTONES)[number]) => list.reduce((s, x) => s + m.value(x), 0);

/** Round numbers each owner is about to reach. */
function milestones(c: Ctx) {
  const out: { id: string; text: string; need: number; unit: string }[] = [];
  for (const t of c.teams) {
    const mine = allSides(c).filter((x) => x.me.ownerId === t.id);
    for (const m of MILESTONES) {
      if (!m.near) continue;
      const have = sumOf(mine, m);
      const next = Math.floor(have / m.step + 1e-9) * m.step + m.step;
      const need = round2(next - have);
      if (need <= m.near) out.push({ id: t.id, text: m.label(next), need, unit: m.key === 'pts' ? 'pts' : m.unit[need === 1 ? 0 : 1] });
    }
  }
  return out.sort((x, y) => (x.unit === 'pts' ? x.need / 100 : x.need) - (y.unit === 'pts' ? y.need / 100 : y.need));
}

/** Milestones reached in the last completed week of this season. */
export function weekMilestones(c: Ctx) {
  return memo(`weekMilestones|${c.fp}`, () => {
    const week = c.completed;
    if (week < 1) return { season: c.season.season, week, reached: [] };
    const isWeek = (x: Played) => x.season === c.season.season && x.week === week;
    const before = (x: Played) => x.season < c.season.season || (x.season === c.season.season && x.week < week);
    const reached: { id: string; text: string; detail: string }[] = [];
    for (const t of c.teams) {
      const mine = allSides(c).filter((x) => x.me.ownerId === t.id);
      const now = mine.filter((x) => isWeek(x));
      if (!now.length) continue;
      const prev = mine.filter(before);
      for (const m of MILESTONES) {
        const a = sumOf(prev, m), b = a + sumOf(now, m);
        const crossed = Math.floor(b / m.step + 1e-9);
        const n = m.first && a === 0 && b > 0 ? 1 : crossed * m.step;
        if ((crossed > Math.floor(a / m.step + 1e-9) && crossed > 0) || n === 1) {
          reached.push({ id: t.id, text: m.label(n), detail: m.key === 'pts' ? `${round2(b).toLocaleString('en-US')} total` : `Week ${week}` });
        }
      }
    }
    return { season: c.season.season, week, reached };
  });
}

function hallOfShame(c: Ctx) {
  const sides = allSides(c);
  const top = <T>(list: T[], key: (x: T) => number, n = 5) => [...list].sort((a, b) => key(b) - key(a)).slice(0, n);
  const at = (x: Played) => ({ season: x.season, week: x.week, playoff: x.playoff });
  const losses = sides.filter((x) => x.opp && x.me.pts < x.opp.pts);
  return {
    lowest: top(sides, (x) => -x.me.pts).map((x) => ({ id: x.me.ownerId, pts: x.me.pts, opp: x.opp?.ownerId ?? null, ...at(x) })),
    blowouts: top(losses, (x) => x.opp!.pts - x.me.pts).map((x) => ({ id: x.me.ownerId, by: x.opp!.ownerId, margin: round2(x.opp!.pts - x.me.pts), pts: x.me.pts, oppPts: x.opp!.pts, ...at(x) })),
    lineupLosses: top(
      losses.filter((x) => x.me.maxPts > x.opp!.pts),
      (x) => x.me.maxPts - x.me.pts,
    ).map((x) => ({ id: x.me.ownerId, by: x.opp!.ownerId, pts: x.me.pts, best: x.me.maxPts, oppPts: x.opp!.pts, left: round2(x.me.maxPts - x.me.pts), ...at(x) })),
    benched: top(sides, (x) => x.me.maxPts - x.me.pts).map((x) => ({ id: x.me.ownerId, left: round2(x.me.maxPts - x.me.pts), pts: x.me.pts, ...at(x) })),
  };
}

/** Recap images dropped into site/recaps/, newest first. Name them like 2026-week-08.png. */
async function recaps() {
  try {
    const files = (await fs.readdir(RECAP_DIR)).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
    return files
      .map((f) => {
        const m = f.match(/(\d{4})\D+(\d{1,2})/);
        return { file: `/recaps/${encodeURIComponent(f)}`, season: m ? Number(m[1]) : null, week: m ? Number(m[2]) : null, name: f };
      })
      .sort((x, y) => (y.season ?? 0) - (x.season ?? 0) || (y.week ?? 0) - (x.week ?? 0) || y.name.localeCompare(x.name));
  } catch {
    return [];
  }
}

export async function historyPage(c: Ctx) {
  const fixed = memo(`historyPage|${c.fp}`, () => ({
    seasons: [...c.h.seasons].reverse().map((sd) => seasonSummary(c, sd)),
    thisWeek: thisWeekInHistory(c),
    milestones: milestones(c),
    weekMilestones: weekMilestones(c),
    shame: hallOfShame(c),
  }));
  return { ...fixed, recaps: await recaps(), pool: await poolValue(c.cfg.pool) };
}
