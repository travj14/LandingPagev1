import { load } from '../api.js';
import { settings } from '../settings.js';
import { card, countdown, esc, fmt, pct, record, team, teamOf, when } from '../ui.js';

const LIVE_POLL_MS = 60e3;

function sideRow(s, other, final) {
  const lost = final && other && s.pts < other.pts;
  const started = final || s.pts > 0 || (other && other.pts > 0);
  // Before kickoff the score slot shows the projection; after, the score with the projection underneath.
  const score = started ? fmt(s.pts) : s.proj != null ? `<span class="proj">${fmt(s.proj, 1)}<small> proj</small></span>` : '–';
  const top = started && s.top ? `${esc(s.top.name)} ${fmt(s.top.pts, 1)}` : '';
  const sub = top || (started && s.proj != null) ? `<div class="sub"><span>${top}</span><span>${started && s.proj != null ? `proj ${fmt(s.proj, 1)}` : ''}</span></div>` : '';
  return `
    <div class="side ${lost ? 'lost' : ''}">
      ${team(s.id)}
      <span class="score">${score}</span>
    </div>
    ${sub}`;
}

function gameCard(g, final) {
  if (g.bye) {
    return `<div class="game">${sideRow(g.a, null, final)}<div class="sub"><span>Bye week · points still count toward PF</span></div></div>`;
  }
  return `<div class="game">${sideRow(g.a, g.b, final)}${sideRow(g.b, g.a, final)}</div>`;
}

function scoreboard(d) {
  const label = d.status === 'live' ? '<span class="pill live">Live</span>' : d.status === 'final' ? '<span class="pill">Final</span>' : '<span class="pill">Upcoming</span>';
  const title = d.playoff ? `Week ${d.week} · Playoffs` : `Week ${d.week}`;
  const games = d.games.filter((g) => !g.bye || g.a.id).map((g) => gameCard(g, d.status === 'final')).join('');
  return `<section class="card rv"><h2 class="sec-title">${esc(title)} ${label}</h2><div class="games">${games || '<p class="muted">No games scheduled.</p>'}</div></section>`;
}

function stakesCard(d) {
  if (!d.stakes.length) return '';
  const model = d.model === 'sample' ? 'Last 8 model' : 'Coin flip model';
  const rows = d.stakes
    .map((s) => {
      const line = (x) => `
        <div class="stake-row">
          ${team(x.id)}
          <span class="v">${pct(x.now)}</span>
          <span class="v good">${pct(x.win)}</span>
          <span class="v bad">${pct(x.loss)}</span>
        </div>`;
      return `
        <div class="stake">
          <div class="stake-head">
            <span class="muted" style="font-size:13px;font-weight:600">${esc(teamOf(s.a.id).name)} vs ${esc(teamOf(s.b.id).name)}</span>
            <span class="stake-total">${fmt(s.total, 1)}<small>pts</small></span>
          </div>
          <div class="stake-row"><span></span><span class="h">Now</span><span class="h">Win</span><span class="h">Loss</span></div>
          ${line(s.a)}${line(s.b)}
        </div>`;
    })
    .join('');
  return card(`What's at stake · Week ${d.week}`, `${rows}<p class="note">Combined playoff odds that swing on each game. ${model}.</p>`);
}

function countdownTiles(d) {
  if (!d.countdowns.length) return '';
  return `<div class="grid2 rv span2" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">${d.countdowns
    .map((c) => `<div class="tile"><div class="k">${esc(c.label)}</div><div class="v" data-at="${esc(c.at)}" data-done="${esc(c.done)}">${countdown(c.at, c.done)}</div><div class="s">${esc(when(c.at))}</div></div>`)
    .join('')}</div>`;
}

function lastResults(d) {
  if (!d.lastResults.length) return '';
  return card(`Week ${d.lastResults[0].week} results`, `<div class="games">${d.lastResults.filter((g) => !g.bye).map((g) => gameCard(g, true)).join('')}</div>`);
}

function awardsCard(a) {
  if (!a) return '';
  const item = (k, s, sub) => (s ? `<div class="award"><div class="k">${k}</div>${team(s.id)}<div class="s">${sub}</div></div>` : '');
  const vs = (x) => `vs ${esc(teamOf(x.loser.id).name)}`;
  const body = [
    item('High score', a.high, `${fmt(a.high.pts)} pts`),
    item('Low score', a.low, `${fmt(a.low.pts)} pts`),
    a.blowout && item('Biggest blowout', a.blowout.winner, `by ${fmt(a.blowout.margin)} ${vs(a.blowout)}`),
    a.closest && item('Closest game', a.closest.winner, `by ${fmt(a.closest.margin)} ${vs(a.closest)}`),
    a.lucky && item('Lucky win', a.lucky.winner, `Won with ${fmt(a.lucky.winner.pts)}, below the ${fmt(a.median)} median`),
    a.unlucky && item('Unlucky loss', a.unlucky.loser, `Lost with ${fmt(a.unlucky.loser.pts)}, above the median`),
    a.bench && item('Left on the bench', a.bench, `${fmt(a.bench.left)} pts`),
  ]
    .filter(Boolean)
    .join('');
  return card(`Week ${a.week} awards`, `<div class="awards">${body}</div>`);
}

function miniStandings(d, P) {
  if (!d.top.length) return '';
  const rows = d.top
    .map((r, i) => `<tr class="${i === P ? 'cut' : ''}"><td class="rk">${r.rank}</td><td class="tm">${team(r.id)}</td><td>${record(r)}</td><td>${pct(r.odds)}</td></tr>`)
    .join('');
  return `<section class="card flush rv"><h2 class="sec-title">Standings<a class="more" href="#standings">Full standings</a></h2>
    <table class="tbl"><thead><tr><th class="l">#</th><th class="l">Team</th><th>W-L</th><th>Playoffs</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function milestonesCard(m) {
  if (!m?.reached.length) return '';
  const rows = m.reached.map((x) => `<li>${team(x.id)} <span>reached <b>${esc(x.text)}</b> <small>${esc(x.detail)}</small></span></li>`).join('');
  return card(`Milestones · Week ${m.week}`, `<ul class="streaks">${rows}</ul><p class="note"><a href="#history/more">Upcoming milestones ›</a></p>`);
}

function headlineRow(d) {
  const p = d.pool;
  const pool = p
    ? `<a class="pool-mini" href="#history/more" aria-label="League pool"><small>League pool</small><b>$${fmt(p.value)}</b><span class="${p.change >= 0 ? 'good' : 'bad'}">${p.pct >= 0 ? '+' : ''}${p.pct}%</span></a>`
    : '';
  if (!d.headline && !pool) return '';
  return `<section class="card rv span2 headline-row">${d.headline ? `<div class="headline"><small>Headline</small>${esc(d.headline)}</div>` : '<div></div>'}${pool}</section>`;
}

export async function render(view, ctx) {
  const model = settings().model;
  let timer = 0;
  let ticker = 0;
  let alive = true;

  const draw = (d) => {
    if (!alive) return;
    view.innerHTML = [
      headlineRow(d),
      scoreboard(d),
      stakesCard(d),
      countdownTiles(d),
      lastResults(d),
      awardsCard(d.awards),
      milestonesCard(d.weekMilestones),
      miniStandings(d, ctx.meta.playoffTeams),
    ].join('');
    ctx.rerender();
  };

  const url = `/api/site/home?model=${model}`;
  const d = await load(url, draw);

  // Live games: refresh scores every minute while the page is visible.
  if (d.status === 'live') {
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(url, draw, { cache: true }).catch(() => {});
    }, LIVE_POLL_MS);
  }
  // Countdowns tick every second, so they stay right on a page left open for hours.
  ticker = setInterval(() => {
    view.querySelectorAll('[data-at]').forEach((el) => {
      el.textContent = countdown(el.dataset.at, el.dataset.done);
      el.classList.toggle('passed', Date.parse(el.dataset.at) <= Date.now());
    });
  }, 1e3);
  return () => {
    alive = false;
    clearInterval(timer);
    clearInterval(ticker);
  };
}
