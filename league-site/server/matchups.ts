import { memo, type Ctx } from './api.ts';
import type { Game, Side } from './history.ts';

// Matchups tab: week browser with lineups, the all-time head-to-head grid and rivalry pages.

const round2 = (n: number) => Math.round(n * 100) / 100;

function sideOut(c: Ctx, s: Side) {
  const p = (pid: string, pts: number) => {
    const info = c.h.players[pid];
    return { name: info?.name ?? pid, pos: info?.pos ?? '', team: info?.team ?? null, pts };
  };
  return {
    id: s.ownerId,
    pts: s.pts,
    maxPts: s.maxPts,
    proj: s.proj,
    left: round2(s.maxPts - s.pts),
    starters: s.starters.map((x) => p(x.pid, x.pts)),
    bench: s.bench.map((x) => p(x.pid, x.pts)).sort((a, b) => b.pts - a.pts),
  };
}

/** Seasons and their weeks that have games to show (current season: through the current week). */
export function weekList(c: Ctx) {
  return c.h.seasons
    .map((sd) => ({
      season: sd.season,
      regWeeks: sd.regWeeks,
      weeks: [...new Set(sd.games.filter((g) => g.played || (sd === c.season && g.week === c.h.currentWeek)).map((g) => g.week))].sort((a, b) => a - b),
    }))
    .filter((s) => s.weeks.length)
    .reverse();
}

export function weekPage(c: Ctx, season: number, week: number) {
  const sd = c.h.seasons.find((s) => s.season === season);
  if (!sd) return null;
  const games = sd.games.filter((g) => g.week === week);
  if (!games.length) return null;
  return {
    season,
    week,
    playoff: week > sd.regWeeks,
    live: games.some((g) => g.live && (g.a.pts > 0 || g.b.pts > 0)),
    games: games.map((g) => {
      const a = sideOut(c, g.a);
      const b = g.bye ? null : sideOut(c, g.b);
      const final = g.played && !g.live;
      // Lost to the lineup: the loser's best possible lineup would have beaten the winner's score.
      let lineupLoss: string | null = null;
      if (final && b && a.pts !== b.pts) {
        const [w, l] = a.pts > b.pts ? [a, b] : [b, a];
        if (l.maxPts > w.pts) lineupLoss = l.id;
      }
      return { key: `${g.week}-${g.matchupId}`, bye: g.bye, playoff: g.playoff, live: g.live && g.played, played: g.played, a, b, lineupLoss };
    }),
  };
}

type Rec = { w: number; l: number; t: number };
const bump = (r: Rec, me: number, opp: number) => (me > opp ? r.w++ : me < opp ? r.l++ : r.t++);

/** Every completed meeting between two owners, oldest first. */
function meetings(c: Ctx, a: string, b: string) {
  const out: { season: number; week: number; playoff: boolean; a: number; b: number }[] = [];
  for (const sd of c.h.seasons) {
    for (const g of sd.games as Game[]) {
      if (g.bye || !g.played || g.live) continue;
      if (g.a.ownerId === a && g.b.ownerId === b) out.push({ season: sd.season, week: g.week, playoff: g.playoff, a: g.a.pts, b: g.b.pts });
      else if (g.a.ownerId === b && g.b.ownerId === a) out.push({ season: sd.season, week: g.week, playoff: g.playoff, a: g.b.pts, b: g.a.pts });
    }
  }
  return out.sort((x, y) => x.season - y.season || x.week - y.week);
}

export function h2hGrid(c: Ctx) {
  return memo(`h2h|${c.fp}`, () => {
    const ids = c.teams.map((t) => t.id);
    const cells: Record<string, Record<string, { reg: Rec; post: Rec }>> = {};
    for (const a of ids) {
      cells[a] = {};
      for (const b of ids) {
        if (a === b) continue;
        const reg = { w: 0, l: 0, t: 0 };
        const post = { w: 0, l: 0, t: 0 };
        for (const m of meetings(c, a, b)) bump(m.playoff ? post : reg, m.a, m.b);
        cells[a][b] = { reg, post };
      }
    }
    return { ids, cells };
  });
}

export function rivalry(c: Ctx, slugA: string, slugB: string) {
  const ta = c.bySlug.get(slugA), tb = c.bySlug.get(slugB);
  if (!ta || !tb || ta === tb) return null;
  return memo(`rivalry|${c.fp}|${ta.id}|${tb.id}`, () => {
    const list = meetings(c, ta.id, tb.id);
    const reg = { w: 0, l: 0, t: 0 };
    const post = { w: 0, l: 0, t: 0 };
    for (const m of list) bump(m.playoff ? post : reg, m.a, m.b);

    let streak = '';
    if (list.length) {
      const last = list[list.length - 1];
      const side = last.a > last.b ? 'a' : last.a < last.b ? 'b' : null;
      let n = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i].a > list[i].b ? 'a' : list[i].a < list[i].b ? 'b' : null;
        if (s !== side) break;
        n++;
      }
      streak = side ? `${side === 'a' ? ta.name : tb.name} has won ${n} straight` : 'Last meeting was a tie';
    }
    const margin = (m: (typeof list)[number]) => Math.abs(m.a - m.b);
    const blowout = list.reduce<(typeof list)[number] | null>((b, m) => (!b || margin(m) > margin(b) ? m : b), null);
    const closest = list.reduce<(typeof list)[number] | null>((b, m) => (!b || margin(m) < margin(b) ? m : b), null);
    const avg = (k: 'a' | 'b') => (list.length ? round2(list.reduce((s, m) => s + m[k], 0) / list.length) : null);
    const upcoming = c.season.games
      .filter((g) => !g.played && !g.bye && !g.playoff && ((g.a.ownerId === ta.id && g.b.ownerId === tb.id) || (g.a.ownerId === tb.id && g.b.ownerId === ta.id)))
      .map((g) => ({ season: c.season.season, week: g.week }));

    return {
      a: ta.id,
      b: tb.id,
      reg,
      post,
      streak,
      avgA: avg('a'),
      avgB: avg('b'),
      blowout: blowout && { ...blowout, margin: round2(margin(blowout)) },
      closest: closest && { ...closest, margin: round2(margin(closest)) },
      meetings: [...list].reverse(),
      upcoming,
    };
  });
}
