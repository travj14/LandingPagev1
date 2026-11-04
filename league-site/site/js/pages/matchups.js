import { getJSON, load } from '../api.js';
import { card, esc, fmt, fmt1, record, team, teamColor, teamOf } from '../ui.js';

function lineup(side) {
  const row = (p) => `<li><span class="nm">${esc(p.name)} <small class="muted">${esc(p.pos)}</small></span><span class="pts">${fmt(p.pts, 1)}</span></li>`;
  return `
    <div>
      ${team(side.id)}
      <ul class="plist lineup">${side.starters.map(row).join('')}</ul>
      ${side.bench.length ? `<div class="bench-h">Bench</div><ul class="plist lineup bench">${side.bench.map(row).join('')}</ul>` : ''}
    </div>`;
}

function gameHtml(g) {
  const final = g.played && !g.live;
  const side = (s, o) => {
    const lost = final && o && s.pts < o.pts;
    return `
      <div class="side ${lost ? 'lost' : ''}">
        ${team(s.id)}
        <span class="score">${g.played ? fmt(s.pts) : s.proj != null ? `<span class="proj">${fmt(s.proj, 1)}<small> proj</small></span>` : '–'}</span>
      </div>
      ${g.played ? `<div class="sub"><span>Best possible ${fmt(s.maxPts, 1)} · ${fmt(s.left, 1)} left on bench</span>${g.lineupLoss === s.id ? '<span class="bad" style="font-weight:700">Lost to the lineup</span>' : ''}</div>` : ''}`;
  };
  const vs = g.b ? `<a class="rival-link" href="#matchups/rivalry/${esc(teamOf(g.a.id).slug)}/${esc(teamOf(g.b.id).slug)}">Rivalry ›</a>` : '';
  return `
    <section class="card rv">
      <div class="game plain-game">
        ${side(g.a, g.b)}
        ${g.b ? side(g.b, g.a) : '<div class="sub"><span>Bye week · points still count toward PF</span></div>'}
      </div>
      <details class="lineups">
        <summary>Lineups</summary>
        <div class="cols2">${lineup(g.a)}${g.b ? lineup(g.b) : ''}</div>
      </details>
      ${vs ? `<div class="note" style="text-align:right">${vs}</div>` : ''}
    </section>`;
}

function weekNav(weeks, season, week) {
  const s = weeks.find((x) => x.season === season) ?? weeks[0];
  const seasons = weeks.map((x) => `<option value="${x.season}" ${x.season === season ? 'selected' : ''}>${x.season}</option>`).join('');
  const chips = s.weeks
    .map((w) => `<a class="wk ${w === week ? 'on' : ''}" href="#matchups/${s.season}/${w}">${w > s.regWeeks ? `P${w - s.regWeeks}` : w}</a>`)
    .join('');
  return `
    <section class="card plain rv span2">
      <div class="toolbar">
        <select class="season-select" aria-label="Season">${seasons}</select>
        <nav class="weeks" aria-label="Week">${chips}</nav>
      </div>
    </section>`;
}

function h2hHtml(d) {
  const head = d.ids.map((id) => `<th class="c" title="${esc(teamOf(id).name)}"><span class="dot" style="--tc:${teamColor(id)};display:inline-block"></span><span class="ab">${esc(teamOf(id).name.slice(0, 3))}</span></th>`).join('');
  const rows = d.ids
    .map((a) => {
      const cells = d.ids
        .map((b) => {
          if (a === b) return '<td class="cell self"></td>';
          const { reg, post } = d.cells[a][b];
          const n = reg.w + reg.l + reg.t;
          const tone = reg.w > reg.l ? 'good' : reg.w < reg.l ? 'bad' : '';
          const p = post.w + post.l + post.t ? `<small>${record(post)} P</small>` : '';
          return `<td class="cell"><a href="#matchups/rivalry/${esc(teamOf(a).slug)}/${esc(teamOf(b).slug)}" class="${tone}">${n ? record(reg) : '–'}</a>${p}</td>`;
        })
        .join('');
      return `<tr><td class="tm">${team(a)}</td>${cells}</tr>`;
    })
    .join('');
  return `
    <section class="card flush rv span2"><h2 class="sec-title">Head-to-head · all time</h2>
      <div style="overflow-x:auto"><table class="tbl h2h"><thead><tr><th class="l">Row vs column</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">Regular-season record of the row team against the column team. "P" is playoffs. Tap a record for the rivalry.</p>
    </section>`;
}

function rivalryHtml(r) {
  const A = teamOf(r.a), B = teamOf(r.b);
  const when = (m) => `${m.season} W${m.week}${m.playoff ? ' (playoffs)' : ''}`;
  const result = (m) => (m.a === m.b ? `Tie at ${fmt(m.a)}` : `${esc(m.a > m.b ? A.name : B.name)} by ${fmt(Math.abs(m.a - m.b))}`);
  const rows = r.meetings
    .map((m) => `<tr><td class="l">${when(m)}</td><td class="${m.a > m.b ? 'win' : ''}">${fmt(m.a)}</td><td class="${m.b > m.a ? 'win' : ''}">${fmt(m.b)}</td></tr>`)
    .join('');
  return `
    <a href="#matchups" class="muted span2" style="font-size:13px;text-decoration:none">‹ Matchups</a>
    <section class="card rv span2 rivalry-head">
      <div class="vs-side">${team(r.a)}<div class="big">${r.reg.w}</div></div>
      <div class="vs-mid"><div class="muted">Regular season</div><div style="font-weight:800">${r.reg.t ? `${r.reg.t} tie${r.reg.t > 1 ? 's' : ''}` : 'vs'}</div>${r.post.w + r.post.l + r.post.t ? `<div class="muted" style="font-size:12px">Playoffs ${record(r.post)}</div>` : ''}</div>
      <div class="vs-side r">${team(r.b)}<div class="big">${r.reg.l}</div></div>
    </section>
    <div class="tiles rv span2">
      <div class="tile"><div class="k">Streak</div><div class="s" style="font-size:14px;color:var(--text);white-space:normal">${esc(r.streak || 'Never played')}</div></div>
      <div class="tile"><div class="k">Average score</div><div class="v" style="font-size:16px">${r.avgA == null ? '–' : `${fmt1(r.avgA)} – ${fmt1(r.avgB)}`}</div></div>
      <div class="tile"><div class="k">Biggest blowout</div><div class="s" style="color:var(--text);white-space:normal">${r.blowout ? `${result(r.blowout)} · ${when(r.blowout)}` : '–'}</div></div>
      <div class="tile"><div class="k">Closest game</div><div class="s" style="color:var(--text);white-space:normal">${r.closest ? `${result(r.closest)} · ${when(r.closest)}` : '–'}</div></div>
    </div>
    <section class="card flush rv"><h2 class="sec-title">Every meeting</h2>
      ${rows ? `<table class="tbl meet"><thead><tr><th class="l">Game</th><th>${esc(A.name)}</th><th>${esc(B.name)}</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="note">They haven’t played yet.</p>'}
    </section>
    ${card('Coming up', r.upcoming.length ? `<div class="chips">${r.upcoming.map((u) => `<a class="chip" href="#matchups/${u.season}/${u.week}" style="text-decoration:none">${u.season} Week ${u.week}</a>`).join('')}</div>` : '<p class="muted">No more meetings scheduled this season.</p>')}`;
}

export async function render(view, ctx) {
  let alive = true;
  const [first, ...rest] = ctx.args;

  if (first === 'rivalry') {
    await load(`/api/site/rivalry/${encodeURIComponent(rest[0] ?? '')}/${encodeURIComponent(rest[1] ?? '')}`, (r) => {
      if (!alive) return;
      view.innerHTML = rivalryHtml(r);
      ctx.rerender();
    });
    return () => (alive = false);
  }

  const weeks = await getJSON('/api/site/weeks');
  const latest = weeks[0];
  let season = Number(first) || latest.season;
  const s = weeks.find((x) => x.season === season) ?? latest;
  season = s.season;
  // Default: the current week if it has started, otherwise the last completed one.
  const fallback = season === ctx.meta.season && ctx.meta.completedWeek ? Math.min(ctx.meta.currentWeek, s.weeks.at(-1)) : s.weeks.at(-1);
  const week = s.weeks.includes(Number(rest[0])) ? Number(rest[0]) : fallback;

  const draw = (d, h2h) => {
    if (!alive) return;
    const title = `${d.season} · ${d.playoff ? `Playoffs, week ${d.week}` : `Week ${d.week}`}${d.live ? ' <span class="pill live">Live</span>' : ''}`;
    view.innerHTML = `
      ${weekNav(weeks, season, week)}
      <h2 class="sec-title span2" style="margin:4px 0 -4px">${title}</h2>
      ${d.games.map(gameHtml).join('')}
      ${h2h ? h2hHtml(h2h) : ''}`;
    view.querySelector('.season-select').addEventListener('change', (e) => (location.hash = `#matchups/${e.target.value}`));
    view.querySelector('.wk.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    ctx.rerender();
  };

  let h2h = null;
  let wk = null;
  const [w] = await Promise.all([
    load(`/api/site/week/${season}/${week}`, (d) => ((wk = d), draw(d, h2h))),
    load('/api/site/h2h', (d) => ((h2h = d), wk && draw(wk, h2h))),
  ]);
  void w;
  return () => (alive = false);
}
