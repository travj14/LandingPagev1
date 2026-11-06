// payrollgm.com/projections: live matchup projections for BLU and El Diablo.
// The server refreshes for everyone (every 10 minutes, or on request after a 1-minute
// cooldown) and announces each refresh over server-sent events; this page reloads then.
import { setDefaults } from './settings.js';
import { esc, fmt, fmt1, pct, record, LEAGUE_TZ } from './ui.js';

const LEAGUES = [
  { key: 'blu', name: 'BLU' },
  { key: 'diablo', name: 'El Diablo' },
];
const VIEWS = ['matchup', 'standings'];
const AUTO_MS = 10 * 60e3;

const view = document.getElementById('view');
const info = document.getElementById('refreshInfo');
const btn = document.getElementById('refreshBtn');
const chip = document.getElementById('weekChip');

let state = null; // server refresh state
let skew = 0; // server clock minus ours
const data = new Map(); // league key -> data (for the current version)
const open = new Set(); // expanded matchups, kept across refreshes
let failed = null;

// Site look (theme etc.) from the main site's settings.
fetch('/api/site/meta')
  .then((r) => r.json())
  .then((m) => setDefaults(m.config ?? {}))
  .catch(() => setDefaults({}));

function route() {
  const [league, v] = location.hash.replace(/^#/, '').split('/');
  return { league: LEAGUES.some((l) => l.key === league) ? league : 'blu', view: VIEWS.includes(v) ? v : 'matchup' };
}

const clock = (ms) =>
  new Date(ms).toLocaleTimeString('en-US', { timeZone: LEAGUE_TZ, hour: 'numeric', minute: '2-digit' });
const kickoff = (iso) =>
  new Date(iso).toLocaleString('en-US', { timeZone: LEAGUE_TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// --- Tabs ---------------------------------------------------------------------

document.getElementById('leagueTabs').innerHTML = LEAGUES.map((l) => `<button data-league="${l.key}" role="tab">${esc(l.name)}</button>`).join('');
document.querySelectorAll('[data-league]').forEach((b) => b.addEventListener('click', () => (location.hash = `${b.dataset.league}/${route().view}`)));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => (location.hash = `${route().league}/${b.dataset.view}`)));
window.addEventListener('hashchange', () => render());

// --- Rendering ------------------------------------------------------------------

const avatar = (t) =>
  t.avatar ? `<img class="pj-av" src="${esc(t.avatar)}" alt="" loading="lazy" />` : `<span class="pj-av">${esc((t.name || '?').slice(0, 1))}</span>`;

const INJ = { Questionable: 'Q', Doubtful: 'D', Out: 'O', IR: 'IR', PUP: 'PUP', Sus: 'SUS', COV: 'COV', NA: 'NA' };

function gameText(p) {
  if (p.state === 'empty') return '';
  if (p.state === 'bye') return 'Bye';
  if (p.state === 'post') return 'Final';
  if (p.state === 'in') return `<span class="pj-live">${esc(p.game || 'Live')}</span>`;
  return p.kickoff ? `${kickoff(p.kickoff)} CT` : '';
}

function playerRows(t) {
  return t.starters
    .map((p) => {
      const inj = p.inj && INJ[p.inj] ? `<span class="pj-inj ${p.inj === 'Questionable' ? '' : 'bad'}" title="${esc(p.inj)}">${INJ[p.inj]}</span>` : '';
      const sub = [p.pos, p.team].filter(Boolean).join(' · ');
      const settled = p.state === 'post' || p.state === 'bye' || p.state === 'empty';
      return `<tr>
        <td class="l"><div class="pj-pn">${esc(p.name)}${inj}</div><div class="pj-ps">${esc(sub)}${sub && gameText(p) ? ' · ' : ''}${gameText(p)}</div></td>
        <td>${p.state === 'pre' || p.state === 'empty' ? '<span class="muted">–</span>' : fmt(p.pts)}</td>
        <td><b>${fmt1(p.mean)}</b></td>
        <td class="muted">${settled ? '' : `${fmt1(p.p10)}–${fmt1(p.p90)}`}</td>
      </tr>`;
    })
    .join('');
}

function teamTable(t) {
  return `<div class="pj-tt">
    <div class="pj-tth">${avatar(t)}<b>${esc(t.name)}</b></div>
    <table class="tbl pj-players"><thead><tr><th class="l">Starter</th><th>Now</th><th>Proj</th><th>Range</th></tr></thead><tbody>${playerRows(t)}</tbody></table>
  </div>`;
}

function teamLine(t, fav) {
  return `<div class="pj-team">
    ${avatar(t)}
    <div class="pj-who"><div class="pj-name">${esc(t.name)}</div><div class="pj-owner">${esc(t.owner)}${t.pts ? ` · ${fmt(t.pts)} now` : ''}</div></div>
    <div class="pj-proj"><div class="pj-mean">${fmt1(t.mean)}</div><div class="pj-range">${fmt1(t.p10)}–${fmt1(t.p90)}</div></div>
    ${t.win == null ? '' : `<div class="pj-win ${fav ? 'fav' : ''}">${pct(t.win)}</div>`}
  </div>`;
}

function matchupHtml(d) {
  if (!d.matchups.length) return `<section class="card"><p class="muted" style="margin:0">No matchups this week.</p></section>`;
  return d.matchups
    .map((m) => {
      const key = `${d.key}-${m.id}`;
      if (m.bye) {
        const [t] = m.teams;
        return `<section class="card pj-game">
          ${teamLine(t, false)}
          <p class="note">Bye week · points still count toward PF</p>
          <details data-key="${key}" ${open.has(key) ? 'open' : ''}><summary>Player projections</summary>${teamTable(t)}</details>
        </section>`;
      }
      const [a, b] = m.teams;
      const tie = a.tie >= 0.05 ? `<p class="note">Tie ${pct(a.tie)}</p>` : '';
      return `<section class="card pj-game">
        ${teamLine(a, a.win > b.win)}
        <div class="pj-bar" role="img" aria-label="${esc(a.name)} ${pct(a.win)}, ${esc(b.name)} ${pct(b.win)}"><span style="width:${a.win}%"></span></div>
        ${teamLine(b, b.win > a.win)}
        ${tie}
        <details data-key="${key}" ${open.has(key) ? 'open' : ''}><summary>Player projections</summary><div class="pj-tables">${teamTable(a)}${teamTable(b)}</div></details>
      </section>`;
    })
    .join('');
}

function standingsHtml(d) {
  const s = d.standings;
  const rows = s.rows
    .map(
      (r, i) => `<tr class="${i === s.playoffTeams ? 'cut' : ''}">
        <td class="rk">${i + 1}</td>
        <td class="tm"><div class="pj-sn">${avatar(r)}<span><b>${esc(r.name)}</b><small>${esc(r.owner)}</small></span></div></td>
        <td>${record(r)}</td>
        <td>${fmt(r.pf)}</td>
        <td class="pj-pa">${fmt(r.pa)}</td>
        <td><b>${pct(r.playoff)}</b></td>
        <td class="${r.last >= 50 ? 'bad' : ''}">${pct(r.last)}</td>
      </tr>`,
    )
    .join('');
  const through = s.through ? `Through week ${s.through}` : 'No games played yet';
  return `<section class="card flush">
    <h2 class="sec-title">Standings <span class="more" style="color:var(--muted)">${through}</span></h2>
    <div style="overflow-x:auto"><table class="tbl pj-stand"><thead><tr><th class="rk">#</th><th class="l">Team</th><th>W-L</th><th>PF</th><th class="pj-pa">PA</th><th>Playoffs</th><th>Last</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">${s.final ? 'Regular season over: these are final.' : `Top ${s.playoffTeams} make the playoffs. This week's games use the live win chances; later weeks are coin flips.`}</p>
  </section>`;
}

function render() {
  const r = route();
  document.querySelectorAll('[data-league]').forEach((b) => b.classList.toggle('on', b.dataset.league === r.league));
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === r.view));
  const d = data.get(r.league);
  const name = LEAGUES.find((l) => l.key === r.league).name;
  document.title = `${name} ${r.view === 'matchup' ? 'Matchups' : 'Standings'} · Projections`;
  if (!d) {
    chip.textContent = '';
    view.innerHTML = failed ? `<section class="card"><p style="margin:0">${esc(failed)}</p></section>` : '<section class="card"><div class="skel" style="height:120px"></div></section>';
    if (!failed) load(r.league);
    return;
  }
  chip.textContent = `${d.season} · ${d.playoffs ? 'Playoffs' : 'Week'} ${d.week}`;
  const err = d.error ? `<section class="card"><p class="bad" style="margin:0">${esc(d.error)}</p></section>` : '';
  view.innerHTML = err + (r.view === 'matchup' ? matchupHtml(d) : standingsHtml(d));
  view.querySelectorAll('details[data-key]').forEach((el) =>
    el.addEventListener('toggle', () => (el.open ? open.add(el.dataset.key) : open.delete(el.dataset.key))),
  );
}

const loading = new Map();
function load(key) {
  if (loading.has(key)) return loading.get(key);
  const p = fetch(`/api/projections/league/${key}`)
    .then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      data.set(key, body);
      failed = null;
    })
    .catch((err) => {
      failed = `Couldn't load projections: ${err.message}`;
      setTimeout(() => ((failed = null), route().league === key && render()), 5000);
    })
    .finally(() => {
      loading.delete(key);
      if (route().league === key) render();
    });
  loading.set(key, p);
  return p;
}

// --- Shared refresh -------------------------------------------------------------

function tick() {
  if (!state) return;
  const now = Date.now() + skew;
  const cooling = state.cooldownUntil > now;
  btn.disabled = state.refreshing || cooling;
  btn.textContent = state.refreshing ? 'Refreshing…' : cooling ? `Refresh in ${mmss(state.cooldownUntil - now)}` : 'Refresh';
  const updated = state.refreshedAt ? `Updated ${clock(state.refreshedAt)} CT` : 'Loading…';
  // Automatic refreshes run only on game days, from the first kickoff until every game is final.
  const auto = !state.nextAutoAt
    ? 'no more games today'
    : state.nextAutoAt - now > AUTO_MS
      ? `auto from ${kickoff(new Date(state.nextAutoAt).toISOString())} CT`
      : `auto in ${mmss(state.nextAutoAt - now)}`;
  info.textContent = `${updated} · ${auto}`;
}
setInterval(tick, 1000);

function onState(s) {
  skew = s.now - Date.now();
  const changed = !state || s.version !== state.version;
  state = s;
  tick();
  if (changed && s.version > 0) {
    data.clear();
    load(route().league);
  }
}

function connect() {
  const es = new EventSource('/api/projections/events');
  es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
  es.onerror = () => {
    info.textContent = 'Reconnecting…';
  };
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    const res = await fetch('/api/projections/refresh', { method: 'POST' });
    onState(await res.json());
  } catch {
    tick();
  }
});

render();
connect();
