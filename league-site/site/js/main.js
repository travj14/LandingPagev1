import { getJSON, load } from './api.js';
import { initSettingsSheet, onChange, revealIn, setDefaults } from './settings.js';
import { parseHash, ROUTES } from './router.js';
import { esc, setTeams } from './ui.js';
import * as home from './pages/home.js';
import * as standings from './pages/standings.js';
import * as historyPage from './pages/history.js';
import * as matchups from './pages/matchups.js';
import * as teams from './pages/teams.js';

const PAGES = { home, standings, matchups, teams, history: historyPage };
const TAB_TITLES = { home: 'Home', standings: 'Standings', matchups: 'Matchups', teams: 'Teams', history: 'History' };
const HISTORY_TITLES = { records: 'Record book', seasons: 'Seasons', shame: 'Hall of Shame', more: 'More' };

const view = document.getElementById('view');
let meta = null;
let current = null; // { name, key, page, cleanup }

const skeleton = () =>
  `<div class="skel span2" aria-busy="true" aria-label="Loading">${'<div class="skel-card"><i></i><i></i><i></i></div>'.repeat(3)}</div>`;

function errorCard(err) {
  const missing = err.status === 404;
  const title = missing ? "That page doesn't exist" : err.offline ? "You're offline" : "Couldn't load this page";
  const text = missing ? 'The link may be old or mistyped.' : err.offline ? "This page hasn't been saved on this device yet." : esc(err.message);
  return `<section class="card error-card span2" role="alert"><h2>${title}</h2><p>${text}</p><div class="error-actions">${missing ? '' : '<button class="btn" data-retry>Try again</button>'}<a class="btn ghost" href="#home">Home</a></div></section>`;
}

const slugName = (slug) => meta?.teams.find((t) => t.slug === slug)?.name;

/** Browser-tab title for a route, e.g. "Josh vs Henry · Rivalry". */
function titleFor({ name, args }) {
  const site = meta?.config.siteTitle || meta?.league || 'League';
  let page = TAB_TITLES[name];
  if (name === 'teams' && args[0]) page = slugName(args[0]) ?? page;
  if (name === 'matchups' && args[0] === 'rivalry') page = `${slugName(args[1]) ?? '?'} vs ${slugName(args[2]) ?? '?'} · Rivalry`;
  else if (name === 'matchups' && args[1]) page = `${args[0]} Week ${args[1]} · Matchups`;
  if (name === 'history' && args[0]) page = `${HISTORY_TITLES[args[0]] ?? 'History'} · History`;
  return name === 'home' ? site : `${page} · ${site}`;
}

async function route() {
  if (!meta) return;
  const r = parseHash();
  current?.cleanup?.();
  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('on', a.dataset.tab === r.name);
    if (a.dataset.tab === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = titleFor(r);
  const page = PAGES[r.name];
  const key = [r.name, ...r.args].join('/');
  const changed = current?.key !== key;
  const mine = (current = { name: r.name, key, page, cleanup: null });
  if (changed) {
    view.innerHTML = skeleton();
    window.scrollTo(0, 0);
  }
  try {
    mine.cleanup = (await page.render(view, { meta, ...r, rerender: () => revealIn(view) })) || null;
  } catch (err) {
    if (err.status !== 404) console.error(err);
    if (current !== mine) return; // the user already moved on
    view.innerHTML = errorCard(err);
  }
  revealIn(view);
  refreshMeta();
}

// ---------------------------------------------------------------------------
// Footer: when the data was last pulled and when the full history last refreshed.

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
};
const clock = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function drawFooter() {
  if (!meta) return;
  const parts = [`Scores from Sleeper, updated ${ago(meta.dataAsOf)}`];
  if (meta.refreshing) parts.push('Full history refresh running…');
  else if (meta.refreshedAt) parts.push(`Full history refreshed ${clock(meta.refreshedAt)}`);
  parts.push('History refreshes nightly at midnight ET');
  document.getElementById('siteFoot').innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('');
}

let metaAt = 0;
async function refreshMeta() {
  if (Date.now() - metaAt < 60e3) return drawFooter();
  metaAt = Date.now();
  try {
    meta = { ...meta, ...(await getJSON('/api/site/meta')) };
  } catch {}
  drawFooter();
}

// ---------------------------------------------------------------------------

async function start() {
  initSettingsSheet();
  try {
    await load('/api/site/meta', (m) => {
      const first = !meta;
      meta = m;
      metaAt = Date.now();
      setTeams(m.teams);
      setDefaults(m.config);
      document.getElementById('brand').textContent = m.config.siteTitle || m.league;
      const wk = m.status === 'complete' ? `${m.season} · Final` : m.currentWeek ? `${m.season} · Week ${m.currentWeek}` : `${m.season} · Preseason`;
      document.getElementById('weekChip').textContent = wk;
      drawFooter();
      if (first) route();
    });
  } catch (err) {
    view.innerHTML = errorCard(err);
    view.querySelector('[data-retry]')?.addEventListener('click', start, { once: true });
  }
}

view.addEventListener('click', (e) => {
  if (e.target.closest('[data-retry]') && meta) route();
});

// Offline banner: shown while requests fail and saved copies are on screen.
const bar = document.getElementById('offlineBar');
window.addEventListener('blu:net', (e) => (bar.hidden = e.detail.online));
window.addEventListener('offline', () => (bar.hidden = false));
window.addEventListener('online', () => {
  bar.hidden = true;
  if (meta) route();
});
setInterval(() => document.visibilityState === 'visible' && drawFooter(), 60e3);

// Keyboard shortcuts (desktop): 1-5 switch tabs, ←/→ step through weeks, / jumps to record search.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
  if (!document.getElementById('settingsSheet').hidden) return;
  const n = Number(e.key);
  if (n >= 1 && n <= ROUTES.length) {
    location.hash = `#${ROUTES[n - 1]}`;
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && current?.name === 'matchups') {
    const on = view.querySelector('.wk.on');
    const next = e.key === 'ArrowLeft' ? on?.previousElementSibling : on?.nextElementSibling;
    if (!next) return;
    e.preventDefault();
    location.hash = next.getAttribute('href');
  } else if (e.key === '/') {
    e.preventDefault();
    const box = view.querySelector('.search');
    if (box) box.focus();
    else {
      location.hash = '#history/records';
      const wait = setInterval(() => {
        const b = view.querySelector('.search');
        if (b) clearInterval(wait), b.focus();
      }, 100);
      setTimeout(() => clearInterval(wait), 5000);
    }
  }
});

window.addEventListener('hashchange', route);
// Model changes re-render the current page; look changes apply through CSS.
onChange((key) => key === 'model' && route());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err));
}

start();
