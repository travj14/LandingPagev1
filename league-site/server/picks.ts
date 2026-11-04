import type { SeasonData } from './history.ts';
import type { StandingRow } from './standings.ts';

export const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

/**
 * Draft slot order if the season ended today: non-playoff teams by lowest
 * Max PF first, then playoff teams in reverse standings. 7 picks per round,
 * and Team 8 gets none.
 */
export function draftOrder(rows: StandingRow[], playoffTeams: number): StandingRow[] {
  const out = rows.slice(playoffTeams).sort((x, y) => x.maxpf - y.maxpf);
  return [...out, ...rows.slice(0, playoffTeams).reverse()];
}

/**
 * Who owns each pick as of `throughWeek`. Starts from Sleeper's current
 * traded_picks, then undoes trades made after that week, newest first.
 */
export function pickOwnership(season: SeasonData, throughWeek: number) {
  const key = (s: string | number, round: number, rid: number) => `${s}|${round}|${rid}`;
  const owner = new Map<string, number>();
  for (const p of season.tradedPicks) owner.set(key(p.season, p.round, p.roster_id), p.owner_id);

  const later = season.trades.filter((t) => t.leg > throughWeek).sort((x, y) => y.status_updated - x.status_updated);
  for (const t of later) {
    for (const p of t.draft_picks) owner.set(key(p.season, p.round, p.roster_id), p.previous_owner_id);
  }

  return (draftSeason: string | number, round: number, originalRid: number) =>
    owner.get(key(draftSeason, round, originalRid)) ?? originalRid;
}

export interface PickSlot {
  pick: string; // "1.03"
  round: number;
  slot: number;
  originalId: string;
  originalName: string;
  originalMaxpf: number;
  originalRank: number;
  originalRecord: string;
  ownerId: string;
  ownerName: string;
  traded: boolean;
}

export function buildPickBoard(
  season: SeasonData,
  throughWeek: number,
  rows: StandingRow[],
  nameOf: (ownerId: string) => string,
) {
  const draftSeason = season.season + 1;
  const order = draftOrder(rows, season.playoffTeams);
  const ownerOf = pickOwnership(season, throughWeek);
  const rounds: { round: number; picks: PickSlot[] }[] = [];
  const byOwner: Record<string, string[]> = {};

  for (let round = 1; round <= season.draftRounds; round++) {
    const picks = order.map((row, i): PickSlot => {
      const originalRid = season.ridByOwner.get(row.ownerId)!;
      const ownerId = season.ownerByRid.get(ownerOf(draftSeason, round, originalRid)) ?? row.ownerId;
      const pick = `${round}.${String(i + 1).padStart(2, '0')}`;
      (byOwner[ownerId] ??= []).push(pick);
      return {
        pick,
        round,
        slot: i + 1,
        originalId: row.ownerId,
        originalName: row.name,
        originalMaxpf: row.maxpf,
        originalRank: row.rank,
        originalRecord: `${row.w}-${row.l}${row.t ? `-${row.t}` : ''}`,
        ownerId,
        ownerName: nameOf(ownerId),
        traded: ownerId !== row.ownerId,
      };
    });
    rounds.push({ round, picks });
  }

  // Projected slot for any pick label, e.g. "2027 1st (Caden)" -> "1.01".
  const projected = (round: number, originalOwnerId: string) =>
    rounds[round - 1]?.picks.find((p) => p.originalId === originalOwnerId)?.pick ?? null;

  return { season: draftSeason, rounds, byOwner, projected };
}
