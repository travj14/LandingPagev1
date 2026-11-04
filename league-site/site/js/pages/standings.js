import { getJSON, load } from '../api.js';
import { lineChart } from '../chart.js';
import { setQuery } from '../router.js';
import { set, settings } from '../settings.js';
import { card, esc, fmt, fmt1, int, ordinal, pct, record, signed, team, teamColor, teamOf } from '../ui.js';

const MODEL_NOTE = {
  coin: 'Every remaining game is a coin flip.',
  sample: "Each team's score is drawn from its last 8 games (playoffs included; last season's games count half).",
};

function methodNote(o) {
  if (o.method === 'exact') return `Exact: all ${int(o.runs)} outcomes.`;
  if (o.method === 'final') return 'Regular season complete.';
  return `${int(o.runs)} simulated seasons.`;
}

function clinchBadge(c) {
  if (!c) return '';
  if (c.status === 'clinched') return '<span class="badge x" title="Clinched a playoff spot">CLINCHED</span>';
  if (c.status === 'eliminated') return '<span class="badge e" title="Eliminated from playoff contention">OUT</span>';
  return '';
}

function details(r, o, P) {
  const t = o.teams[r.id];
  const n = t.seeds.length;
  const max = Math.max(...t.seeds, 1);
  const bars = t.seeds
    .map((v, i) => `<div title="${ordinal(i + 1)}: ${pct(v)}"><span class="col"><i class="${i < P ? 'in' : ''}" style="height:${(v / max) * 100}%"></i></span><span>${ordinal(i + 1)}</span></div>`)
    .join('');
  const c = t.clinch;
  const magic = c?.status === 'alive' && c.magic != null ? `Clinches with ${c.magic} more win${c.magic === 1 ? '' : 's'} (no tiebreakers needed)` : '';
  return `
    <div class="details">
      <div class="kv">
        <div><b>${fmt1(r.maxpf)}</b><span>Max PF</span></div>
        <div><b>${fmt1(r.pa)}</b><span>Points against</span></div>
        <div><b>${r.eff == null ? '–' : `${r.eff}%`}</b><span>Lineup efficiency</span></div>
        <div><b>${record(r.allPlay)}</b><span>All-play record</span></div>
        <div><b class="${r.luck > 0 ? 'good' : r.luck < 0 ? 'bad' : ''}">${signed(r.luck)}</b><span>Luck (wins vs all-play)</span></div>
        <div><b>${fmt1(t.expWins)}</b><span>Projected wins</span></div>
      </div>
      <div><div class="muted" style="font-size:12px;margin-bottom:4px">Chance of each final place</div><div class="seedbars" style="--n:${n}">${bars}</div></div>
      ${magic ? `<div class="muted" style="font-size:12px">${esc(magic)}</div>` : ''}
    </div>`;
}

function table(s, o, base, open, P) {
  const rows = s.rows
    .map((r, i) => {
      const t = o.teams[r.id];
      const delta = base && base !== o ? t.odds - base.teams[r.id].odds : 0;
      const d = Math.abs(delta) >= 0.05 ? `<span class="delta ${delta > 0 ? 'good' : 'bad'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}</span>` : '';
      return `
        <tr class="row ${i === P ? 'cut' : ''}" data-id="${esc(r.id)}" aria-expanded="${open.has(r.id)}">
          <td class="rk">${r.rank}</td>
          <td class="tm">${team(r.id, { link: false })}<span class="streak">${esc(r.streak)}</span>${clinchBadge(t.clinch)}</td>
          <td>${record(r)}</td>
          <td>${fmt1(r.pf)}</td>
          <td><span class="odds-cell"><span class="bar"><i style="width:${t.odds}%;background:${teamColor(r.id)}"></i></span><span>${pct(t.odds)}${d}</span></span></td>
        </tr>
        ${open.has(r.id) ? `<tr class="detail"><td></td><td colspan="4">${details(r, o, P)}</td></tr>` : ''}`;
    })
    .join('');
  return `<table class="tbl"><thead><tr><th class="l">#</th><th class="l">Team</th><th>W-L</th><th>PF</th><th>Playoffs</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function whatIfHtml(s, picks, losers) {
  if (!s.remaining.length) return '';
  const inPlay = s.rows.map((r) => r.id).filter((id) => s.remaining.some((g) => g.a === id || g.b === id));
  const loseOut = inPlay
    .map((id) => {
      const on = losers.has(teamOf(id).slug);
      return `<button class="${on ? 'on' : ''}" data-lose="${esc(teamOf(id).slug)}" aria-pressed="${on}"><span class="dot" style="--tc:${teamColor(id)}"></span>${esc(teamOf(id).name)}</button>`;
    })
    .join('');
  const weeks = [...new Set(s.remaining.map((g) => g.week))];
  const body = weeks
    .map((w) => {
      const games = s.remaining
        .filter((g) => g.week === w)
        .map((g) => {
          const pick = picks.get(g.key);
          const btn = (id) => {
            const st = pick ? (pick === teamOf(id).slug ? 'on' : 'off') : '';
            return `<button class="${st}" data-key="${esc(g.key)}" data-slug="${esc(teamOf(id).slug)}" aria-pressed="${st === 'on'}"><span class="dot" style="--tc:${teamColor(id)}"></span><span>${esc(teamOf(id).name)}</span></button>`;
          };
          return `<div class="wi-game">${btn(g.a)}<span class="vs">vs</span>${btn(g.b)}</div>`;
        })
        .join('');
      return `<div class="wi-week"><h4>Week ${w}</h4>${games}</div>`;
    })
    .join('');
  return `
    <section class="card rv" id="whatif">
      <h2 class="sec-title">What if…</h2>
      <p class="note" style="margin:0 0 12px">Tap a winner for any remaining game and the standings update with the new odds. Tap again to clear.</p>
      <div class="wi-lose">
        <h4>Lose out</h4>
        <div class="chips">${loseOut}</div>
        <p class="note">Picks a loss in every remaining game for that team. When two lose-out teams play each other, that game stays a toss-up.</p>
      </div>
      ${body}
      <div class="wi-actions">
        <button class="btn" data-act="reset" ${picks.size || losers.size ? '' : 'disabled'}>Clear picks</button>
        <button class="btn" data-act="share" ${picks.size ? '' : 'disabled'}>Copy link</button>
      </div>
    </section>`;
}

function draftHtml(d, mode, model) {
  if (!d) return card('Rookie draft order', '<div class="loading">Loading…</div>', { cls: 'draft-card' });
  const toggle = `<span class="seg" role="group" aria-label="Draft view"><button data-draft="today" class="${mode === 'today' ? 'on' : ''}">If it ended today</button><button data-draft="odds" class="${mode === 'odds' ? 'on' : ''}">Pick odds</button></span>`;
  let body;
  if (mode === 'today') {
    const pickRow = (p) => `
      <div class="pick">
        <span class="no">${esc(p.pick)}</span>
        <div style="min-width:0">${team(p.original)}<div class="sub">${esc(p.record)} · ${fmt1(p.maxpf)} Max PF</div></div>
        ${p.traded ? `<span class="to">→ ${esc(teamOf(p.owner).name)}</span>` : ''}
      </div>`;
    const [first, ...rest] = d.rounds;
    body = `
      <div class="picks">${first ? first.picks.map(pickRow).join('') : ''}</div>
      ${rest.length ? `<details class="more-rounds"><summary>Rounds 2–${d.rounds.length}</summary>${rest.map((r) => `<h4 class="muted" style="margin:12px 0 6px;font-size:12px">Round ${r.round}</h4><div class="picks">${r.picks.map(pickRow).join('')}</div>`).join('')}</details>` : ''}
      <p class="note">Non-playoff teams pick first, lowest Max PF first. Playoff teams follow in reverse standings. Traded picks show their current owner.</p>`;
  } else {
    const n = d.odds[0]?.slots.length ?? 0;
    const head = Array.from({ length: n }, (_, i) => `<th class="c">${i + 1}</th>`).join('');
    // Most likely early picks first.
    const expSlot = (o) => o.slots.reduce((t, v, i) => t + v * (i + 1), 0);
    const rows = [...d.odds]
      .sort((a, b) => expSlot(a) - expSlot(b))
      .map((o) => {
        const best = Math.max(...o.slots);
        const cells = o.slots
          .map((v) => {
            const a = Math.min(0.85, (v / 100) * 1.4);
            return `<td class="cell ${v < 0.5 ? 'z' : ''}" style="background:color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)${v === best && v >= 0.5 ? ';font-weight:800' : ''}" >${v < 0.5 ? (v > 0 ? '·' : '') : Math.round(v)}</td>`;
          })
          .join('');
        const owner = o.owner !== o.original ? `<div class="muted" style="font-size:11px">→ ${esc(teamOf(o.owner).name)}</div>` : '';
        return `<tr><td class="tm">${team(o.original)}${owner}</td>${cells}</tr>`;
      })
      .join('');
    body = `
      <div style="overflow-x:auto;margin:0 -14px"><table class="tbl heat"><thead><tr><th class="l">${d.season} 1st from</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">% chance of each 1st-round slot. ${model === 'coin' ? 'Under coin flip, Max PF is projected at each team’s current pace.' : 'Max PF comes from the sampled weeks.'} ${methodNote(d)}</p>`;
  }
  return `<section class="card rv draft-card"><h2 class="sec-title">${d.season} rookie draft</h2><div class="toolbar" style="margin-bottom:12px">${toggle}</div>${body}</section>`;
}

function powerHtml(s) {
  const rows = [...s.rows]
    .sort((a, b) => a.power.rank - b.power.rank)
    .map(
      (r) => `
      <div class="p">
        <span class="rk">${r.power.rank}</span>
        ${team(r.id)}
        <span class="meter"><span class="bar"><i style="width:${r.power.score}%;background:${teamColor(r.id)}"></i></span>${fmt1(r.power.score)}</span>
        <span class="sub">All-play ${record(r.allPlay)} (${r.allPlayPct}%) · Luck ${signed(r.luck)}</span>
      </div>`,
    )
    .join('');
  return card('Power rankings', `<div class="power">${rows}</div><p class="note">Score = 50% all-play win % + 30% points per week + 20% last 3 weeks (each scaled across the league). Luck = actual wins minus all-play expected wins.</p>`, { cls: 'span2' });
}

export async function render(view, ctx) {
  const { meta } = ctx;
  const P = meta.playoffTeams;
  const model = settings().model;
  const open = new Set();
  const picks = new Map(
    (ctx.query.get('p') || '')
      .split(',')
      .filter(Boolean)
      .map((x) => x.split(':')),
  );
  const losers = new Set((ctx.query.get('lose') || '').split(',').filter(Boolean));
  let s = null;
  let shown = null; // odds currently displayed (base or what-if)
  let draft = null;
  let draftMode = 'today';
  let history = null;
  let alive = true;

  const paint = () => {
    if (!alive || !s) return;
    view.innerHTML = `
      <section class="card plain rv span2">
        <div class="toolbar">
          <span class="seg" role="group" aria-label="Odds model">
            <button data-model="coin" class="${model === 'coin' ? 'on' : ''}">Coin flip</button>
            <button data-model="sample" class="${model === 'sample' ? 'on' : ''}">Last 8</button>
          </span>
          <span class="note">${esc(MODEL_NOTE[model])}</span>
        </div>
      </section>
      <section class="card flush rv" id="standingsCard">
        <h2 class="sec-title">Standings${s.week ? ` · through Week ${s.week}` : ''}${picks.size ? ' · <span style="color:var(--accent)">What-if</span>' : ''}</h2>
        <div id="standingsTable">${table(s, shown, s, open, P)}</div>
        <p class="note">${esc(methodNote(shown))} Tap a team for details. Top ${P} make the playoffs; tiebreaker is points for.</p>
      </section>
      ${whatIfHtml(s, picks, losers)}
      ${draftHtml(draft, draftMode, model)}
      ${card('Playoff odds by week', '<div id="oddsChart"><div class="loading">Loading…</div></div>')}
      ${powerHtml(s)}`;
    if (history) drawChart();
    ctx.rerender();
  };

  const repaintTable = () => {
    const el = view.querySelector('#standingsTable');
    if (el) el.innerHTML = table(s, shown, s, open, P);
    const title = view.querySelector('#standingsCard .sec-title');
    if (title) title.innerHTML = `Standings${s.week ? ` · through Week ${s.week}` : ''}${picks.size ? ' · <span style="color:var(--accent)">What-if</span>' : ''}`;
    const note = view.querySelector('#standingsCard .note');
    if (note) note.textContent = `${methodNote(shown)} Tap a team for details. Top ${P} make the playoffs; tiebreaker is points for.`;
  };

  const drawChart = () => {
    const el = view.querySelector('#oddsChart');
    if (!el || !history) return;
    lineChart(el, {
      weeks: history.weeks,
      series: meta.teams.map((t) => ({ id: t.id, name: t.name, color: teamColor(t.id), values: history.series[t.id] ?? [] })),
    });
  };

  let pending = 0;
  const runWhatIf = () => {
    clearTimeout(pending);
    const q = {};
    if (picks.size) q.p = [...picks].map(([k, v]) => `${k}:${v}`).join(',');
    if (losers.size) q.lose = [...losers].join(',');
    setQuery(q);
    if (!picks.size) {
      shown = s;
      repaintTable();
      return;
    }
    pending = setTimeout(async () => {
      const q = [...picks].map(([k, v]) => `${k}:${v}`).join(',');
      try {
        const r = await getJSON(`/api/site/whatif?model=${model}&picks=${encodeURIComponent(q)}`);
        if (!alive) return;
        shown = r;
        repaintTable();
      } catch (err) {
        console.error(err);
      }
    }, 180);
  };

  /** Toggle "lose out" for a team: it loses every remaining game, except against another lose-out team (left open). */
  const toggleLoser = (slug) => {
    const on = !losers.has(slug);
    on ? losers.add(slug) : losers.delete(slug);
    for (const g of s.remaining) {
      const a = teamOf(g.a).slug, b = teamOf(g.b).slug;
      if (a !== slug && b !== slug) continue;
      const opp = a === slug ? b : a;
      if (on) losers.has(opp) ? picks.delete(g.key) : picks.set(g.key, opp);
      else losers.has(opp) ? picks.set(g.key, slug) : picks.delete(g.key);
    }
    const el = view.querySelector('#whatif');
    if (el) {
      el.outerHTML = whatIfHtml(s, picks, losers);
      view.querySelector('#whatif')?.classList.add('in');
    }
    runWhatIf();
  };

  const onClick = (e) => {
    const lose = e.target.closest('[data-lose]');
    if (lose) return toggleLoser(lose.dataset.lose);
    const m = e.target.closest('[data-model]');
    if (m && view.contains(m)) return set('model', m.dataset.model); // main re-renders on model change
    const row = e.target.closest('tr.row');
    if (row) {
      open.has(row.dataset.id) ? open.delete(row.dataset.id) : open.add(row.dataset.id);
      return repaintTable();
    }
    const wi = e.target.closest('.wi-game button');
    if (wi) {
      const { key, slug } = wi.dataset;
      picks.get(key) === slug ? picks.delete(key) : picks.set(key, slug);
      const game = wi.closest('.wi-game');
      game.querySelectorAll('button').forEach((b) => {
        const st = picks.has(key) ? (picks.get(key) === b.dataset.slug ? 'on' : 'off') : '';
        b.className = st;
        b.setAttribute('aria-pressed', String(st === 'on'));
      });
      view.querySelectorAll('[data-act]').forEach((b) => (b.disabled = !picks.size && !losers.size));
      return runWhatIf();
    }
    const act = e.target.closest('[data-act]');
    if (act?.dataset.act === 'reset') {
      picks.clear();
      losers.clear();
      view.querySelectorAll('[data-lose]').forEach((b) => (b.classList.remove('on'), b.setAttribute('aria-pressed', 'false')));
      view.querySelectorAll('.wi-game button').forEach((b) => ((b.className = ''), b.setAttribute('aria-pressed', 'false')));
      view.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
      return runWhatIf();
    }
    if (act?.dataset.act === 'share') {
      navigator.clipboard?.writeText(location.href).then(() => {
        act.textContent = 'Copied';
        setTimeout(() => (act.textContent = 'Copy link'), 1500);
      });
      return;
    }
    const dm = e.target.closest('[data-draft]');
    if (dm) {
      draftMode = dm.dataset.draft;
      const el = view.querySelector('.draft-card');
      if (el) {
        el.outerHTML = draftHtml(draft, draftMode, model);
        view.querySelector('.draft-card')?.classList.add('in');
      }
    }
  };
  view.addEventListener('click', onClick);

  await load(`/api/site/standings?model=${model}`, (data) => {
    s = data;
    shown = s;
    paint();
  });
  if (picks.size) runWhatIf();

  load(`/api/site/draft?model=${model}`, (d) => {
    draft = d;
    const el = view.querySelector('.draft-card');
    if (el && alive) {
      el.outerHTML = draftHtml(draft, draftMode, model);
      view.querySelector('.draft-card')?.classList.add('in');
    }
  }).catch((err) => console.error(err));

  load(`/api/site/odds-history?model=${model}`, (h) => {
    history = h;
    if (alive) drawChart();
  }).catch((err) => console.error(err));

  return () => {
    alive = false;
    clearTimeout(pending);
    view.removeEventListener('click', onClick);
  };
}
