// Small shared helpers for the pages.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmt1 = (n) => fmt(n, 1);
export const int = (n) => fmt(n, 0);

/** Odds as a percentage: "<0.1%" and ">99.9%" instead of rounding to 0 or 100 when it isn't certain. */
export function pct(v) {
  if (v == null) return '–';
  if (v >= 100) return '100%';
  if (v <= 0) return '0%';
  if (v < 0.1) return '<0.1%';
  if (v > 99.9) return '>99.9%';
  return `${v < 10 ? v.toFixed(1) : Math.round(v * 10) / 10}%`;
}

export const record = (r) => `${r.w}-${r.l}${r.t ? `-${r.t}` : ''}`;

let TEAMS = new Map();
export function setTeams(list) {
  TEAMS = new Map(list.map((t) => [t.id, t]));
}
export const teamOf = (id) => TEAMS.get(id) ?? { id, name: 'BYE', slug: 'bye', color: 0 };
export const teamColor = (id) => {
  const c = teamOf(id).color;
  return c ? `var(--c${c})` : 'var(--muted)';
};

/** Team name with its color dot. */
export function team(id, { link = true } = {}) {
  const t = teamOf(id);
  const inner = `<span class="dot" style="--tc:${teamColor(id)}"></span><span class="nm">${esc(t.name)}</span>`;
  return link && t.color ? `<a class="team" href="#teams/${esc(t.slug)}" style="text-decoration:none">${inner}</a>` : `<span class="team">${inner}</span>`;
}

export const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

/** Live countdown: "1d 12h 04m" a day or more out, "11h 04m 32s" inside a day. `done` once it has passed. */
export function countdown(iso, done = 'Now') {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return done;
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
  const two = (n) => String(n).padStart(2, '0');
  return d ? `${d}d ${h}h ${two(m)}m` : h ? `${h}h ${two(m)}m ${two(s)}s` : `${m}m ${two(s)}s`;
}

// League times are shown in Central, whatever the viewer's own time zone.
export const LEAGUE_TZ = 'America/Chicago';
export const when = (iso) =>
  `${new Date(iso).toLocaleString('en-US', { timeZone: LEAGUE_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} CT`;

export const card = (title, body, { cls = '', more = '' } = {}) =>
  `<section class="card rv ${cls}">${title ? `<h2 class="sec-title">${esc(title)}${more}</h2>` : ''}${body}</section>`;

export const signed = (n, d = 1) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(d)}`;
