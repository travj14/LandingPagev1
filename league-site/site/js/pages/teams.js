import { load } from '../api.js';
import { settings } from '../settings.js';
import { card, esc, fmt, fmt1, ordinal, pct, record, team, teamColor, teamOf } from '../ui.js';

const TX_LABEL = { trade: 'Trade', waiver: 'Waiver', free_agent: 'Free agent', commissioner: 'Commissioner' };
const shortDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function avatar(id, size = '') {
  const t = teamOf(id);
  return t.avatar
    ? `<img class="avatar ${size}" src="${esc(t.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="avatar ${size}" style="background:${teamColor(id)}">${esc(t.name[0] ?? '?')}</span>`;
}

const pickText = (p, holder) => {
  const via = p.original && p.original !== holder ? ` <small>(${esc(teamOf(p.original).name)})</small>` : '';
  const proj = p.projected ? ` <small>· ${esc(p.projected)}</small>` : '';
  return `${esc(p.label)}${via}${proj}`;
};

function txHtml(t) {
  const items = (s) => {
    const li = (sign, cls, html) => `<li><span class="sign ${cls}">${sign}</span><span>${html}</span></li>`;
    return [
      ...s.adds.map((p) => li('+', 'add', `${esc(p.name)} <small>${esc(p.pos)}${p.team ? ` · ${esc(p.team)}` : ''}${p.since ? ` · ${fmt1(p.since)} pts started since` : ''}</small>`)),
      ...s.picksIn.map((p) => li('+', 'add', pickText(p, s.id))),
      ...(s.faabIn ? [li('+', 'add', `$${s.faabIn} FAAB`)] : []),
      ...(t.type === 'trade' ? [] : s.drops.map((p) => li('−', 'drop', `${esc(p.name)} <small>${esc(p.pos)}</small>`))),
    ].join('');
  };
  const sides = t.sides
    .filter((s) => s.id)
    .map((s) => `<div class="tx-side">${team(s.id)}<ul class="tx-items">${items(s) || '<li class="muted">Nothing</li>'}</ul></div>`)
    .join('');
  const bid = t.type === 'waiver' && t.bid ? ` · $${t.bid} bid` : '';
  return `
    <div class="tx">
      <div class="tx-head"><span class="tx-type ${t.type}">${TX_LABEL[t.type] ?? esc(t.type)}</span><span>Week ${t.week} · ${shortDate(t.at)}${bid}</span></div>
      <div class="tx-sides ${t.type === 'trade' ? 'trade' : ''}">${sides}</div>
    </div>`;
}

/** Transactions list with a type filter and "show more". */
function txFeed(el, list) {
  let filter = 'all';
  let shown = 15;
  const draw = () => {
    const rows = list.filter((t) => filter === 'all' || (filter === 'trade' ? t.type === 'trade' : t.type !== 'trade'));
    el.innerHTML = `
      <div class="filters"><span class="seg" role="group" aria-label="Filter">
        ${[['all', 'All'], ['trade', 'Trades'], ['moves', 'Waivers & FA']].map(([k, l]) => `<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}
      </span></div>
      ${rows.slice(0, shown).map(txHtml).join('') || '<p class="muted">No transactions yet.</p>'}
      ${rows.length > shown ? `<button class="btn" data-more>Show more (${rows.length - shown})</button>` : ''}`;
  };
  el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]');
    if (f) (filter = f.dataset.f), (shown = 15), draw();
    if (e.target.closest('[data-more]')) (shown += 25), draw();
  });
  draw();
}

// ---------------------------------------------------------------------------

function indexHtml(d) {
  const cards = d.teams
    .map(
      (t) => `
      <a class="team-card" href="#teams/${esc(teamOf(t.id).slug)}" style="--tc:${teamColor(t.id)}">
        <div class="top">${avatar(t.id)}<div style="min-width:0"><div class="nm">${esc(teamOf(t.id).name)}</div><div class="sub">${ordinal(t.rank)} · ${record(t)}${t.titles ? ` · <span class="trophy">${'🏆'.repeat(t.titles)}</span>` : ''}</div></div></div>
        <div class="row2"><span class="muted">Playoffs</span><b>${pct(t.odds)}</b></div>
        <div class="row2"><span class="muted">PF</span><span>${fmt1(t.pf)}</span></div>
        <div class="row2"><span class="muted">All-time</span><span>${record(t.career)}</span></div>
      </a>`,
    )
    .join('');
  const act = d.activity
    .map((a) => `<tr><td class="tm">${team(a.id)}</td><td>${a.trades}</td><td>${a.adds}</td><td>${a.drops}</td><td>$${a.faab}</td></tr>`)
    .join('');
  return `
    <section class="card plain rv span2"><div class="team-cards">${cards}</div></section>
    <section class="card rv" id="txFeed"><h2 class="sec-title">Transactions · this season</h2><div class="feed"></div></section>
    <section class="card flush rv"><h2 class="sec-title">Activity · this season</h2>
      <table class="tbl"><thead><tr><th class="l">Team</th><th>Trades</th><th>Adds</th><th>Drops</th><th>FAAB</th></tr></thead><tbody>${act}</tbody></table>
      <p class="note">FAAB is the total of winning waiver bids.</p></section>`;
}

/** Drawn at the container's pixel width so text stays the same size on any screen. */
function barsHtml(weeks, width) {
  if (!weeks.length) return '<p class="muted">No games yet.</p>';
  const W = Math.max(300, Math.round(width)), H = 210, M = { l: 38, r: 8, t: 10, b: 34 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const max = Math.max(...weeks.map((w) => Math.max(w.pts, w.median))) * 1.08;
  const step = iw / weeks.length;
  const bw = Math.min(56, step * 0.7);
  const y = (v) => M.t + ih - (v / max) * ih;
  const tickStep = max > 400 ? 100 : 50;
  const ticks = Array.from({ length: Math.floor(max / tickStep) + 1 }, (_, i) => i * tickStep);
  const grid = ticks.map((v) => `<line class="base" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const bars = weeks
    .map((w, i) => {
      const x = M.l + i * step + (step - bw) / 2;
      const top = y(w.pts);
      const op = w.result === 'L' ? 0.45 : 1;
      const tip = `Week ${w.week}${w.playoff ? ' (playoffs)' : ''}: ${fmt(w.pts)}${w.opp ? ` vs ${teamOf(w.opp).name} ${fmt(w.oppPts)}` : ' (bye)'} · league median ${fmt(w.median)}`;
      return `<g><title>${esc(tip)}</title>
        <path d="M${x},${y(0)} V${top + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${y(0)} Z" style="fill:var(--tc);opacity:${op}"/>
        <line class="med" x1="${x - 2}" x2="${x + bw + 2}" y1="${y(w.median)}" y2="${y(w.median)}"/>
        <text x="${x + bw / 2}" y="${H - 18}" text-anchor="middle">${w.week}</text>
        <text class="res" x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" style="fill:${w.result === 'W' ? 'var(--good)' : w.result === 'L' ? 'var(--bad)' : 'var(--muted)'}">${w.result === 'BYE' ? 'BYE' : w.result}</text>
      </g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Weekly scores"><g class="axis">${grid}</g><g class="axis">${bars}</g></svg>`;
}

const barsNote = `<p class="note">Bars are weekly scores (faded = loss). The tick on each bar is that week's league median. Hover or long-press a bar for details.</p>`;

function teamHtml(d) {
  const t = teamOf(d.id);
  const c = d.career;
  const trophies = c.seasons
    .filter((s) => s.finish === 'Champion' || s.finish === 'Runner-up')
    .map((s) => `<span class="chip">${s.finish === 'Champion' ? '🏆' : '🥈'} ${s.season} ${s.finish}</span>`)
    .join('');
  const head = `
    <section class="card rv span2 team-head" style="--tc:${teamColor(d.id)}">
      ${avatar(d.id, 'lg')}
      <div style="min-width:0">
        <h1>${esc(t.name)}</h1>
        <div class="sub">${ordinal(d.rank)} place · ${record(d)}${d.streak ? ` · ${esc(d.streak)}` : ''} · ${pct(d.odds)} playoff odds</div>
        ${trophies ? `<div class="trophies">${trophies}</div>` : ''}
      </div>
    </section>`;
  const tiles = `
    <div class="tiles rv span2">
      <div class="tile"><div class="k">Points for</div><div class="v">${fmt1(d.pf)}</div></div>
      <div class="tile"><div class="k">Max PF</div><div class="v">${fmt1(d.maxpf)}</div></div>
      <div class="tile"><div class="k">Points against</div><div class="v">${fmt1(d.pa)}</div></div>
      <div class="tile"><div class="k">All-play</div><div class="v">${record(d.allPlay)}</div></div>
    </div>`;

  const seasons = c.seasons
    .map((s) => `<tr><td class="l">${s.season}</td><td>${record(s)}</td><td>${s.rank ? ordinal(s.rank) : '–'}</td><td>${fmt1(s.pf)}</td><td class="l">${esc(s.finish)}</td></tr>`)
    .join('');
  const careerCard = `
    <section class="card flush rv"><h2 class="sec-title">Career</h2>
      <div class="kv" style="padding:0 14px 10px">
        <div><b>${record(c)}</b><span>Regular season</span></div>
        <div><b>${c.titles}</b><span>Titles</span></div>
        <div><b>${c.playoffs}</b><span>Playoff trips</span></div>
        <div><b>${c.weeklyHighs}</b><span>Weekly high scores</span></div>
        <div><b>${d.best ? fmt1(d.best.pts) : '–'}</b><span>Best week${d.best ? ` (${d.best.season} W${d.best.week})` : ''}</span></div>
        <div><b>${d.worst ? fmt1(d.worst.pts) : '–'}</b><span>Worst week${d.worst ? ` (${d.worst.season} W${d.worst.week})` : ''}</span></div>
      </div>
      <table class="tbl"><thead><tr><th class="l">Season</th><th>W-L</th><th>Finish</th><th>PF</th><th class="l">Result</th></tr></thead><tbody>${seasons}</tbody></table>
    </section>`;

  const bySeason = new Map();
  for (const p of d.picks) bySeason.set(p.season, [...(bySeason.get(p.season) ?? []), p]);
  const capital = [...bySeason]
    .map(([season, picks]) => `<div class="cap-season"><h4>${season} · ${picks.length} pick${picks.length === 1 ? '' : 's'}</h4><div class="chips">${picks.map((p) => `<span class="chip"><b>${esc(p.label.split(' ')[1])}</b>${p.original !== d.id ? ` <small>via ${esc(teamOf(p.original).name)}</small>` : ''}${p.projected ? ` <small>· ${esc(p.projected)}</small>` : ''}</span>`).join('')}</div></div>`)
    .join('');

  const groups = new Map();
  for (const p of d.roster) groups.set(p.pos || 'Other', [...(groups.get(p.pos || 'Other') ?? []), p]);
  const win = (p) => (p.winPct == null ? '–' : `${Math.round(p.winPct)}%<small>${p.wins + p.ties / 2}/${p.games}</small>`);
  const roster = `<table class="tbl roster"><thead><tr><th class="l">Player</th><th title="Starts">GS</th><th title="Points per start">PPG</th><th title="Team record when he started">Win%</th><th title="Points as a starter">Pts</th></tr></thead>${[...groups]
    .map(
      ([pos, list]) =>
        `<tbody><tr class="grp"><th class="l" colspan="5">${esc(pos)}</th></tr>${list
          .map((p) => `<tr class="${p.starts ? '' : 'dim'}"><td class="l nm">${esc(p.name)} <small class="muted">${esc(p.team ?? 'FA')}</small></td><td>${p.starts || '–'}</td><td>${p.ppg == null ? '–' : fmt1(p.ppg)}</td><td class="wp">${win(p)}</td><td>${p.pts ? fmt1(p.pts) : '–'}</td></tr>`)
          .join('')}</tbody>`,
    )
    .join('')}</table>`;

  const h2h = d.h2h.map((r) => `<tr><td class="tm">${team(r.opp)}</td><td>${record(r)}</td></tr>`).join('');

  return `
    ${head}
    ${tiles}
    ${card('Weekly scores · this season', `<div class="bars"></div>${barsNote}`, { cls: 'span2' })}
    ${careerCard}
    ${card('Draft capital', capital || '<p class="muted">No future picks owned.</p>', {})}
    <section class="card flush rv"><h2 class="sec-title">Roster</h2>${roster}<p class="note">This season, in this team's starting lineup. GS = starts, PPG = points per start, Win% = the team's record in games he started (3 wins in 5 starts = 60%). Bye-week starts count toward GS and PPG but not Win%.</p></section>
    <section class="card flush rv"><h2 class="sec-title">Head-to-head · all time</h2><table class="tbl"><thead><tr><th class="l">Opponent</th><th>W-L</th></tr></thead><tbody>${h2h}</tbody></table><p class="note">Regular season only.</p></section>
    <section class="card rv span2" id="txFeed"><h2 class="sec-title">Transactions · this season</h2><div class="feed"></div></section>`;
}

export async function render(view, ctx) {
  const model = settings().model;
  const slug = ctx.args[0];
  let alive = true;
  let drawBars = () => {};
  const url = slug ? `/api/site/team/${encodeURIComponent(slug)}?model=${model}` : `/api/site/teams?model=${model}`;
  await load(url, (d) => {
    if (!alive) return;
    view.innerHTML = slug ? `<a href="#teams" class="muted span2" style="font-size:13px;text-decoration:none">‹ All teams</a>${teamHtml(d)}` : indexHtml(d);
    const feed = view.querySelector('#txFeed .feed');
    if (feed) txFeed(feed, d.transactions);
    if (slug) drawBars = () => view.querySelectorAll('.bars').forEach((el) => {
      el.style.setProperty('--tc', teamColor(d.id));
      el.innerHTML = barsHtml(d.weeks, el.clientWidth);
    });
    drawBars();
    ctx.rerender();
  });
  let t = 0;
  const onResize = () => (clearTimeout(t), (t = setTimeout(drawBars, 150)));
  addEventListener('resize', onResize);
  return () => {
    alive = false;
    removeEventListener('resize', onResize);
  };
}
