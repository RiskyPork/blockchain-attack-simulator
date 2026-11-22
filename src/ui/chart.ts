/**
 * A small SVG line-and-point chart for the Experiments tab: theory curves as
 * lines, simulated results as dots with 95% error bars, one shared y-axis.
 * chartSvg is pure (spec in, markup out) so it is unit-tested; attachTooltips
 * adds the hover and keyboard layer to a rendered chart.
 */
import { esc } from './format';

export interface ChartPoint {
  x: number;
  y: number;
  /** Error bar, if any. */
  low?: number;
  high?: number;
  /** Tooltip text. */
  tip: string;
}

export interface ChartSeries {
  /** Legend text, e.g. "z = 3". */
  name: string;
  /** Any CSS colour; the panels pass custom properties so dark mode gets its own steps. */
  color: string;
  /** Solid curve. */
  line?: [number, number][];
  /** Second, dashed curve in the same colour (e.g. an older formula to compare with). */
  dashed?: [number, number][];
  points?: ChartPoint[];
}

export interface Axis {
  label: string;
  min: number;
  max: number;
  ticks: number[];
  format: (v: number) => string;
}

/** A ringed spot on the plot, e.g. where a curve crosses a reference line. Its label shows on hover; say what it means in the legend. */
export interface Annotation {
  x: number;
  y: number;
  label: string;
  color: string;
}

export interface ChartSpec {
  /** Accessible name for the whole chart. */
  title: string;
  x: Axis;
  y: Axis;
  series: ChartSeries[];
  /** A neutral reference line drawn under the series, named in the legend. */
  reference?: { line: [number, number][]; label: string };
  annotations?: Annotation[];
}

const W = 640;
const H = 360;
const M = { top: 14, right: 18, bottom: 46, left: 54 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;
/** Hover target radius: bigger than the 4 px dot, so it is easy to hit. */
const HIT_R = 10;
/**
 * Series measured at the same x are nudged apart sideways by this many pixels
 * each, so their dots and error bars don't hide each other. The curves stay
 * put; the tooltip gives the exact x.
 */
const DODGE = 4;

let clipIds = 0;

export function chartSvg(spec: ChartSpec): string {
  const { x, y } = spec;
  const sx = (v: number) => M.left + ((v - x.min) / (x.max - x.min)) * PW;
  const sy = (v: number) => M.top + PH - ((clamp(v, y.min, y.max) - y.min) / (y.max - y.min)) * PH;
  const path = (pts: [number, number][]) =>
    pts.length ? `M${pts.map(([a, b]) => `${sx(a).toFixed(1)},${sy(b).toFixed(1)}`).join('L')}` : '';
  const clip = `chart-clip-${++clipIds}`;

  const grid = y.ticks
    .map((t) => `<line class="grid" x1="${M.left}" x2="${M.left + PW}" y1="${sy(t)}" y2="${sy(t)}"/>
      <text class="tick" x="${M.left - 8}" y="${sy(t)}" text-anchor="end" dominant-baseline="middle">${esc(y.format(t))}</text>`)
    .join('');
  const xTicks = x.ticks
    .map((t) => `<line class="axis" x1="${sx(t)}" x2="${sx(t)}" y1="${M.top + PH}" y2="${M.top + PH + 4}"/>
      <text class="tick" x="${sx(t)}" y="${M.top + PH + 18}" text-anchor="middle">${esc(x.format(t))}</text>`)
    .join('');

  // Named in the legend rather than on the plot, where a label would sit on the curves.
  const ref = spec.reference?.line.length ? `<path class="ref" d="${path(spec.reference.line)}"/>` : '';

  const curves = spec.series
    .map((s) => {
      const solid = s.line ? `<path class="curve" d="${path(s.line)}" style="stroke:${s.color}"/>` : '';
      const dashed = s.dashed ? `<path class="curve dashed" d="${path(s.dashed)}" style="stroke:${s.color}"/>` : '';
      return dashed + solid;
    })
    .join('');

  const withPoints = spec.series.filter((s) => s.points?.length);
  const dots = withPoints
    .map((s, i) =>
      (s.points ?? [])
        .map((p) => {
          const cx = (sx(p.x) + (i - (withPoints.length - 1) / 2) * DODGE).toFixed(1);
          const bar =
            p.low !== undefined && p.high !== undefined && p.high > p.low
              ? `<path class="whisker" d="M${cx},${sy(p.low).toFixed(1)}V${sy(p.high).toFixed(1)}" style="stroke:${s.color}"/>`
              : '';
          return `<g class="pt" tabindex="0" role="img" aria-label="${esc(p.tip)}" data-tip="${esc(p.tip)}">
            ${bar}<circle class="dot" cx="${cx}" cy="${sy(p.y).toFixed(1)}" r="4" style="fill:${s.color}"/>
            <circle class="hit" cx="${cx}" cy="${sy(p.y).toFixed(1)}" r="${HIT_R}"/></g>`;
        })
        .join(''),
    )
    .join('');

  const notes = (spec.annotations ?? [])
    .map((a) => `<circle class="note-dot" cx="${sx(a.x)}" cy="${sy(a.y)}" r="5" style="stroke:${a.color}"><title>${esc(a.label)}</title></circle>`)
    .join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(spec.title)}">
    <defs><clipPath id="${clip}"><rect x="${M.left}" y="${M.top - 6}" width="${PW + 6}" height="${PH + 12}"/></clipPath></defs>
    ${grid}
    <line class="axis" x1="${M.left}" x2="${M.left + PW}" y1="${M.top + PH}" y2="${M.top + PH}"/>
    ${xTicks}
    <text class="axis-label" x="${M.left + PW / 2}" y="${H - 6}" text-anchor="middle">${esc(x.label)}</text>
    <text class="axis-label" transform="translate(14 ${M.top + PH / 2}) rotate(-90)" text-anchor="middle">${esc(y.label)}</text>
    <g clip-path="url(#${clip})">${ref}${curves}${notes}${dots}</g>
  </svg>`;
}

/** Legend keys: a short line for the curve and a dot for the simulated points, then the series name. */
export function legendHtml(spec: Pick<ChartSpec, 'series' | 'reference'>): string {
  const items = spec.series.map(
    (s) => `<li><svg width="26" height="12" aria-hidden="true"><line x1="1" x2="25" y1="6" y2="6" style="stroke:${s.color}"/>
      <circle cx="13" cy="6" r="4" style="fill:${s.color}"/></svg>${esc(s.name)}</li>`,
  );
  if (spec.reference) {
    items.push(`<li><svg width="26" height="12" aria-hidden="true"><line class="ref-key" x1="1" x2="25" y1="6" y2="6"/></svg>${esc(spec.reference.label)}</li>`);
  }
  return `<ul class="legend">${items.join('')}</ul>`;
}

/**
 * Show a point's `data-tip` in a floating box while it is hovered or has
 * keyboard focus. Safe to call once per container: it listens on the
 * container, so charts redrawn inside it keep working.
 */
export function attachTooltips(container: HTMLElement): void {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.style.position = 'relative';
  container.append(tip);

  const show = (target: EventTarget | null) => {
    const pt = target instanceof Element ? target.closest<SVGGElement>('.pt') : null;
    if (!pt || !container.contains(pt)) {
      tip.hidden = true;
      return;
    }
    tip.textContent = pt.dataset.tip ?? '';
    tip.hidden = false;
    const box = container.getBoundingClientRect();
    const dot = pt.querySelector('.dot')!.getBoundingClientRect();
    const left = dot.left + dot.width / 2 - box.left;
    tip.style.left = `${Math.min(Math.max(left, 90), box.width - 90)}px`;
    tip.style.top = `${dot.top - box.top - 8}px`;
  };
  container.addEventListener('pointerover', (e) => show(e.target));
  container.addEventListener('pointerleave', () => (tip.hidden = true));
  container.addEventListener('focusin', (e) => show(e.target));
  container.addEventListener('focusout', () => (tip.hidden = true));
}

/** `count` evenly spaced values from `from` to `to`, for drawing a smooth curve. */
export function samples(from: number, to: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
