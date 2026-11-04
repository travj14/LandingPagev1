import type { History } from './history.ts';
import type { PoolWeek } from './sim.ts';

export interface SampleSettings {
  sampleSize: number; // games per team, default 8
  offseasonWeight: number; // weight of games from earlier seasons, default 0.5
}

/**
 * Last-N sample pools for the sample model. Each team's N most recent games
 * with a score (playoffs, consolation and bye weeks included), counting only
 * weeks completed by `throughWeek` of `season`. Teams short of N games this
 * season are filled from earlier seasons, matched by owner, at reduced weight.
 */
export function samplePools(h: History, season: number, throughWeek: number, s: SampleSettings) {
  const byOwner = new Map<string, { season: number; week: number; pts: number; maxPts: number }[]>();
  for (const sd of h.seasons) {
    if (sd.season > season) continue;
    for (const g of sd.games) {
      if (!g.played || g.live || (sd.season === season && g.week > throughWeek)) continue;
      for (const side of g.bye ? [g.a] : [g.a, g.b]) {
        if (!side.ownerId) continue;
        const list = byOwner.get(side.ownerId) ?? [];
        list.push({ season: sd.season, week: g.week, pts: side.pts, maxPts: side.maxPts });
        byOwner.set(side.ownerId, list);
      }
    }
  }

  const pools = new Map<string, PoolWeek[]>();
  for (const [owner, list] of byOwner) {
    list.sort((x, y) => y.season - x.season || y.week - x.week);
    pools.set(
      owner,
      list.slice(0, s.sampleSize).map((x) => ({ pts: x.pts, maxPts: x.maxPts, weight: x.season === season ? 1 : s.offseasonWeight })),
    );
  }

  // A brand-new owner with no games yet borrows the whole league's recent weeks.
  const league = [...pools.values()].flat();
  for (const owner of h.current.owners) if (!pools.get(owner)?.length) pools.set(owner, league);
  return pools;
}
