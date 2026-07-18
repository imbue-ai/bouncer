// Shared DOM render helpers for the usage stats — the SVG donut + legend used
// by the full stats dashboard (stats.html). Kept out of popup/stats controllers
// so both can share one implementation. Uses createElementNS for the SVG so no
// HTML sanitizer can strip path geometry; legend HTML goes through parseHTML.

import { escapeHtml, parseHTML } from './utils';

// Distinct, theme-neutral hues for pie slices / legend swatches. The last entry
// is reused for the "Other" overflow slice.
export const STATS_PALETTE = [
  '#1d9bf0', '#f4212e', '#00ba7c', '#ffd400', '#7856ff',
  '#ff7a00', '#f91880', '#536471',
];

export const PIE_MAX_SLICES = 6;

export interface PieSlice { label: string; value: number; color: string }

// Collapse rows into at most PIE_MAX_SLICES value-weighted slices, folding the
// tail into one "Other" slice. `value` picks time or count per pie.
export function pieSlices<T extends { category: string }>(rows: T[], value: (r: T) => number): PieSlice[] {
  const positive = rows.map((r) => ({ label: r.category, value: value(r) })).filter((s) => s.value > 0);
  if (positive.length <= PIE_MAX_SLICES) {
    return positive.map((s, i) => ({ ...s, color: STATS_PALETTE[i % STATS_PALETTE.length] }));
  }
  const head = positive.slice(0, PIE_MAX_SLICES - 1);
  const tail = positive.slice(PIE_MAX_SLICES - 1);
  const slices = head.map((s, i) => ({ ...s, color: STATS_PALETTE[i % STATS_PALETTE.length] }));
  slices.push({ label: `Other (${tail.length})`, value: tail.reduce((a, s) => a + s.value, 0), color: STATS_PALETTE[STATS_PALETTE.length - 1] });
  return slices;
}

// Build an SVG donut from value-weighted slices.
export function buildPieSvg(slices: PieSlice[]): SVGSVGElement {
  const SIZE = 120, R = 54, C = 60, STROKE = 16;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.classList.add('stats-pie-svg');

  const total = slices.reduce((acc, s) => acc + s.value, 0);
  if (total <= 0) return svg;

  const circ = 2 * Math.PI * R;
  let offset = 0;
  for (const slice of slices) {
    const frac = slice.value / total;
    const seg = document.createElementNS(ns, 'circle');
    seg.setAttribute('cx', String(C));
    seg.setAttribute('cy', String(C));
    seg.setAttribute('r', String(R));
    seg.setAttribute('fill', 'none');
    seg.setAttribute('stroke', slice.color);
    seg.setAttribute('stroke-width', String(STROKE));
    seg.setAttribute('stroke-dasharray', `${frac * circ} ${circ}`);
    seg.setAttribute('stroke-dashoffset', String(-offset));
    seg.setAttribute('transform', `rotate(-90 ${C} ${C})`);
    svg.appendChild(seg);
    offset += frac * circ;
  }
  return svg;
}

// Render a pie + legend into the given containers. `format` renders each row's
// value for the legend (duration for time pies, count for the blocked pie).
export function renderPie(pieEl: HTMLElement, legendEl: HTMLElement, slices: PieSlice[], format: (v: number) => string): void {
  pieEl.replaceChildren(buildPieSvg(slices));
  const total = slices.reduce((acc, s) => acc + s.value, 0) || 1;
  const html = slices
    .map((s) => {
      const pct = Math.round((s.value / total) * 100);
      return `
        <div class="stats-legend-row">
          <span class="stats-legend-swatch" style="background:${escapeHtml(s.color)}"></span>
          <span class="stats-legend-name">${escapeHtml(s.label)}</span>
          <span class="stats-legend-value">${escapeHtml(format(s.value))} · ${pct}%</span>
        </div>`;
    })
    .join('');
  legendEl.replaceChildren(parseHTML(html));
}
