import { SIM_COUNT } from './config.ts';
import type { Game, SeasonData } from './history.ts';
import { regularGames, type StandingRow } from './standings.ts';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Coin-flip playoff odds. Every remaining regular-season game (including any
 * not yet kicked off) is a 50/50, byes do nothing, and teams tied on record
 * at the end are ordered by coin flip too. Scores and PF are ignored. Once
 * the regular season is over, the real standings (PF tiebreaker) decide it.
 */
export function playoffOdds(
  season: SeasonData,
  throughWeek: number,
  rows: StandingRow[],
  force?: { game: Game; winnerId: string }, // settle one remaining game in advance
): { pct: Map<string, number>; final: boolean } {
  const played = regularGames(season, throughWeek);
  const remaining = season.games.filter((g) => !g.playoff && !g.bye && !played.includes(g));
  const ids = rows.map((r) => r.ownerId);

  if (!remaining.length) {
    const inIds = new Set(ids.slice(0, season.playoffTeams));
    return { pct: new Map(ids.map((id) => [id, inIds.has(id) ? 100 : 0])), final: true };
  }

  // Seed from the results so far, so identical data always gives identical odds.
  const seed = rows.reduce((s, r, i) => s + (i + 1) * (r.w * 31 + r.l * 7 + r.t), season.season * 1000 + played.length);
  const rand = mulberry32(seed);
  const made = new Map<string, number>(ids.map((id) => [id, 0]));

  for (let i = 0; i < SIM_COUNT; i++) {
    const sim = new Map(rows.map((r) => [r.ownerId, { id: r.ownerId, w: r.w, l: r.l, t: r.t, flip: 0 }]));
    for (const g of remaining) {
      const a = sim.get(g.a.ownerId!);
      const b = sim.get(g.b.ownerId!);
      if (!a || !b) continue;
      const aWins = rand() < 0.5; // always draw, so forced runs reuse the same random sequence
      if (force?.game === g ? force.winnerId === g.a.ownerId : aWins) (a.w++, b.l++);
      else (b.w++, a.l++);
    }
    for (const t of sim.values()) t.flip = rand();
    const order = [...sim.values()].sort((x, y) => y.w + y.t / 2 - (x.w + x.t / 2) || x.l - y.l || x.flip - y.flip);
    for (const t of order.slice(0, season.playoffTeams)) made.set(t.id, made.get(t.id)! + 1);
  }

  return {
    pct: new Map(ids.map((id) => [id, Math.round((made.get(id)! / SIM_COUNT) * 10000) / 100])),
    final: false,
  };
}
