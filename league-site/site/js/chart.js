// Line chart for odds over time: one 2px line per team, direct labels at the
// right end, a legend that focuses a team, and a crosshair tooltip.
import { esc, pct } from './ui.js';

const W = 600, H = 250;
const M = { l: 36, r: 74, t: 10, b: 26 };

export function lineChart(el, { weeks, series }) {
  if (!weeks.length) {
    el.innerHTML = '<p class="muted">Odds history starts after Week 1.</p>';
    return;
  }
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const x = (i) => M.l + (weeks.length === 1 ? iw / 2 : (i / (weeks.length - 1)) * iw);
  const y = (v) => M.t + ih - (v / 100) * ih;

  const grid = [0, 25, 50, 75, 100]
    .map((v) => `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/>`)
    .join('');
  const yAxis = [0, 25, 50, 75, 100].map((v) => `<text x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join('');
  const step = Math.ceil(weeks.length / 8);
  const xAxis = weeks.map((w, i) => (i % step === 0 || i === weeks.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">W${w}</text>` : '')).join('');

  const lines = series
    .map((s) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const end = `<circle cx="${x(s.values.length - 1)}" cy="${y(s.values.at(-1))}" r="4" style="fill:${s.color};stroke:var(--card);stroke-width:2"/>`;
      return `<g class="series" data-id="${esc(s.id)}"><path d="${d}" style="stroke:${s.color}"/>${end}</g>`;
    })
    .join('');

  // End labels, nudged apart so they never overlap (min 13px between centers).
  const ends = series.map((s) => ({ s, y: y(s.values.at(-1)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
  const overflow = ends.length ? ends.at(-1).y - (H - M.b) : 0;
  if (overflow > 0) for (const e of ends) e.y -= overflow;
  for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - 13);
  const labels = ends.map((e) => `<text x="${W - M.r + 10}" y="${e.y + 4}" data-id="${esc(e.s.id)}">${esc(e.s.name)}</text>`).join('');

  el.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Playoff odds by week for each team">
        <g class="grid">${grid}</g>
        <g class="axis">${yAxis}${xAxis}</g>
        ${lines}
        <g class="lbl">${labels}</g>
        <line class="cross" y1="${M.t}" y2="${H - M.b}" hidden/>
        <g class="hover-dots"></g>
        <rect class="hit" x="${M.l - 10}" y="0" width="${iw + 20}" height="${H}" fill="transparent"/>
      </svg>
      <div class="tip" hidden></div>
    </div>
    <div class="legend">${series.map((s) => `<button data-id="${esc(s.id)}"><span class="dot" style="--tc:${s.color}"></span>${esc(s.name)}</button>`).join('')}</div>`;

  const svg = el.querySelector('svg');
  const tip = el.querySelector('.tip');
  const cross = el.querySelector('.cross');
  const dots = el.querySelector('.hover-dots');
  let focus = null;

  const setFocus = (id) => {
    focus = focus === id ? null : id;
    el.querySelectorAll('.series').forEach((g) => g.classList.toggle('dim', !!focus && g.dataset.id !== focus));
    el.querySelectorAll('.legend button').forEach((b) => b.classList.toggle('off', !!focus && b.dataset.id !== focus));
  };
  el.querySelector('.legend').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setFocus(b.dataset.id);
  });

  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('hidden', '');
    dots.innerHTML = '';
  };
  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    let i = weeks.length === 1 ? 0 : Math.round(((sx - M.l) / iw) * (weeks.length - 1));
    i = Math.max(0, Math.min(weeks.length - 1, i));
    cross.removeAttribute('hidden');
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dots.innerHTML = series.map((s) => `<circle cx="${x(i)}" cy="${y(s.values[i])}" r="4" style="fill:${s.color};stroke:var(--card);stroke-width:2"/>`).join('');
    const rows = [...series].sort((a, b) => b.values[i] - a.values[i]);
    tip.innerHTML = `<b>After Week ${weeks[i]}</b>${rows.map((s) => `<div><span class="dot" style="--tc:${s.color}"></span><span>${esc(s.name)}</span><span>${pct(s.values[i])}</span></div>`).join('')}`;
    tip.hidden = false;
    const px = (x(i) / W) * box.width;
    const wrap = el.querySelector('.chart').getBoundingClientRect().width;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(wrap - tw, px + 12 + tw > wrap ? px - tw - 12 : px + 12))}px`;
    tip.style.top = '8px';
  };
  const hit = el.querySelector('.hit');
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}
