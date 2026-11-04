import { honest, memo, nameOf, rowsAt, sim, type Ctx } from './api.ts';
import type { Game, SeasonData, Side } from './history.ts';
import { buildPickBoard } from './picks.ts';
import type { Model } from './sim.ts';
import { computeStandings } from './standings.ts';
import type { SleeperTransaction } from './types.ts';

// Teams tab: league overview, owner pages, transactions and careers.

const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const round2 = (n: number) => Math.round(n * 100) / 100;
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

const player = (c: Ctx, pid: string) => {
  const p = c.h.players[pid];
  return { pid, name: p?.name ?? pid, pos: p?.pos ?? '', team: p?.team ?? null };
};

/** Sides a team played in a season (bye weeks included), oldest first. */
function sidesOf(sd: SeasonData, ownerId: string) {
  const out: { g: Game; me: Side; opp: Side | null }[] = [];
  for (const g of sd.games) {
    if (!g.played || g.live) continue;
    if (g.a.ownerId === ownerId) out.push({ g, me: g.a, opp: g.bye ? null : g.b });
    else if (!g.bye && g.b.ownerId === ownerId) out.push({ g, me: g.b, opp: g.a });
  }
  return out.sort((x, y) => x.g.week - y.g.week);
}

/** Final regular-season standings of a season (current season: as of now). */
function seasonRows(c: Ctx, sd: SeasonData) {
  const through = sd === c.season ? c.regThrough : sd.regWeeks;
  return memo(`srows|${c.fp}|${sd.season}`, () => computeStandings(sd, through, nameOf(c)));
}

function champions(sd: SeasonData) {
  const final = sd.bracket.find((m) => m.p === 1 && m.w);
  if (!final) return null;
  return { champ: sd.ownerByRid.get(final.w!) ?? null, runnerUp: sd.ownerByRid.get(final.l!) ?? null };
}

// Sleeper fills in the bracket from the live standings before the regular season ends,
// so it only counts once a season's playoffs have started.
const bracketFinal = (c: Ctx, sd: SeasonData) => sd.status === 'complete' || (sd === c.season && c.completed > sd.regWeeks);

function playoffTeams(sd: SeasonData) {
  const ids = new Set<string>();
  for (const m of sd.bracket) for (const rid of [m.t1, m.t2]) if (rid && m.r === 1) ids.add(sd.ownerByRid.get(rid) ?? '');
  ids.delete('');
  return ids;
}

/** Owners with the top score of each completed week, all seasons. */
function weeklyHighs(c: Ctx) {
  return memo(`highs|${c.fp}`, () => {
    const count = new Map<string, number>();
    for (const sd of c.h.seasons) {
      const weeks = new Map<number, Side[]>();
      for (const g of sd.games) {
        if (!g.played || g.live) continue;
        for (const s of g.bye ? [g.a] : [g.a, g.b]) if (s.ownerId) weeks.set(g.week, [...(weeks.get(g.week) ?? []), s]);
      }
      for (const sides of weeks.values()) {
        const top = sides.reduce((b, s) => (s.pts > b.pts ? s : b));
        count.set(top.ownerId!, (count.get(top.ownerId!) ?? 0) + 1);
      }
    }
    return count;
  });
}

function career(c: Ctx, ownerId: string) {
  const seasons = c.h.seasons
    .filter((sd) => sd.owners.includes(ownerId))
    .map((sd) => {
      const rows = seasonRows(c, sd);
      const r = rows.find((x) => x.ownerId === ownerId);
      const ready = bracketFinal(c, sd);
      const ch = ready ? champions(sd) : null;
      const inPlayoffs = ready && playoffTeams(sd).has(ownerId);
      const finish = ch?.champ === ownerId ? 'Champion' : ch?.runnerUp === ownerId ? 'Runner-up' : inPlayoffs ? 'Playoffs' : sd === c.season && sd.status !== 'complete' ? 'In progress' : 'Missed playoffs';
      return { season: sd.season, w: r?.w ?? 0, l: r?.l ?? 0, t: r?.t ?? 0, pf: r?.pf ?? 0, rank: r?.rank ?? null, finish, current: sd === c.season };
    });
  const tot = seasons.reduce((a, s) => ({ w: a.w + s.w, l: a.l + s.l, t: a.t + s.t, pf: a.pf + s.pf }), { w: 0, l: 0, t: 0, pf: 0 });
  const done = seasons.filter((s) => !s.current || c.season.status === 'complete');
  const best = [...done].sort((x, y) => y.w + y.t / 2 - (x.w + x.t / 2) || y.pf - x.pf)[0] ?? null;
  return {
    ...tot,
    pf: round2(tot.pf),
    seasons,
    titles: seasons.filter((s) => s.finish === 'Champion').length,
    playoffs: seasons.filter((s) => ['Champion', 'Runner-up', 'Playoffs'].includes(s.finish)).length,
    best: best && { season: best.season, w: best.w, l: best.l, t: best.t, pf: best.pf },
    weeklyHighs: weeklyHighs(c).get(ownerId) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Transactions

function pickLabel(c: Ctx, season: string | number, round: number, originalRid: number, board: ReturnType<typeof buildPickBoard>) {
  const orig = c.season.ownerByRid.get(originalRid) ?? null;
  const proj = Number(season) === board.season && orig ? board.projected(round, orig) : null;
  return { season: Number(season), round, label: `${season} ${ordinal(round)}`, original: orig, projected: proj };
}

function board(c: Ctx) {
  return memo(`board|${c.fp}`, () => buildPickBoard(c.season, c.season.lastWeek, rowsAt(c, c.regThrough), nameOf(c)));
}

/** Points a player scored in a team's starting lineup from `fromWeek` on (current season). */
function startedPoints(c: Ctx, ownerId: string, pid: string, fromWeek: number) {
  let pts = 0;
  for (const { g, me } of sidesOf(c.season, ownerId)) {
    if (g.week < fromWeek) continue;
    pts += me.starters.find((s) => s.pid === pid)?.pts ?? 0;
  }
  return round2(pts);
}

/** Starts, points and results for a player in this team's lineup this season. Byes count as starts but not games. */
function startLine(c: Ctx, ownerId: string, pid: string) {
  let starts = 0, pts = 0, games = 0, w = 0, t = 0;
  for (const { me, opp } of sidesOf(c.season, ownerId)) {
    const s = me.starters.find((x) => x.pid === pid);
    if (!s) continue;
    starts++;
    pts += s.pts;
    if (!opp) continue;
    games++;
    if (me.pts > opp.pts) w++;
    else if (me.pts === opp.pts) t++;
  }
  return { starts, pts: round2(pts), ppg: starts ? round2(pts / starts) : null, games, wins: w, ties: t, winPct: games ? Math.round(((w + t / 2) / games) * 1000) / 10 : null };
}

function txOut(c: Ctx, t: SleeperTransaction) {
  const owner = (rid: number) => c.season.ownerByRid.get(rid) ?? null;
  const b = board(c);
  const sides = t.roster_ids.map((rid) => {
    const id = owner(rid);
    const adds = Object.entries(t.adds ?? {}).filter(([, r]) => r === rid).map(([pid]) => ({ ...player(c, pid), since: id && t.type !== 'trade' ? startedPoints(c, id, pid, t.leg) : undefined }));
    const drops = Object.entries(t.drops ?? {}).filter(([, r]) => r === rid).map(([pid]) => player(c, pid));
    const picksIn = t.draft_picks.filter((p) => p.owner_id === rid).map((p) => pickLabel(c, p.season, p.round, p.roster_id, b));
    const picksOut = t.draft_picks.filter((p) => p.previous_owner_id === rid).map((p) => pickLabel(c, p.season, p.round, p.roster_id, b));
    const faabIn = t.waiver_budget.filter((x) => x.receiver === rid).reduce((s, x) => s + x.amount, 0);
    const faabOut = t.waiver_budget.filter((x) => x.sender === rid).reduce((s, x) => s + x.amount, 0);
    return { id, adds, drops, picksIn, picksOut, faabIn, faabOut };
  });
  return { id: t.transaction_id, type: t.type, week: t.leg, at: t.status_updated, bid: t.settings?.waiver_bid ?? null, sides };
}

function transactions(c: Ctx) {
  return memo(`tx|${c.fp}`, () => [...c.season.transactions].reverse().filter((t) => t.type !== 'commissioner' || t.adds || t.drops).map((t) => txOut(c, t)));
}

function activity(c: Ctx) {
  const rows = new Map(c.teams.map((t) => [t.id, { id: t.id, trades: 0, adds: 0, drops: 0, faab: 0 }]));
  for (const t of c.season.transactions) {
    for (const rid of t.roster_ids) {
      const r = rows.get(c.season.ownerByRid.get(rid) ?? '');
      if (!r) continue;
      if (t.type === 'trade') r.trades++;
      else {
        r.adds += Object.values(t.adds ?? {}).filter((x) => x === rid).length;
        r.drops += Object.values(t.drops ?? {}).filter((x) => x === rid).length;
        if (t.type === 'waiver') r.faab += t.settings?.waiver_bid ?? 0;
      }
    }
  }
  return [...rows.values()].sort((x, y) => y.trades + y.adds - (x.trades + x.adds));
}

// ---------------------------------------------------------------------------

export function teamsIndex(c: Ctx, model: Model) {
  return memo(`teams|${c.fp}|${model}`, () => {
    const rows = rowsAt(c, c.regThrough);
    const r = sim(c, c.regThrough, model);
    return {
      model,
      teams: rows.map((row) => {
        const car = career(c, row.ownerId);
        return {
          id: row.ownerId,
          rank: row.rank,
          w: row.w,
          l: row.l,
          t: row.t,
          pf: row.pf,
          streak: row.streak,
          odds: honest(c, new Map(), row.ownerId, r.odds[row.ownerId]),
          titles: car.titles,
          career: { w: car.w, l: car.l, t: car.t },
        };
      }),
      transactions: transactions(c),
      activity: activity(c),
    };
  });
}

export function teamPage(c: Ctx, slug: string, model: Model) {
  const info = c.bySlug.get(slug);
  if (!info) return null;
  const id = info.id;
  return memo(`team|${c.fp}|${model}|${id}`, () => {
    const rows = rowsAt(c, c.regThrough);
    const row = rows.find((r) => r.ownerId === id)!;
    const r = sim(c, c.regThrough, model);
    const rid = c.season.ridByOwner.get(id)!;

    // Weekly results this season, with each week's league median for context.
    const medians = new Map<number, number>();
    for (const g of c.season.games) {
      if (!g.played || g.live) continue;
      const list = c.season.games.filter((x) => x.week === g.week && x.played).flatMap((x) => (x.bye ? [x.a] : [x.a, x.b])).map((s) => s.pts).sort((a, b) => a - b);
      medians.set(g.week, list.length % 2 ? list[(list.length - 1) / 2] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2);
    }
    const weeks = sidesOf(c.season, id).map(({ g, me, opp }) => ({
      week: g.week,
      playoff: g.playoff,
      pts: me.pts,
      maxPts: me.maxPts,
      opp: opp?.ownerId ?? null,
      oppPts: opp?.pts ?? null,
      result: !opp ? 'BYE' : me.pts > opp.pts ? 'W' : me.pts < opp.pts ? 'L' : 'T',
      median: round2(medians.get(g.week) ?? 0),
    }));

    // All-time high and low (every season).
    const all = c.h.seasons.flatMap((sd) => sidesOf(sd, id).map(({ g, me, opp }) => ({ season: sd.season, week: g.week, pts: me.pts, opp: opp?.ownerId ?? null })));
    const best = all.reduce<(typeof all)[number] | null>((b, x) => (!b || x.pts > b.pts ? x : b), null);
    const worst = all.reduce<(typeof all)[number] | null>((b, x) => (!b || x.pts < b.pts ? x : b), null);

    // Roster, grouped by position, with points started for this team this season.
    const roster = (c.season.rosters.get(rid) ?? [])
      .map((pid) => ({ ...player(c, pid), ...startLine(c, id, pid) }))
      .sort((x, y) => (POS_ORDER.indexOf(x.pos) + 1 || 99) - (POS_ORDER.indexOf(y.pos) + 1 || 99) || y.pts - x.pts);

    // Every future pick this team owns.
    const b = board(c);
    const draftSeasons = [...new Set([b.season, b.season + 1, b.season + 2, ...c.season.tradedPicks.map((p) => Number(p.season))])].filter((s) => s >= b.season).sort();
    const owned = new Map(c.season.tradedPicks.map((p) => [`${p.season}|${p.round}|${p.roster_id}`, p.owner_id]));
    const picks = draftSeasons.flatMap((season) =>
      Array.from({ length: c.season.draftRounds }, (_, i) => i + 1).flatMap((round) =>
        c.teams
          .map((t) => c.season.ridByOwner.get(t.id)!)
          .filter((orig) => (owned.get(`${season}|${round}|${orig}`) ?? orig) === rid)
          .map((orig) => pickLabel(c, season, round, orig, b)),
      ),
    );

    // Head-to-head vs each opponent, all seasons, regular season.
    const h2h = new Map<string, { w: number; l: number; t: number }>();
    for (const sd of c.h.seasons) {
      for (const { g, me, opp } of sidesOf(sd, id)) {
        if (!opp?.ownerId || g.playoff) continue;
        const rec = h2h.get(opp.ownerId) ?? { w: 0, l: 0, t: 0 };
        if (me.pts > opp.pts) rec.w++;
        else if (me.pts < opp.pts) rec.l++;
        else rec.t++;
        h2h.set(opp.ownerId, rec);
      }
    }

    const tx = transactions(c).filter((t) => t.sides.some((s) => s.id === id));
    return {
      id,
      model,
      rank: row.rank,
      w: row.w,
      l: row.l,
      t: row.t,
      pf: row.pf,
      pa: row.pa,
      maxpf: row.maxpf,
      streak: row.streak,
      allPlay: row.allPlay,
      odds: honest(c, new Map(), id, r.odds[id]),
      expWins: r.expWins[id],
      weeks,
      best,
      worst,
      roster,
      picks,
      career: career(c, id),
      h2h: [...h2h].map(([opp, rec]) => ({ opp, ...rec })).sort((x, y) => y.w - y.l - (x.w - x.l)),
      transactions: tx,
    };
  });
}
