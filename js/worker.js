// Tile and hit-test worker. Messages:
//   {type: 'tile', key, z, i, j, dpr, settings}  ->  {type: 'tile', key, pixels, stats}
//   {type: 'query', id, x, y, z, dpr, settings, pickCss}  ->  {type: 'query', id, hit}
//   {type: 'dots', id, x0, x1, y0, y1, z, dpr, settings, minCss, max}  ->  {type: 'dots', id, z, dots}
import { renderTile, collect, makeConfig, radiusCss, S0_CSS } from './core.js';

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'tile') {
    const { pixels, stats } = renderTile(m.settings, m.z, m.i, m.j, m.dpr);
    self.postMessage({ type: 'tile', key: m.key, pixels, stats }, [pixels.buffer]);
  } else if (m.type === 'query') {
    self.postMessage({ type: 'query', id: m.id, hit: query(m) });
  } else if (m.type === 'dots') {
    self.postMessage({ type: 'dots', id: m.id, z: m.z, dots: dotsIn(m) });
  }
};

// Every dot drawn inside a rectangle at zoom level z (biggest first, at most max),
// for the sound player.
function dotsIn({ x0, x1, y0, y1, z, dpr, settings, minCss, max }) {
  const cfg = makeConfig(settings, S0_CSS * Math.pow(2, z), dpr);
  const ctx = { nodes: 0, nodeBudget: cfg.nodeBudget, aborted: false, cands: 0, rootCalls: 0, lattice: 0, direct: 0 };
  const out = [];
  collect({ x0, x1, y0, y1 }, cfg, () => 0, (x, y, L, d, a, cls) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return;
    if (cfg.colorMode === 'lead' && !cfg.highLead && a[d] >= 5) return;
    const r = radiusCss(cfg, L, d, cls);
    if (r >= minCss) out.push({ x, y, L, d, r, a: Array.from(a) });
  }, ctx);
  out.sort((p, q) => q.r - p.r);
  if (out.length > max) out.length = max;
  return out;
}

// The dot under (x, y) as drawn at zoom level z: among dots whose pick radius
// max(r, pickCss) covers the point, the one closest relative to that radius.
function query({ x, y, z, dpr, settings, pickCss }) {
  const cfg = makeConfig(settings, S0_CSS * Math.pow(2, z), dpr);
  const pickR = (L, d, cls) => Math.max(radiusCss(cfg, L, d, cls), pickCss) / cfg.sCss;
  const target = { x0: x, x1: x, y0: y, y1: y };
  const ctx = { nodes: 0, nodeBudget: cfg.nodeBudget, aborted: false, cands: 0, rootCalls: 0, lattice: 0, direct: 0 };
  let best = null, bestScore = Infinity;
  collect(target, cfg, pickR, (rx, ry, L, d, a, cls) => {
    if (cfg.colorMode === 'lead' && !cfg.highLead && a[d] >= 5) return; // not drawn
    const r = pickR(L, d, cls);
    const score = Math.hypot(rx - x, ry - y) / r - 1e-3 * radiusCss(cfg, L, d, cls);
    if (score < bestScore) {
      bestScore = score;
      best = { x: rx, y: ry, L, d, cls, coeffs: Array.from(a), rCss: radiusCss(cfg, L, d, cls) };
    }
  }, ctx);
  return best;
}
