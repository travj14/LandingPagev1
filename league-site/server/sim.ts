import type { Game, SeasonData } from './history.ts';
import type { StandingRow } from './standings.ts';

/**
 * Season simulator behind playoff odds, seeds, matchup stakes, the what-if
 * tool, clinch / elimination and rookie pick odds.
 *
 * Models (SITE_PLAN §3):
 *  - coin:   every remaining game is 50/50. Exact enumeration when ≤ 2^20
 *            outcomes remain, otherwise Monte Carlo. Teams tied on record are
 *            ordered at random (exact mode splits the tied places evenly).
 *  - sample: each team draws a whole past week (PF + Max PF) from its sample
 *            pool (models.ts); the higher score wins. Ties on record are
 *            broken by simulated PF, the real tiebreaker.
 */

export type Model = 'coin' | 'sample';

export interface PoolWeek {
  pts: number;
  maxPts: number;
  weight: number;
}

export interface SimOptions {
  season: SeasonData;
  throughWeek: number; // last completed week; later regular-season games are simulated
  rows: StandingRow[]; // standings as of throughWeek
  model: Model;
  picks?: Map<string, string>; // gameKey -> winner ownerId (what-if / stakes)
  pools?: Map<string, PoolWeek[]>; // required for the sample model
  runs?: number;
}

export interface Clinch {
  status: 'clinched' | 'eliminated' | 'alive';
  magic: number | null; // wins (of its own remaining games) that guarantee a spot
}

export interface SimResult {
  method: 'exact' | 'monte-carlo' | 'final';
  runs: number; // outcomes enumerated or simulated
  odds: Record<string, number>; // % chance of a playoff spot
  seeds: Record<string, number[]>; // % chance of each final place, index 0 = 1st
  slots: Record<string, number[]>; // % chance of each rookie draft slot for the team's own pick, index 0 = pick 1
  expWins: Record<string, number>;
  clinch: Record<string, Clinch> | null; // null when too many games remain to enumerate
}

export const gameKey = (g: Pick<Game, 'week' | 'matchupId'>) => `${g.week}-${g.matchupId}`;

const EXACT_LIMIT = 20;

export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Regular-season games after throughWeek, byes included (they add PF in the sample model). */
export function remainingGames(season: SeasonData, throughWeek: number) {
  return season.games.filter((g) => !g.playoff && g.week > throughWeek).sort((x, y) => x.week - y.week || x.matchupId - y.matchupId);
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === k) return void out.push(acc.slice());
    for (let i = start; i < n; i++) (acc.push(i), pick(i + 1, acc), acc.pop());
  };
  pick(0, []);
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function simulate(o: SimOptions): SimResult {
  const { season, rows, model } = o;
  const T = rows.length;
  const P = Math.min(season.playoffTeams, T);
  const ids = rows.map((r) => r.ownerId);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const picks = o.picks ?? new Map<string, string>();

  const base = rows.map((r) => ({ w: r.w, l: r.l, t: r.t, pf: r.pf, maxpf: r.maxpf }));
  const rem = remainingGames(season, o.throughWeek).filter((g) => idx.has(g.a.ownerId!) && (g.bye || idx.has(g.b.ownerId!)));
  const real = rem.filter((g) => !g.bye);

  // Max PF projected forward at each team's current per-week pace (coin model only;
  // the sample model draws it). Weeks with a score so far, byes included.
  const scoredWeeks = new Map<string, number>();
  for (const g of season.games) {
    if (g.playoff || !g.played || g.week > o.throughWeek) continue;
    for (const s of g.bye ? [g.a] : [g.a, g.b]) if (s.ownerId) scoredWeeks.set(s.ownerId, (scoredWeeks.get(s.ownerId) ?? 0) + 1);
  }
  const projMaxpf = rows.map((r) => {
    const n = scoredWeeks.get(r.ownerId) ?? 0;
    const left = rem.filter((g) => g.a.ownerId === r.ownerId || g.b.ownerId === r.ownerId).length;
    return n ? r.maxpf + (r.maxpf / n) * left : r.maxpf;
  });

  const empty = () => Object.fromEntries(ids.map((id) => [id, Array<number>(T).fill(0)]));
  const out: SimResult = { method: 'exact', runs: 0, odds: {}, seeds: empty(), slots: empty(), expWins: {}, clinch: null };
  const odds = Array<number>(T).fill(0);
  const expW = Array<number>(T).fill(0);
  const seeds = ids.map(() => Array<number>(T).fill(0));
  const slots = ids.map(() => Array<number>(T).fill(0));

  // Draft slots (1-based) for one finished order. Playoff places pick last in reverse
  // standings; the rest pick first by lowest Max PF.
  const addSlots = (order: number[], maxpf: ArrayLike<number>, p: number) => {
    for (let pos = 0; pos < P; pos++) slots[order[pos]][T - pos - 1] += p;
    const out = order.slice(P).sort((x, y) => maxpf[x] - maxpf[y]);
    out.forEach((team, i) => (slots[team][i] += p));
  };

  const finish = (scale: number) => {
    ids.forEach((id, i) => {
      out.odds[id] = round2(odds[i] * scale * 100);
      out.expWins[id] = round2(expW[i] * scale);
      out.seeds[id] = seeds[i].map((v) => round2(v * scale * 100));
      out.slots[id] = slots[i].map((v) => round2(v * scale * 100));
    });
    return out;
  };

  // Regular season over (or nothing left to play): the real standings decide it.
  if (!real.length && !(model === 'sample' && rem.length)) {
    const order = rows.map((_, i) => i); // already sorted with the PF tiebreaker
    order.forEach((team, pos) => {
      if (pos < P) odds[team] = 1;
      seeds[team][pos] = 1;
      expW[team] = base[team].w;
    });
    addSlots(order, base.map((b) => b.maxpf), 1);
    out.method = 'final';
    out.runs = 1;
    out.clinch = Object.fromEntries(ids.map((id, i) => [id, { status: i < P ? 'clinched' : 'eliminated', magic: null }]));
    return finish(1);
  }

  if (model === 'coin' && real.filter((g) => !picks.has(gameKey(g))).length <= EXACT_LIMIT) {
    exactCoin();
    return out;
  }
  monteCarlo();
  return out;

  // ---------------------------------------------------------------------------

  function exactCoin() {
    const fixedW = base.map((b) => b.w);
    const fixedL = base.map((b) => b.l);
    const free: [number, number][] = [];
    const remCount = Array<number>(T).fill(0); // each team's own unsettled games, for magic numbers
    for (const g of real) {
      const a = idx.get(g.a.ownerId!)!;
      const b = idx.get(g.b.ownerId!)!;
      const winner = picks.get(gameKey(g));
      if (winner === g.a.ownerId) (fixedW[a]++, fixedL[b]++);
      else if (winner === g.b.ownerId) (fixedW[b]++, fixedL[a]++);
      else (free.push([a, b]), remCount[a]++, remCount[b]++);
    }
    const n = free.length;
    const total = 2 ** n;
    const p = 1 / total;
    const ties = base.map((b) => b.t);

    const everIn = Array<boolean>(T).fill(false);
    const alwaysIn = Array<boolean>(T).fill(true);
    // allInAt[team][k]: every outcome where the team wins exactly k of its free games puts it in.
    const allInAt = remCount.map((c) => Array<boolean>(c + 1).fill(true));
    const comboCache = new Map<string, number[][]>();

    const w = new Int32Array(T);
    const l = new Int32Array(T);
    const freeWins = new Int32Array(T);
    const order = ids.map((_, i) => i);

    for (let mask = 0; mask < total; mask++) {
      for (let i = 0; i < T; i++) (w[i] = fixedW[i]), (l[i] = fixedL[i]), (freeWins[i] = 0);
      for (let j = 0; j < n; j++) {
        const [a, b] = free[j];
        if (mask & (1 << j)) (w[a]++, l[b]++, freeWins[a]++);
        else (w[b]++, l[a]++, freeWins[b]++);
      }
      order.sort((x, y) => w[y] * 2 + ties[y] - (w[x] * 2 + ties[x]) || l[x] - l[y]);

      // Walk groups of teams tied on record.
      let start = 0;
      while (start < T) {
        let end = start + 1;
        while (end < T && w[order[end]] === w[order[start]] && l[order[end]] === l[order[start]] && ties[order[end]] === ties[order[start]]) end++;
        const k = end - start;
        const inSlots = Math.max(0, Math.min(P, end) - start);
        for (let g = start; g < end; g++) {
          const team = order[g];
          expW[team] += w[team] * p;
          odds[team] += (inSlots / k) * p;
          for (let pos = start; pos < end; pos++) seeds[team][pos] += p / k;
          const worstIn = end - 1 < P;
          if (start < P) everIn[team] = true;
          if (!worstIn) {
            alwaysIn[team] = false;
            allInAt[team][freeWins[team]] = false;
          }
        }
        start = end;
      }
      draftSlotsExact(order, w, l, ties, p, comboCache);
    }

    out.method = 'exact';
    out.runs = total;
    finish(1);
    out.clinch = Object.fromEntries(
      ids.map((id, i) => {
        if (alwaysIn[i]) return [id, { status: 'clinched', magic: null }];
        if (!everIn[i]) return [id, { status: 'eliminated', magic: null }];
        let magic: number | null = null;
        for (let k = remCount[i]; k >= 0 && allInAt[i][k]; k--) magic = k;
        return [id, { status: 'alive', magic }];
      }),
    );
  }

  // Draft slots for one enumerated outcome, splitting tied places evenly. A tied
  // group that straddles the playoff line is resolved over every way it can split.
  function draftSlotsExact(order: number[], w: Int32Array, l: Int32Array, ties: number[], p: number, cache: Map<string, number[][]>) {
    let start = 0;
    while (start < T) {
      let end = start + 1;
      while (end < T && w[order[end]] === w[order[start]] && l[order[end]] === l[order[start]] && ties[order[end]] === ties[order[start]]) end++;
      if (end <= P) {
        // Whole group in the playoffs: each member gets each of the group's places evenly.
        const k = end - start;
        for (let g = start; g < end; g++) for (let pos = start; pos < end; pos++) slots[order[g]][T - pos - 1] += p / k;
      } else if (start >= P) {
        // Everyone from here down misses: order by projected Max PF.
        const outTeams = order.slice(start).sort((x, y) => projMaxpf[x] - projMaxpf[y]);
        outTeams.forEach((team, i) => (slots[team][i] += p));
        return;
      } else {
        // Straddles the line: m of the k tied teams get in.
        const group = order.slice(start, end);
        const k = group.length;
        const m = P - start;
        const key = `${k}-${m}`;
        if (!cache.has(key)) cache.set(key, combinations(k, m));
        const splits = cache.get(key)!;
        const ps = p / splits.length;
        for (const inIdx of splits) {
          const ins = new Set(inIdx);
          for (const gi of inIdx) for (let pos = start; pos < P; pos++) slots[group[gi]][T - pos - 1] += ps / m;
          const outTeams = [...group.filter((_, gi) => !ins.has(gi)), ...order.slice(end)].sort((x, y) => projMaxpf[x] - projMaxpf[y]);
          outTeams.forEach((team, i) => (slots[team][i] += ps));
        }
        return;
      }
      start = end;
    }
  }

  function monteCarlo() {
    const runs = o.runs ?? (model === 'sample' ? 20_000 : 50_000);
    const rand = mulberry32(20261103); // fixed seed: same data, same odds; forced runs share draws
    const pools = ids.map((id) => o.pools?.get(id) ?? []);
    const cum = pools.map((pool) => {
      let s = 0;
      return pool.map((x) => (s += x.weight));
    });
    const draw = (team: number) => {
      const c = cum[team];
      if (!c.length) return null;
      const r = rand() * c[c.length - 1];
      let i = 0;
      while (c[i] < r) i++;
      return pools[team][i];
    };

    const games = rem.map((g) => ({
      a: idx.get(g.a.ownerId!)!,
      b: g.bye ? -1 : idx.get(g.b.ownerId!)!,
      forced: picks.has(gameKey(g)) ? (picks.get(gameKey(g)) === g.a.ownerId ? 1 : 2) : 0,
    }));
    const w = new Float64Array(T), l = new Float64Array(T), t = new Float64Array(T), pf = new Float64Array(T), mx = new Float64Array(T), flip = new Float64Array(T);
    const order = ids.map((_, i) => i);

    for (let run = 0; run < runs; run++) {
      for (let i = 0; i < T; i++) (w[i] = base[i].w), (l[i] = base[i].l), (t[i] = base[i].t), (pf[i] = base[i].pf), (mx[i] = model === 'coin' ? projMaxpf[i] : base[i].maxpf);
      for (const g of games) {
        if (model === 'coin') {
          if (g.b < 0) continue;
          const coin = rand() < 0.5; // always draw, so forced runs reuse the same sequence
          const aWins = g.forced ? g.forced === 1 : coin;
          if (aWins) (w[g.a]++, l[g.b]++);
          else (w[g.b]++, l[g.a]++);
          continue;
        }
        let da = draw(g.a);
        if (g.b < 0) {
          if (da) (pf[g.a] += da.pts), (mx[g.a] += da.maxPts);
          continue;
        }
        let db = draw(g.b);
        // A forced result is sampled conditionally: redraw until the scores agree with it.
        for (let tries = 0; g.forced && da && db && tries < 60; tries++) {
          if ((g.forced === 1 && da.pts > db.pts) || (g.forced === 2 && db.pts > da.pts)) break;
          da = draw(g.a);
          db = draw(g.b);
        }
        const pa = da?.pts ?? 0, pb = db?.pts ?? 0;
        pf[g.a] += pa;
        pf[g.b] += pb;
        mx[g.a] += da?.maxPts ?? 0;
        mx[g.b] += db?.maxPts ?? 0;
        const res = g.forced || (pa > pb ? 1 : pb > pa ? 2 : 0);
        if (res === 1) (w[g.a]++, l[g.b]++);
        else if (res === 2) (w[g.b]++, l[g.a]++);
        else (t[g.a]++, t[g.b]++);
      }
      for (let i = 0; i < T; i++) flip[i] = rand();
      order.sort((x, y) => w[y] * 2 + t[y] - (w[x] * 2 + t[x]) || l[x] - l[y] || (model === 'coin' ? flip[x] - flip[y] : pf[y] - pf[x]));
      order.forEach((team, pos) => {
        if (pos < P) odds[team]++;
        seeds[team][pos]++;
        expW[team] += w[team];
      });
      addSlots(order, mx, 1);
    }
    out.method = 'monte-carlo';
    out.runs = runs;
    finish(1 / runs);
  }
}
