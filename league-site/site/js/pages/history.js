import { load } from '../api.js';
import { card, esc, fmt, fmt1, ordinal, record, team, teamColor, teamOf } from '../ui.js';

const SECTIONS = [
  ['records', 'Record book'],
  ['seasons', 'Seasons'],
  ['shame', 'Hall of Shame'],
  ['more', 'More'],
];
const TONE = { good: 'var(--good)', bad: 'var(--bad)', neutral: 'var(--muted)', matchup: 'var(--accent2)' };
const SORTS = [
  ['default', 'Default'],
  ['record', 'Newest record'],
  ['top3', 'Newest top-3 entry'],
];
const when = (x) => x.season * 100 + x.week;
const latestTop3 = (r) => Math.max(...r.top.slice(0, 3).map(when));
const whenText = (n) => `${Math.floor(n / 100)} Wk ${n % 100}`;
const sortKey = { record: when, top3: latestTop3 };
let sort = 'default';
try {
  sort = localStorage.getItem('site-record-sort') || 'default';
} catch {}
const at = (x) => `${x.season} W${x.week}${x.playoff ? ' (playoffs)' : ''}`;

function nav(section) {
  return `<section class="card plain rv span2"><div class="toolbar"><span class="seg hist-nav" role="tablist">${SECTIONS.map(
    ([k, l]) => `<a role="tab" href="#history/${k}" class="${k === section ? 'on' : ''}" aria-selected="${k === section}">${l}</a>`,
  ).join('')}</span></div></section>`;
}

// ---------------------------------------------------------------------------
// Record book

function recordCard(r) {
  const newest = sort === 'top3' ? latestTop3(r) : null;
  const isNew = (x, i) => newest != null && i < 3 && when(x) === newest;
  const tag = sort === 'record' ? whenText(when(r)) : newest != null ? `top 3: ${whenText(newest)}` : '';
  const holder = r.holderId ? team(r.holderId) : `<span class="team">${esc(r.holder)}</span>`;
  const rest = r.top.slice(1);
  return `
    <article class="rec ${r.broken ? 'broken' : ''}" data-group="${esc(r.group)}" data-text="${esc(`${r.label} ${r.holder} ${r.detail}`.toLowerCase())}">
      <div class="rec-top"><span class="dot" style="--tc:${TONE[r.tone] ?? TONE.neutral}" title="${esc(r.tone)}"></span><span class="rec-label">${esc(r.label)}</span>${r.broken ? '<span class="badge x">NEW</span>' : ''}${tag ? `<span class="rec-when">${tag}</span>` : ''}</div>
      <div class="rec-val ${isNew(r, 0) ? 'newest' : ''}">${esc(r.display)}</div>
      <div class="rec-who">${holder}</div>
      <div class="rec-detail">${esc(r.detail)}</div>
      ${r.broken && r.prev ? `<div class="rec-detail">Previous: ${esc(r.prev.display)} · ${esc(r.prev.holder)}</div>` : ''}
      ${rest.length ? `<details ${newest != null && rest.slice(0, 2).some((x, i) => isNew(x, i + 1)) ? 'open' : ''}><summary>Top ${r.top.length}</summary><ol start="2">${rest.map((x, i) => `<li class="${isNew(x, i + 1) ? 'newest' : ''}"><b>${esc(x.display)}</b> ${esc(x.holder)} <small>${esc(x.detail)}</small></li>`).join('')}</ol></details>` : ''}
    </article>`;
}

const sorted = (list) => (sortKey[sort] ? [...list].sort((a, b) => sortKey[sort](b) - sortKey[sort](a)) : list);

function recordsHtml(d) {
  const groups = d.groups.map((g) => `<button data-g="${esc(g)}">${esc(g)}</button>`).join('');
  const news = d.records.filter((r) => r.broken && r.group !== 'YTD');
  const tally = d.tally
    .map((t) => {
      const total = Math.max(1, t.good + t.bad);
      return `<div class="tally-row">${team(t.id)}<span class="tally-bar"><i class="g" style="width:${(t.good / total) * 100}%"></i><i class="b" style="width:${(t.bad / total) * 100}%"></i></span><span class="num"><span class="good">${t.good}</span> / <span class="bad">${t.bad}</span></span></div>`;
    })
    .join('');
  const streaks = d.streaks
    .map((s) => `<li>${team(s.id)} <span><b>${s.length} ${esc(s.unit)}</b> · ${esc(s.label.replace(/^Longest |^Most /, '').toLowerCase())}${s.isRecord ? ' <span class="badge x">RECORD</span>' : s.record ? ` <small>(record ${s.record.value}, ${esc(s.record.holder)})</small>` : ''}</span></li>`)
    .join('');
  return `
    ${news.length ? card(`Record news · Week ${d.through.week}`, `<ul class="news">${news.map((r) => `<li><b>${esc(r.label)}</b>: ${esc(r.holder)}, ${esc(r.display)}${r.prev ? ` <small>(was ${esc(r.prev.display)}, ${esc(r.prev.holder)})</small>` : ''}</li>`).join('')}</ul>`, { cls: 'span2' }) : ''}
    ${card('Good vs bad records', `<div class="tally">${tally}</div><p class="note">How many #1 spots each team holds, good and bad. YTD records aren't counted.</p>`)}
    ${card('Active streaks', streaks ? `<ul class="streaks">${streaks}</ul>` : '<p class="muted">No active streaks.</p>')}
    <section class="card rv span2">
      <h2 class="sec-title">All records · through ${d.through.season} Week ${d.through.week}</h2>
      <div class="rec-tools">
        <input type="search" class="search" placeholder="Search records, teams…" aria-label="Search records">
        <span class="seg wrap rec-groups" role="group" aria-label="Group"><button data-g="" class="on">All</button>${groups}</span>
        <span class="seg wrap rec-sort" role="group" aria-label="Sort">${SORTS.map(([k, l]) => `<button data-sort="${k}" class="${k === sort ? 'on' : ''}">${l}</button>`).join('')}</span>
      </div>
      <div class="rec-grid">${sorted(d.records.filter((r) => r.group !== 'YTD')).map(recordCard).join('')}${sorted(d.records.filter((r) => r.group === 'YTD')).map(recordCard).join('')}</div>
      <p class="note">Dot color: green = good record, red = bad, gray = neutral, teal = matchup. YTD compares every season through the same week and only shows under its own filter. "Newest top-3 entry" sorts by the latest week anything entered a record's top 3 and highlights that entry.</p>
    </section>`;
}

function wireRecords(view, redraw, keep = {}) {
  view.querySelector('.rec-sort')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b || b.dataset.sort === sort) return;
    sort = b.dataset.sort;
    try {
      localStorage.setItem('site-record-sort', sort);
    } catch {}
    redraw();
  });
  const grid = view.querySelector('.rec-grid');
  if (!grid) return;
  let group = keep.g ?? '';
  let q = (keep.q ?? '').trim().toLowerCase();
  const input = view.querySelector('.search');
  input.value = keep.q ?? '';
  view.querySelectorAll('.rec-groups button').forEach((x) => x.classList.toggle('on', x.dataset.g === group));
  const apply = () => {
    grid.querySelectorAll('.rec').forEach((el) => {
      const g = el.dataset.group;
      const okGroup = group ? g === group : g !== 'YTD';
      el.hidden = !(okGroup && (!q || el.dataset.text.includes(q)));
    });
  };
  view.querySelector('.rec-groups').addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    group = b.dataset.g;
    view.querySelectorAll('.rec-groups button').forEach((x) => x.classList.toggle('on', x === b));
    apply();
  });
  view.querySelector('.search').addEventListener('input', (e) => ((q = e.target.value.trim().toLowerCase()), apply()));
  apply();
}

// ---------------------------------------------------------------------------
// Seasons, Hall of Shame, More

function seasonsHtml(d) {
  return d.seasons
    .map((s) => {
      const rows = s.standings.map((r) => `<tr><td class="rk">${r.rank}</td><td class="tm">${team(r.id)}</td><td>${record(r)}</td><td>${fmt1(r.pf)}</td><td>${fmt1(r.maxpf)}</td></tr>`).join('');
      const bracket = s.bracket
        .map((m) => {
          const line = (id, pts) => `<div class="br-side ${m.winner === id ? 'won' : ''}">${team(id)}<span class="num">${pts == null ? '' : fmt(pts)}</span></div>`;
          return `<div class="br-game"><div class="br-label">${esc(m.label)}</div>${line(m.a, m.aPts)}${line(m.b, m.bPts)}</div>`;
        })
        .join('');
      const champ = s.champion
        ? `<div class="champ" style="--tc:${teamColor(s.champion)}"><span class="cup">🏆</span><div><div class="muted" style="font-size:12px;font-weight:700;letter-spacing:.05em">${s.season} CHAMPION</div><div class="nm">${esc(teamOf(s.champion).name)}</div>${s.runnerUp ? `<div class="muted" style="font-size:12px">Runner-up: ${esc(teamOf(s.runnerUp).name)}</div>` : ''}</div></div>`
        : `<p class="muted" style="margin:0 0 10px">Season in progress.</p>`;
      return `
        <section class="card flush rv">
          <h2 class="sec-title">${s.season} season</h2>
          <div style="padding:0 14px">${champ}</div>
          ${bracket ? `<div class="bracket">${bracket}</div>` : ''}
          <table class="tbl"><thead><tr><th class="l">#</th><th class="l">Regular season</th><th>W-L</th><th>PF</th><th>Max PF</th></tr></thead><tbody>${rows}</tbody></table>
          ${s.high ? `<p class="note">High score: ${esc(teamOf(s.high.id).name)}, ${fmt(s.high.pts)} in Week ${s.high.week}.</p>` : ''}
        </section>`;
    })
    .join('');
}

function shameHtml(d) {
  const s = d.shame;
  const list = (items, fn) => `<ol class="shame">${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ol>`;
  return `
    ${card('Lowest scores ever', list(s.lowest, (x) => `${team(x.id)}<span><b>${fmt(x.pts)}</b> <small>${x.opp ? `vs ${esc(teamOf(x.opp).name)} · ` : 'bye · '}${at(x)}</small></span>`))}
    ${card('Worst blowouts suffered', list(s.blowouts, (x) => `${team(x.id)}<span><b>−${fmt(x.margin)}</b> <small>${fmt(x.pts)}–${fmt(x.oppPts)} to ${esc(teamOf(x.by).name)} · ${at(x)}</small></span>`))}
    ${card('Lost to the lineup', list(s.lineupLosses, (x) => `${team(x.id)}<span><b>${fmt(x.left)}</b> left on the bench <small>scored ${fmt(x.pts)}, could have had ${fmt(x.best)}, lost to ${esc(teamOf(x.by).name)}'s ${fmt(x.oppPts)} · ${at(x)}</small></span>`) + '<p class="note">Losses where the best possible lineup would have won.</p>')}
    ${card('Most points left on the bench', list(s.benched, (x) => `${team(x.id)}<span><b>${fmt(x.left)}</b> <small>scored ${fmt(x.pts)} · ${at(x)}</small></span>`))}`;
}

function moreHtml(d) {
  const p = d.pool;
  const pool = p
    ? card('League pool', `<div class="pool"><div class="v">$${fmt(p.value)}</div><div class="${p.change >= 0 ? 'good' : 'bad'}" style="font-weight:700">${p.change >= 0 ? '+' : '−'}$${fmt(Math.abs(p.change))} (${p.pct >= 0 ? '+' : ''}${p.pct}%)</div><div class="note">$${fmt(p.invested)} invested in ${esc(p.ticker)} at $${fmt(p.buyPrice)}. ${esc(p.ticker)} is $${fmt(p.price)} now.</div></div>`)
    : '';
  const week = d.thisWeek
    .map(
      (s) => `<div class="hist-week"><h4>${s.season} · Week ${s.week}${s.playoff ? ' (playoffs)' : ''}</h4><ul class="plain-list">${s.results
        .map((r) => `<li>${team(r.winner)} <span class="muted">beat</span> ${team(r.loser)} <span class="num muted">${fmt(r.wPts)}–${fmt(r.lPts)}</span></li>`)
        .join('')}</ul><p class="note">High score: ${esc(teamOf(s.high.id).name)}, ${fmt(s.high.pts)}</p></div>`,
    )
    .join('');
  const ms = d.milestones.map((m) => `<li>${team(m.id)} <span>is <b>${m.unit === 'pts' ? fmt1(m.need) : m.need} ${esc(m.unit)}</b> from ${esc(m.text)}</span></li>`).join('');
  const recaps = d.recaps.length
    ? `<div class="recaps">${d.recaps.map((r) => `<a href="${esc(r.file)}" target="_blank" rel="noopener"><img src="${esc(r.file)}" alt="${esc(r.season ? `${r.season} Week ${r.week} recap` : r.name)}" loading="lazy"><span>${esc(r.season ? `${r.season} · Week ${r.week}` : r.name)}</span></a>`).join('')}</div>`
    : '<p class="muted">No recaps yet. Drop exported recap images into <code>site/recaps/</code> (named like <code>2026-week-08.png</code>) and they show up here.</p>';
  const wm = d.weekMilestones;
  const reached = wm?.reached.length
    ? `<ul class="streaks">${wm.reached.map((m) => `<li>${team(m.id)} <span>reached <b>${esc(m.text)}</b> <small>${esc(m.detail)}</small></span></li>`).join('')}</ul>`
    : '<p class="muted">Nobody hit a milestone this week.</p>';
  return `
    ${pool}
    ${wm && wm.week ? card(`Milestones reached · Week ${wm.week}`, reached) : ''}
    ${card('Upcoming milestones', ms ? `<ul class="streaks">${ms}</ul>` : '<p class="muted">Nobody is close to a milestone right now.</p>')}
    ${card(`This week in league history`, week || '<p class="muted">No past seasons played this week yet.</p>')}
    ${card('Weekly recaps', recaps, { cls: 'span2' })}`;
}

export async function render(view, ctx) {
  const section = SECTIONS.some(([k]) => k === ctx.args[0]) ? ctx.args[0] : 'records';
  let alive = true;
  if (section === 'records') {
    await load('/api/site/records', (d) => {
      if (!alive) return;
      const draw = () => {
        // Keep the search text and group filter across a re-sort.
        const q = view.querySelector('.search')?.value ?? '';
        const g = view.querySelector('.rec-groups .on')?.dataset.g ?? '';
        view.innerHTML = nav(section) + recordsHtml(d);
        wireRecords(view, draw, { q, g });
        ctx.rerender();
      };
      draw();
    });
  } else {
    await load('/api/site/history', (d) => {
      if (!alive) return;
      view.innerHTML = nav(section) + (section === 'seasons' ? seasonsHtml(d) : section === 'shame' ? shameHtml(d) : moreHtml(d));
      ctx.rerender();
    });
  }
  return () => (alive = false);
}
