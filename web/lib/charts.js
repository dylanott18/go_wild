// Tiny dependency-free SVG charts: a single-series line chart with a
// crosshair + tooltip, and a sparkline. One series per chart, one y-axis.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function niceStep(raw, integer) {
  if (integer) return Math.max(1, Math.ceil(raw));
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/**
 * @param {{x:number,y:number|null,label?:string}[]} points  x ascending (ms or index)
 * @param {{xFmt:(x)=>string, yFmt:(y)=>string, step?:boolean, height?:number, title:string}} opt
 */
export function lineChart(points, opt) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', opt.title);
  const W = 640;
  const H = opt.height ?? 180;
  const pad = { l: 44, r: 12, t: 10, b: 24 };
  const vals = points.filter((p) => p.y != null);
  if (!vals.length) {
    wrap.innerHTML = '<p class="muted">No data points yet.</p>';
    return wrap;
  }
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yStep = niceStep(Math.max(...vals.map((p) => p.y)) / 4, opt.integer);
  const yMax = yStep * 4;
  const sx = (x) => pad.l + (x1 === x0 ? (W - pad.l - pad.r) / 2 : ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r));
  const sy = (y) => pad.t + (1 - y / yMax) * (H - pad.t - pad.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });

  for (let i = 0; i <= 4; i++) {
    const v = yStep * i;
    const y = sy(v);
    svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid-line' }));
    const t = el('text', { x: pad.l - 6, y: y + 4, 'text-anchor': 'end', class: 'axis-label' });
    t.textContent = opt.yFmt(v);
    svg.append(t);
  }
  const n = points.length;
  const tickIdx = [...new Set(Array.from({ length: Math.min(4, n) }, (_, i) => Math.round((i / Math.max(1, Math.min(4, n) - 1)) * (n - 1))))];
  tickIdx.forEach((idx, i) => {
    const p = points[idx];
    const anchor = tickIdx.length === 1 ? 'middle' : i === 0 ? 'start' : i === tickIdx.length - 1 ? 'end' : 'middle';
    const t = el('text', { x: sx(p.x), y: H - 6, 'text-anchor': anchor, class: 'axis-label' });
    t.textContent = opt.xFmt(p.x);
    svg.append(t);
  });

  // Path with gaps where y is null; optional step interpolation (seat counts).
  let d = '';
  let prev = null;
  for (const p of points) {
    if (p.y == null) { prev = null; continue; }
    const X = sx(p.x);
    const Y = sy(p.y);
    if (!prev) d += `M${X},${Y}`;
    else d += opt.step ? `H${X}V${Y}` : `L${X},${Y}`;
    prev = p;
  }
  svg.append(el('path', { d, class: 'line', 'vector-effect': 'non-scaling-stroke' }));
  if (vals.length <= 40) {
    for (const p of vals) svg.append(el('circle', { cx: sx(p.x), cy: sy(p.y), r: 3.5, class: 'pt', 'vector-effect': 'non-scaling-stroke' }));
  }

  const cross = el('line', { y1: pad.t, y2: H - pad.b, class: 'cross', visibility: 'hidden' });
  const hot = el('circle', { r: 5, class: 'pt', visibility: 'hidden' });
  svg.append(cross, hot);
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  wrap.append(svg, tip);

  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best = vals[0];
    for (const p of vals) if (Math.abs(sx(p.x) - px) < Math.abs(sx(best.x) - px)) best = p;
    const X = sx(best.x);
    const Y = sy(best.y);
    cross.setAttribute('x1', X); cross.setAttribute('x2', X); cross.setAttribute('visibility', 'visible');
    hot.setAttribute('cx', X); hot.setAttribute('cy', Y); hot.setAttribute('visibility', 'visible');
    tip.style.display = 'block';
    tip.style.left = `${(X / W) * r.width}px`;
    tip.style.top = `${(Y / H) * r.height}px`;
    tip.textContent = `${best.label ?? opt.xFmt(best.x)}: ${opt.yFmt(best.y)}`;
  };
  const leave = () => { cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
  return wrap;
}

/** Inline sparkline of GoWild seats over time (history `h`). Returns SVG markup. */
export function sparkline(h, w = 64, hgt = 18) {
  const pts = (h ?? []).map((p) => (p[1] == null ? 0 : p[2] ?? 9));
  if (pts.length < 2) return '';
  const max = Math.max(1, ...pts);
  const step = w / (pts.length - 1);
  let d = '';
  pts.forEach((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (hgt - 2 - (v / max) * (hgt - 4)).toFixed(1);
    d += i ? `H${x}V${y}` : `M${x},${y}`;
  });
  const label = `Seats trend: ${pts.join(' → ')}`;
  return `<svg class="spark" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" role="img" aria-label="${label}"><title>${label}</title><path d="${d}"/></svg>`;
}
