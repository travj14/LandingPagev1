import { round2, type Game, type SeasonData } from './history.ts';

export type Result = 'W' | 'L' | 'T';

export interface StandingRow {
  ownerId: string;
  name: string;
  rank: number;
  w: number;
  l: number;
  t: number;
  pf: number;
  pa: number;
  maxpf: number;
  gp: number; // games with a decision (byes excluded)
  results: { week: number; result: Result }[];
  streak: string; // e.g. "W3"
  allPlay: { w: number; l: number; t: number }; // vs. every other team, every week
  odds: number | null;
}

/** Regular-season games that count as of `throughWeek`. */
export function regularGames(season: SeasonData, throughWeek: number): Game[] {
  return season.games
    .filter((g) => !g.playoff && g.played && g.week <= throughWeek)
    .sort((x, y) => x.week - y.week);
}

export function sortStandings<T extends { w: number; l: number; t: number; pf: number }>(rows: T[]): T[] {
  // Win total (ties = half), then fewest losses, then Points For.
  return rows.sort((x, y) => y.w + y.t / 2 - (x.w + x.t / 2) || x.l - y.l || y.pf - x.pf);
}

export function streakOf(results: { result: Result }[]): string {
  if (!results.length) return '';
  const last = results[results.length - 1].result;
  let n = 0;
  for (let i = results.length - 1; i >= 0 && results[i].result === last; i--) n++;
  return `${last}${n}`;
}

/**
 * Standings as of `throughWeek`. Team 8 (bye) games add PF and Max PF but
 * no win, loss, or PA.
 */
export function computeStandings(
  season: SeasonData,
  throughWeek: number,
  nameOf: (ownerId: string) => string,
): StandingRow[] {
  const rows = new Map<string, StandingRow>(
    season.owners.map((ownerId) => [
      ownerId,
      { ownerId, name: nameOf(ownerId), rank: 0, w: 0, l: 0, t: 0, pf: 0, pa: 0, maxpf: 0, gp: 0, results: [], streak: '', allPlay: { w: 0, l: 0, t: 0 }, odds: null },
    ]),
  );

  for (const g of regularGames(season, throughWeek)) {
    for (const [side, opp] of g.bye ? [[g.a, null] as const] : [[g.a, g.b] as const, [g.b, g.a] as const]) {
      const row = rows.get(side.ownerId!);
      if (!row) continue;
      row.pf += side.pts;
      row.maxpf += side.maxPts;
      if (!opp) continue;
      row.pa += opp.pts;
      row.gp++;
      const result: Result = side.pts > opp.pts ? 'W' : side.pts < opp.pts ? 'L' : 'T';
      if (result === 'W') row.w++;
      else if (result === 'L') row.l++;
      else row.t++;
      row.results.push({ week: g.week, result });
    }
  }

  // Overall (all-play) record: each week, every team plays every other real team's score.
  // The team facing Team 8 still counts here, since its score is real.
  const byWeek = new Map<number, { ownerId: string; pts: number }[]>();
  for (const g of regularGames(season, throughWeek)) {
    const list = byWeek.get(g.week) ?? [];
    for (const side of g.bye ? [g.a] : [g.a, g.b]) if (side.ownerId && rows.has(side.ownerId)) list.push({ ownerId: side.ownerId, pts: side.pts });
    byWeek.set(g.week, list);
  }
  for (const list of byWeek.values()) {
    for (const me of list) {
      const ap = rows.get(me.ownerId)!.allPlay;
      for (const o of list) {
        if (o === me) continue;
        if (me.pts > o.pts) ap.w++;
        else if (me.pts < o.pts) ap.l++;
        else ap.t++;
      }
    }
  }

  const sorted = sortStandings([...rows.values()]);
  sorted.forEach((r, i) => {
    r.rank = i + 1;
    r.pf = round2(r.pf);
    r.pa = round2(r.pa);
    r.maxpf = round2(r.maxpf);
    r.streak = streakOf(r.results);
  });
  return sorted;
}
