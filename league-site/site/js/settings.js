// Look-and-feel settings. Site defaults come from data/site.config.json (via /api/site/meta);
// each viewer can override them on their own device (localStorage).
import { smoothScroll } from './scroll.js';

export const THEMES = {
  Midnight: { bg: '#0b1020', bg2: '#1b2a55', card: '#141b31', text: '#f3f5fb', muted: '#93a0bf', accent: '#f5b83d', accent2: '#4fd1c5', good: '#4ade80', bad: '#f87171' },
  Gridiron: { bg: '#0d1a12', bg2: '#1f4d2e', card: '#13261a', text: '#f1f7f2', muted: '#9bb5a3', accent: '#e9f26b', accent2: '#ffffff', good: '#7ee081', bad: '#ff8a7a' },
  Crimson: { bg: '#170b0f', bg2: '#5a1426', card: '#24121a', text: '#fbf3f5', muted: '#c19aa6', accent: '#ff4d6d', accent2: '#ffd166', good: '#7ae582', bad: '#ff6b6b' },
  Sleeper: { bg: '#181c28', bg2: '#232a3d', card: '#232a3d', text: '#ffffff', muted: '#9aa3b8', accent: '#00ceb8', accent2: '#ff9f43', good: '#00ceb8', bad: '#ff5c7c' },
  Paper: { bg: '#f4f1ea', bg2: '#e4dccb', card: '#ffffff', text: '#1d1c1a', muted: '#6f6a60', accent: '#c2410c', accent2: '#1d4ed8', good: '#15803d', bad: '#b91c1c', light: true },
};

// Team colors: one fixed hue per owner, stepped for dark and light surfaces (validated palette).
const TEAM_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const TEAM_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const KEY = 'blu-site-settings';
const LOOK = ['theme', 'apple', 'smoothScroll', 'glide', 'reveal', 'model'];

let defaults = { theme: 'Midnight', apple: true, smoothScroll: false, glide: 0.45, reveal: true, model: 'coin' };
let mine = {};
try {
  mine = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
} catch {
  mine = {};
}

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);

export function setDefaults(cfg) {
  defaults = { ...defaults, ...Object.fromEntries(LOOK.filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]])) };
  apply();
}

export const settings = () => ({ ...defaults, ...mine });

export function set(key, value) {
  const before = settings()[key];
  if (value === defaults[key]) delete mine[key];
  else mine[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(mine));
  } catch {
    // Private mode or storage blocked: the setting still applies for this visit.
  }
  apply();
  if (before !== value) listeners.forEach((fn) => fn(key, value));
}

export function reset() {
  const before = settings();
  mine = {};
  try {
    localStorage.removeItem(KEY);
  } catch {}
  apply();
  for (const k of LOOK) if (before[k] !== settings()[k]) listeners.forEach((fn) => fn(k, settings()[k]));
}

let scroller = null;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function apply() {
  const s = settings();
  const t = THEMES[s.theme] ?? THEMES.Midnight;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t)) if (k !== 'light') root.style.setProperty(`--${k}`, v);
  (t.light ? TEAM_LIGHT : TEAM_DARK).forEach((c, i) => root.style.setProperty(`--c${i + 1}`, c));
  root.classList.toggle('light', !!t.light);
  root.classList.toggle('apple', !!s.apple);
  root.classList.toggle('reveal', !!s.reveal && !reduceMotion());
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
  // Smooth scroll off = plain native scrolling; the glide script isn't attached until it's turned on.
  const amount = s.smoothScroll ? Number(s.glide) || 0 : 0;
  if (amount > 0 && !scroller) scroller = smoothScroll(null, amount);
  else scroller?.set(amount);
}

/** Fade sections in as they scroll into view (only those starting below the fold). */
let io = null;
export function revealIn(root) {
  if (!settings().reveal || reduceMotion() || !('IntersectionObserver' in window)) {
    root.querySelectorAll('.rv').forEach((el) => el.classList.add('in'));
    return;
  }
  io ??= new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
    { rootMargin: '0px 0px -6% 0px' },
  );
  root.querySelectorAll('.rv:not(.in)').forEach((el) => {
    if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in');
    else io.observe(el);
  });
}

// ---------------------------------------------------------------------------
// Settings sheet

const sheet = () => document.getElementById('settingsSheet');
const backdrop = () => document.getElementById('sheetBackdrop');

function sheetHtml() {
  const s = settings();
  const sw = (key, label, hint) => `
    <div class="set-row">
      <label for="set-${key}">${label}${hint ? `<small>${hint}</small>` : ''}</label>
      <span class="switch"><input type="checkbox" id="set-${key}" data-key="${key}" ${s[key] ? 'checked' : ''}><span></span></span>
    </div>`;
  return `
    <div class="set-row">
      <label for="set-theme">Theme</label>
      <select id="set-theme" data-key="theme">${Object.keys(THEMES).map((n) => `<option ${n === s.theme ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="set-row">
      <label>Odds model<small>Coin flip: every game 50/50. Last 8: scores drawn from each team's last 8 games.</small></label>
      <span class="seg" role="group" aria-label="Odds model">
        <button data-model="coin" class="${s.model === 'coin' ? 'on' : ''}">Coin flip</button>
        <button data-model="sample" class="${s.model === 'sample' ? 'on' : ''}">Last 8</button>
      </span>
    </div>
    ${sw('apple', 'Apple style', 'Frosted glass, rounder shapes, springy taps')}
    ${sw('smoothScroll', 'Smooth scroll', 'Momentum glide on wheel and swipe')}
    <div class="set-row" ${s.smoothScroll ? '' : 'hidden'} id="glideRow">
      <label for="set-glide">Glide</label>
      <input type="range" id="set-glide" data-key="glide" min="0.05" max="1" step="0.05" value="${s.glide}">
    </div>
    ${sw('reveal', 'Fade in on scroll', 'Sections ease in as you reach them')}
    <div class="set-row"><span class="muted" style="font-size:12px">Saved on this device only.</span><button class="btn" id="resetSettings">Reset</button></div>`;
}

export function openSettings() {
  const body = document.getElementById('settingsBody');
  body.innerHTML = sheetHtml();
  sheet().hidden = false;
  backdrop().hidden = false;
  document.getElementById('closeSettings').focus();
}

export function closeSettings() {
  sheet().hidden = true;
  backdrop().hidden = true;
  document.getElementById('openSettings').focus();
}

export function initSettingsSheet() {
  document.getElementById('openSettings').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  backdrop().addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !sheet().hidden && closeSettings());
  const body = document.getElementById('settingsBody');
  body.addEventListener('change', (e) => {
    const el = e.target.closest('[data-key]');
    if (!el) return;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    set(el.dataset.key, v);
    if (el.dataset.key === 'smoothScroll') document.getElementById('glideRow').hidden = !v;
  });
  body.addEventListener('input', (e) => e.target.type === 'range' && set(e.target.dataset.key, Number(e.target.value)));
  body.addEventListener('click', (e) => {
    const m = e.target.closest('[data-model]');
    if (m) {
      set('model', m.dataset.model);
      body.querySelectorAll('[data-model]').forEach((b) => b.classList.toggle('on', b === m));
    }
    if (e.target.id === 'resetSettings') {
      reset();
      body.innerHTML = sheetHtml();
    }
  });
}
