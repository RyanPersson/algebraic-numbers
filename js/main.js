// main.js — map view, tile scheduling, interaction and the info panel.
import {
  TILE, S0_CSS, DEFAULT_SETTINGS, LEAD_COLORS, DEGREE_COLORS,
  polyRoots, radiusCss, radiusWorld, makeConfig, COMPLEX, REAL, CIRCLE,
} from './core.js';
import * as Alg from './algebra.js';

const MIN_ZOOM = -3;
const MAX_ZOOM = 32; // beyond this, double precision runs out
// Tiles exist at half-octave levels k (zoom k/2), so they are shown at 0.84–1.19×.
const KMIN = 2 * MIN_ZOOM, KMAX = 2 * MAX_ZOOM;
const CACHE_MAX = 420;
const PRIMES = [2, 3, 5, 7, 11, 13];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const settings = { ...DEFAULT_SETTINGS };
const view = { cx: 0, cy: 0, zoom: 0 };
const ui = { grid: false };
let W = 0, H = 0, DPR = 1;
let selected = null; // {coeffs, idx}
let hover = null;    // query hit
let flash = null;    // {x, y, t0}
let pointerPos = null;

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const g = canvas.getContext('2d', { alpha: false });

const sCss = (zoom = view.zoom) => S0_CSS * Math.pow(2, zoom);
const level = () => Math.max(KMIN, Math.min(KMAX, Math.round(2 * view.zoom)));
const levelZoom = (k) => k / 2;
const toWorld = (px, py) => {
  const s = sCss();
  return { x: view.cx + (px - W / 2) / s, y: view.cy - (py - H / 2) / s };
};
const toScreen = (x, y) => {
  const s = sCss();
  return { x: (x - view.cx) * s + W / 2, y: (view.cy - y) * s + H / 2 };
};

// ---------------------------------------------------------------------------
// Workers and tile cache
// ---------------------------------------------------------------------------

const NW = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const pool = [];
let gen = 0;
let cache = new Map(); // "z/i/j" -> {bmp, last}
let stale = new Map(); // previous settings' tiles, shown until replaced
const inflight = new Map(); // key -> generation it was requested for
let queue = [];
let frame = 0;

for (let k = 0; k < NW; k++) {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.job = null;
  w.onmessage = (ev) => onTile(w, ev.data);
  pool.push(w);
}
const qWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const tkey = (k, i, j) => `${k}/${i}/${j}`;
const tileWorld = (k) => TILE / (S0_CSS * Math.pow(2, levelZoom(k)) * DPR);

function visibleRange(z, pad) {
  const s = sCss(), h = tileWorld(z);
  const hw = W / 2 / s, hh = H / 2 / s;
  return {
    i0: Math.floor((view.cx - hw) / h) - pad,
    i1: Math.floor((view.cx + hw) / h) + pad,
    j0: Math.floor((view.cy - hh) / h) - pad,
    j1: Math.floor((view.cy + hh) / h) + pad,
  };
}

function schedule() {
  const z = level();
  const h = tileWorld(z);
  const jobs = [], seen = new Set();
  for (const pad of [0, 1]) {
    const r = visibleRange(z, pad);
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const k = tkey(z, i, j);
        if (seen.has(k) || cache.has(k) || inflight.get(k) === gen) continue;
        seen.add(k);
        const dx = (i + 0.5) * h - view.cx, dy = (j + 0.5) * h - view.cy;
        jobs.push({ k, z, i, j, pri: pad * 1e9 + dx * dx + dy * dy });
      }
    }
  }
  jobs.sort((a, b) => a.pri - b.pri);
  queue = jobs;
  dispatch();
}

function dispatch() {
  for (const w of pool) {
    if (w.job) continue;
    const job = queue.shift();
    if (!job) break;
    w.job = { ...job, gen };
    inflight.set(job.k, gen);
    w.postMessage({ type: 'tile', key: job.k, z: levelZoom(job.z), i: job.i, j: job.j, dpr: DPR, settings: { ...settings } });
  }
  updateBusy();
}

async function onTile(w, msg) {
  const job = w.job;
  w.job = null;
  if (inflight.get(job.k) === job.gen) inflight.delete(job.k);
  if (job.gen !== gen) {
    schedule(); // the settings changed meanwhile: this tile still needs doing
    return;
  }
  dispatch();
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(msg.pixels.buffer), TILE, TILE));
  if (job.gen === gen) {
    cache.set(job.k, { bmp, last: frame });
    requestRender();
  } else bmp.close();
  updateBusy();
}

function evict() {
  if (cache.size <= CACHE_MAX) return;
  const entries = [...cache.entries()].filter(([, t]) => t.last < frame).sort((a, b) => a[1].last - b[1].last);
  for (const [k, t] of entries.slice(0, cache.size - Math.floor(CACHE_MAX * 0.85))) {
    t.bmp.close();
    cache.delete(k);
  }
}

// New settings or pixel ratio: start a new generation and keep the old tiles as
// placeholders (not after a pixel-ratio change: their geometry would be wrong).
function invalidate(keepStale = true) {
  gen++;
  for (const b of stale.values()) b.close();
  stale = new Map();
  for (const [k, t] of cache) {
    if (keepStale) stale.set(k, t.bmp);
    else t.bmp.close();
  }
  cache = new Map();
  queue = [];
  schedule();
  requestRender();
}

function updateBusy() {
  $('status-busy').hidden = !pool.some((w) => w.job) && queue.length === 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function tileRect(z, i, j) {
  const h = tileWorld(z), s = sCss();
  const x0 = ((i * h - view.cx) * s + W / 2) * DPR;
  const x1 = (((i + 1) * h - view.cx) * s + W / 2) * DPR;
  const y0 = ((view.cy - (j + 1) * h) * s + H / 2) * DPR;
  const y1 = ((view.cy - j * h) * s + H / 2) * DPR;
  const X0 = Math.round(x0), Y0 = Math.round(y0);
  return [X0, Y0, Math.round(x1) - X0, Math.round(y1) - Y0];
}

function lookup(k) {
  const t = cache.get(k);
  if (t) { t.last = frame; return t.bmp; }
  return stale.get(k) || null;
}

// A missing tile is patched with whatever cached tiles of nearby levels cover it,
// coarse first so finer ones end up on top.
function drawTile(k, i, j) {
  const rect = tileRect(k, i, j);
  const exact = lookup(tkey(k, i, j));
  if (exact) { g.drawImage(exact, ...rect); return; }
  const h = tileWorld(k);
  const x0 = i * h, x1 = (i + 1) * h, y0 = j * h, y1 = (j + 1) * h;
  g.save();
  g.beginPath();
  g.rect(...rect);
  g.clip();
  for (let kk = Math.max(KMIN, k - 14); kk <= Math.min(KMAX, k + 3); kk++) {
    if (kk === k) continue;
    const hh = tileWorld(kk);
    const ia = Math.floor(x0 / hh), ib = Math.ceil(x1 / hh) - 1;
    const ja = Math.floor(y0 / hh), jb = Math.ceil(y1 / hh) - 1;
    if ((ib - ia + 1) * (jb - ja + 1) > 16) continue;
    for (let jj = ja; jj <= jb; jj++) for (let ii = ia; ii <= ib; ii++) {
      const bmp = lookup(tkey(kk, ii, jj));
      if (bmp) g.drawImage(bmp, ...tileRect(kk, ii, jj));
    }
  }
  g.restore();
}

function render() {
  renderQueued = false;
  frame++;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const z = level();
  const r = visibleRange(z, 0);
  for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) drawTile(z, i, j);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (ui.grid) drawGrid();
  drawMarkers();
  evict();
  updateStatus();
  positionTooltip();
  if (flash && performance.now() - flash.t0 < 1600) requestRender();
}

function niceStep(minWorld) {
  const p = Math.pow(10, Math.floor(Math.log10(minWorld)));
  for (const m of [1, 2, 5, 10]) if (m * p >= minWorld) return m * p;
  return 10 * p;
}

function fmtTick(v, step) {
  const dec = Math.max(0, -Math.floor(Math.log10(step)));
  if (Math.abs(v) < step / 2) return '0';
  return v.toFixed(Math.min(dec, 16));
}

function drawGrid() {
  const s = sCss();
  const step = niceStep(110 / s);
  const a = toWorld(0, H), b = toWorld(W, 0);
  g.lineWidth = 1;
  g.font = '11px ui-monospace, Menlo, monospace';
  g.textBaseline = 'top';
  const k0 = Math.ceil(a.x / step), k1 = Math.floor(b.x / step);
  for (let k = k0; k <= k1; k++) {
    const x = k * step, sx = Math.round(toScreen(x, 0).x) + 0.5;
    g.strokeStyle = k === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.09)';
    g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, H); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText(fmtTick(x, step), sx + 4, H - 44);
  }
  const m0 = Math.ceil(a.y / step), m1 = Math.floor(b.y / step);
  for (let m = m0; m <= m1; m++) {
    const y = m * step, sy = Math.round(toScreen(0, y).y) + 0.5;
    g.strokeStyle = m === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.09)';
    g.beginPath(); g.moveTo(0, sy); g.lineTo(W, sy); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    const label = fmtTick(y, step);
    g.fillText(label === '0' ? '0' : `${label}i`, W - 8 - g.measureText(`${label}i`).width, sy + 4);
  }
}

// screen radius of a dot as drawn by the tiles currently on screen
function dotScreenRadius(L, d, cls) {
  const z = levelZoom(level());
  const cfg = makeConfig(settings, sCss(z), DPR);
  return radiusCss(cfg, L, d, cls) * Math.pow(2, view.zoom - z);
}

function ring(x, y, r, style, dash) {
  g.save();
  g.setLineDash(dash || []);
  g.lineWidth = 3.5;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.stroke();
  g.lineWidth = 1.5;
  g.strokeStyle = style;
  g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.stroke();
  g.restore();
}

function drawMarkers() {
  if (document.body.classList.contains('clean')) return;
  if (selected) {
    const info = selectionInfo();
    info.roots.forEach((c, k) => {
      const p = toScreen(c.x, c.y);
      if (p.x < -60 || p.y < -60 || p.x > W + 60 || p.y > H + 60) return;
      const r = Math.max(9, dotScreenRadius(info.L, info.d, c.cls) + 5);
      if (k === selected.idx) ring(p.x, p.y, r, '#ffffff');
      else ring(p.x, p.y, r, 'rgba(255,200,120,0.9)', [4, 4]);
    });
  }
  if (hover && !(selected && sameNumber(hover, selected))) {
    const p = toScreen(hover.x, hover.y);
    ring(p.x, p.y, Math.max(7, dotScreenRadius(hover.L, hover.d, hover.cls) + 4), 'rgba(255,255,255,0.7)');
  }
  if (flash) {
    const t = (performance.now() - flash.t0) / 1600;
    if (t < 1) {
      const p = toScreen(flash.x, flash.y);
      g.save();
      g.globalAlpha = 1 - t;
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      const r = 14 + 26 * t;
      g.beginPath(); g.arc(p.x, p.y, r, 0, 2 * Math.PI); g.stroke();
      g.beginPath();
      g.moveTo(p.x - 8, p.y); g.lineTo(p.x + 8, p.y);
      g.moveTo(p.x, p.y - 8); g.lineTo(p.x, p.y + 8);
      g.stroke();
      g.restore();
    } else flash = null;
  }
}

// ---------------------------------------------------------------------------
// View changes
// ---------------------------------------------------------------------------

function clampZoom(z) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM + 0.6, z)); }

function viewChanged() {
  schedule();
  requestRender();
  saveHashSoon();
}

function zoomAt(px, py, zoom) {
  zoom = clampZoom(zoom);
  const w = toWorld(px, py);
  view.zoom = zoom;
  const s = sCss();
  view.cx = w.x - (px - W / 2) / s;
  view.cy = w.y + (py - H / 2) / s;
  viewChanged();
}

let anim = null;
function animateTo(cx, cy, zoom, ms = 600) {
  const from = { ...view };
  zoom = clampZoom(zoom);
  const t0 = performance.now();
  anim = { cancel: false };
  const me = anim;
  const step = () => {
    if (me.cancel) return;
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = 1 - Math.pow(1 - t, 3);
    // interpolate the zoom linearly (it is already a log scale) and the centre so
    // that the motion looks uniform on screen
    view.zoom = from.zoom + (zoom - from.zoom) * e;
    const sa = sCss(from.zoom), sb = sCss(zoom), sc = sCss(view.zoom);
    const u = sa === sb ? e : (1 / sa - 1 / sc) / (1 / sa - 1 / sb);
    view.cx = from.cx + (cx - from.cx) * u;
    view.cy = from.cy + (cy - from.cy) * u;
    viewChanged();
    if (t < 1) requestAnimationFrame(step);
  };
  step();
}
const stopAnim = () => { if (anim) anim.cancel = true; };

// Centre (x, y) in the part of the screen the info panel leaves free.
function focusOn(x, y, zoom, ms = 600) {
  let ox = 0, oy = 0;
  if (!$('info').hidden) {
    const r = $('info').getBoundingClientRect();
    if (r.width < W * 0.7) ox = (W - r.left) / 2; // side panel
    else oy = (H - r.top) / 2;                    // bottom sheet
  }
  const s = sCss(clampZoom(zoom));
  animateTo(x + ox / s, y - oy / s, zoom, ms);
}

function resetView() {
  // Stephen Brooks' framing: 0, 1 and 2 along the bottom, i near the top
  // (on big screens, at about the scale of his picture, showing more around it)
  const box = { x0: -0.62, x1: 1.72, y0: -0.07, y1: 1.18 };
  const s = Math.min(W / (box.x1 - box.x0), H / (box.y1 - box.y0), 480);
  const cx = (box.x0 + box.x1) / 2;
  const cy = Math.min((box.y0 + box.y1) / 2, box.y0 + H / 2 / s);
  return { cx, cy, zoom: Math.log2(s / S0_CSS) };
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  if (dpr !== DPR) {
    DPR = dpr;
    invalidate(false);
  }
  viewChanged();
}

// ---------------------------------------------------------------------------
// Pointer, wheel and keyboard
// ---------------------------------------------------------------------------

const pointers = new Map();
let drag = null, pinch = null;

canvas.addEventListener('pointerdown', (e) => {
  stopAnim();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x0: e.clientX, y0: e.clientY, cx: view.cx, cy: view.cy, moved: false };
  } else if (pointers.size === 2) {
    const [p, q] = [...pointers.values()];
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    pinch = { d0: Math.hypot(p.x - q.x, p.y - q.y), zoom0: view.zoom, w: toWorld(mx, my) };
    drag = null;
  }
});

canvas.addEventListener('pointermove', (e) => {
  pointerPos = { x: e.clientX, y: e.clientY };
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [p, q] = [...pointers.values()];
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    view.zoom = clampZoom(pinch.zoom0 + Math.log2(Math.hypot(p.x - q.x, p.y - q.y) / pinch.d0));
    const s = sCss();
    view.cx = pinch.w.x - (mx - W / 2) / s;
    view.cy = pinch.w.y + (my - H / 2) / s;
    viewChanged();
  } else if (drag) {
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      canvas.classList.add('dragging');
      setHover(null);
    }
    if (drag.moved) {
      const s = sCss();
      view.cx = drag.cx - dx / s;
      view.cy = drag.cy + dy / s;
      viewChanged();
    }
  } else if (e.pointerType === 'mouse') {
    requestHover(e.clientX, e.clientY);
    updateStatus();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (drag && !drag.moved && e.type === 'pointerup') clickAt(e.clientX, e.clientY);
  if (pointers.size === 1 && pinch) {
    // lifting one finger of a pinch: keep panning with the other
    const [p] = [...pointers.values()];
    drag = { x0: p.x, y0: p.y, cx: view.cx, cy: view.cy, moved: true };
  }
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    drag = null;
    canvas.classList.remove('dragging');
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { pointerPos = null; if (!drag) setHover(null); updateStatus(); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  stopAnim();
  const unit = e.deltaMode === 1 ? 0.06 : e.deltaMode === 2 ? 1 : e.ctrlKey ? 0.012 : 0.0022;
  zoomAt(e.clientX, e.clientY, view.zoom - e.deltaY * unit);
  setHover(null);
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  const w = toWorld(e.clientX, e.clientY);
  const z = view.zoom + (e.shiftKey ? -1 : 1);
  const s = sCss(z);
  animateTo(w.x - (e.clientX - W / 2) / s, w.y + (e.clientY - H / 2) / s, z, 350);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const s = sCss();
  if (e.key === 'v' || e.key === 'V') toggleControls();
  else if (e.key === '+' || e.key === '=') animateTo(view.cx, view.cy, view.zoom + 1, 300);
  else if (e.key === '-' || e.key === '_') animateTo(view.cx, view.cy, view.zoom - 1, 300);
  else if (e.key === 'ArrowLeft') animateTo(view.cx - W / 5 / s, view.cy, view.zoom, 250);
  else if (e.key === 'ArrowRight') animateTo(view.cx + W / 5 / s, view.cy, view.zoom, 250);
  else if (e.key === 'ArrowUp') animateTo(view.cx, view.cy + H / 5 / s, view.zoom, 250);
  else if (e.key === 'ArrowDown') animateTo(view.cx, view.cy - H / 5 / s, view.zoom, 250);
  else if (e.key === '/') { e.preventDefault(); $('search-input').focus(); }
  else if (e.key === 'Escape') {
    if (!$('help').hidden) $('help').hidden = true;
    else if (!$('settings').hidden) toggleSettings(false);
    else select(null);
  } else return;
  e.preventDefault();
});

// "v": hide every overlay so only the picture is left (press again to bring them back)
function toggleControls() {
  document.body.classList.toggle('clean');
  setHover(null);
  requestRender();
}

$('btn-zoom-in').onclick = () => animateTo(view.cx, view.cy, view.zoom + 1, 300);
$('btn-zoom-out').onclick = () => animateTo(view.cx, view.cy, view.zoom - 1, 300);

// ---------------------------------------------------------------------------
// Hit testing (query worker)
// ---------------------------------------------------------------------------

// Only the latest hover query matters, but a click must never be dropped.
let qBusy = false, qHover = null, qClick = null, qSeq = 0;
const qCallbacks = new Map();

function postQuery(px, py, cb, isClick = false) {
  if (isClick) qClick = { px, py, cb };
  else qHover = { px, py, cb };
  if (!qBusy) sendQuery();
}
function sendQuery() {
  const p = qClick || qHover;
  if (qClick) qClick = null;
  else qHover = null;
  if (!p) return;
  const w = toWorld(p.px, p.py);
  const z = levelZoom(level());
  const id = ++qSeq;
  qCallbacks.set(id, p.cb);
  qBusy = true;
  qWorker.postMessage({
    type: 'query', id, x: w.x, y: w.y, z, dpr: DPR, settings: { ...settings },
    pickCss: 7 / Math.pow(2, view.zoom - z),
  });
}
qWorker.onmessage = (ev) => {
  qBusy = false;
  const cb = qCallbacks.get(ev.data.id);
  qCallbacks.delete(ev.data.id);
  if (cb) cb(ev.data.hit);
  sendQuery();
};

let hoverTimer = 0;
function requestHover(px, py) {
  clearTimeout(hoverTimer);
  if (document.body.classList.contains('clean')) return;
  hoverTimer = setTimeout(() => postQuery(px, py, (hit) => {
    if (!drag && pointerPos) setHover(hit);
  }), 25);
}

function setHover(hit) {
  const was = hover;
  hover = hit;
  canvas.classList.toggle('pointing', !!hit);
  if (was !== hit) requestRender();
  positionTooltip();
}

function clickAt(px, py) {
  postQuery(px, py, (hit) => {
    if (!hit) { select(null); return; }
    const roots = polyRoots(hit.coeffs, hit.d);
    let idx = 0, best = Infinity;
    for (let k = 0; k < hit.d; k++) {
      const dd = Math.hypot(roots[2 * k] - hit.x, roots[2 * k + 1] - hit.y);
      if (dd < best) { best = dd; idx = k; }
    }
    select({ coeffs: hit.coeffs, idx });
  }, true);
}

function sameNumber(hit, sel) {
  if (hit.coeffs.length !== sel.coeffs.length || hit.coeffs.some((v, k) => v !== sel.coeffs[k])) return false;
  const c = selectionInfo().roots[sel.idx];
  return Math.hypot(c.x - hit.x, c.y - hit.y) < 1e-9 * (1 + Math.hypot(c.x, c.y));
}

function positionTooltip() {
  const tip = $('tooltip');
  if (!hover || drag || pinch) { tip.hidden = true; return; }
  const p = toScreen(hover.x, hover.y);
  if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) { tip.hidden = true; return; }
  const key = hover.coeffs.join(',') + hover.x;
  if (tip.dataset.key !== key) {
    tip.dataset.key = key;
    const lead = hover.coeffs[hover.d];
    tip.innerHTML = `<div class="poly">${Alg.polyText(hover.coeffs)}</div>`
      + `<div class="sub">${Alg.formatComplex(hover.x, hover.y, 8)} · deg ${hover.d}${lead === 1 ? ' · integer' : ` · lead ${lead}`}</div>`;
  }
  tip.hidden = false;
  const r = Math.max(7, dotScreenRadius(hover.L, hover.d, hover.cls) + 4);
  const bw = tip.offsetWidth, bh = tip.offsetHeight;
  let x = p.x + r * 0.75 + 10, y = p.y - r * 0.75 - bh - 6;
  if (x + bw > W - 8) x = p.x - r * 0.75 - 10 - bw;
  if (y < 8) y = p.y + r * 0.75 + 8;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  tip.style.left = '0';
  tip.style.top = '0';
}

// ---------------------------------------------------------------------------
// Selection and the info panel
// ---------------------------------------------------------------------------

let selCache = null;
function selectionInfo() {
  if (selCache && selCache.sel === selected) return selCache;
  const a = selected.coeffs, d = a.length - 1;
  const r = polyRoots(a, d);
  const palin = d % 2 === 0 && a.every((v, k) => v === a[d - k]);
  const roots = [];
  for (let k = 0; k < d; k++) {
    const x = r[2 * k], y = r[2 * k + 1];
    const cls = y === 0 ? REAL : palin && Math.abs(x * x + y * y - 1) < 1e-11 ? CIRCLE : COMPLEX;
    roots.push({ x, y, cls });
  }
  selCache = { sel: selected, roots, d, L: a.reduce((s, v) => s + Math.abs(v), 0) };
  return selCache;
}

function select(sel) {
  selected = sel;
  selCache = null;
  document.body.classList.toggle('info-open', !!sel);
  $('info').hidden = !sel;
  if (sel) renderInfo();
  requestRender();
  saveHashSoon();
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tex = (t, cls = '') => `<span class="tex ${cls}" data-tex="${esc(t)}"></span>`;

function renderTexIn(root) {
  for (const el of root.querySelectorAll('.tex[data-tex]')) {
    const src = el.dataset.tex;
    if (window.katex) {
      try {
        window.katex.render(src, el, { throwOnError: false, displayMode: el.classList.contains('display') });
        continue;
      } catch { /* fall through */ }
    }
    el.textContent = src;
    el.classList.add('tex-fallback');
  }
}

function texInt(n) {
  const s = n.toString();
  return s.length > 40 ? `${s.slice(0, 18)}\\ldots${s.slice(-12)}\\ (${s.length}\\text{ digits})` : s;
}

function texFactored(n) {
  if (n === 0n) return '0';
  const neg = n < 0n;
  const { factors, rest } = Alg.factorInteger(neg ? -n : n);
  if (!factors.length && rest === 1n) return neg ? '-1' : '1';
  const parts = factors.map(([p, e]) => (e > 1 ? `${p}^{${e}}` : `${p}`));
  if (rest > 1n) parts.push(`${texInt(rest)}`);
  return (neg ? '-' : '') + parts.join(' \\cdot ');
}

function fmtNum(v) {
  return Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(6) : v.toPrecision(8).replace(/\.?0+$/, '');
}

function idealRows(a, info) {
  const discAbs = info.disc < 0n ? -info.disc : info.disc;
  const ps = PRIMES.slice();
  for (let p = 17; p < 200; p += 2) {
    if (ps.length >= 9) break;
    let prime = true;
    for (let q = 3; q * q <= p; q += 2) if (p % q === 0) prime = false;
    if (prime && discAbs % BigInt(p) === 0n) ps.push(p);
  }
  return ps.map((l) => {
    const ramifiedHere = discAbs % BigInt(l) === 0n;
    const leadDiv = BigInt(a[a.length - 1]) % BigInt(l) === 0n;
    const { factors } = Alg.factorModP(a, l);
    if (factors.some((f) => f.unknown)) {
      return `<tr><td>${l}</td><td class="sub">not factored (degree too high for this prime)</td><td class="note"></td></tr>`;
    }
    if (!factors.length) {
      return `<tr><td>${l}</td><td>none — ${tex(`${l}`)} is a unit in ${tex('\\mathbb{Z}[\\alpha]')}</td><td class="note">${tex(`p \\equiv \\text{const}`)}</td></tr>`;
    }
    const prod = factors.map(({ g: f, e }) => {
      const t = Alg.polyTex(f);
      const base = f.length > 2 || f[0] !== 0 ? `(${t})` : t;
      return e > 1 ? `${base}^{${e}}` : base;
    }).join('');
    const ideals = factors.map(({ g: f }) => `(${l},\\, ${Alg.polyTex(f)})`).join(',\\ ');
    const fs = factors.map(({ g: f }) => f.length - 1);
    let note = fs.every((f) => f === 1) && factors.length === a.length - 1 ? 'split' : '';
    if (factors.some((f) => f.e > 1)) note = 'repeated';
    if (factors.length === 1 && factors[0].e === 1 && fs[0] === a.length - 1) note = 'inert';
    if (a.length === 2) note = '';
    if (leadDiv) note = `${l} | a_d`;
    else if (ramifiedHere && !note) note = `${l} | disc`;
    return `<tr><td>${l}</td><td>${tex(`p \\equiv ${prod}`)}<br>${tex(ideals)}`
      + `<div class="sub">${factors.map(({ g: f }) => tex(`\\mathbb{F}_{${l}${f.length - 1 > 1 ? `^{${f.length - 1}}` : ''}}`)).join(', ')}</div></td>`
      + `<td class="note">${note}</td></tr>`;
  }).join('');
}

function renderInfo() {
  const a = selected.coeffs, d = a.length - 1;
  const sInfo = selectionInfo();
  const alpha = sInfo.roots[selected.idx];
  const info = Alg.describe(a, alpha.x, alpha.y);
  const lead = a[d];
  const pTex = Alg.polyTex(a);
  const closed = Alg.closedForm(a, alpha.x, alpha.y);
  const chips = [];
  chips.push(`<span class="chip">degree ${d}</span>`);
  chips.push(info.isInt ? '<span class="chip on">algebraic integer</span>' : `<span class="chip">leading coefficient ${lead}</span>`);
  if (info.isUnit) chips.push('<span class="chip on">unit</span>');
  if (info.rootOfUnity) chips.push(`<span class="chip on">primitive ${info.rootOfUnity}th root of unity</span>`);
  for (const t of info.tags) chips.push(`<span class="chip on">${t}</span>`);
  chips.push(`<span class="chip">${alpha.y === 0 ? 'real' : 'non-real'}</span>`);

  const notDrawn = [];
  if (d > settings.maxDeg) notDrawn.push(`its degree (${d}) is above <b>Max degree</b> (${settings.maxDeg})`);
  if (settings.numbers === 'integers' && lead !== 1) notDrawn.push('it is not an algebraic integer');
  if (settings.numbers === 'all' && settings.colorMode === 'lead' && !settings.highLead && lead >= 5) notDrawn.push('leading coefficients ≥ 5 are hidden');

  const ringTex = info.isInt
    ? `\\mathbb{Z}[x]/I_\\alpha \\cong \\mathbb{Z}[\\alpha] = ${d === 1 ? '\\mathbb{Z}' : `\\mathbb{Z} \\oplus \\mathbb{Z}\\alpha${d > 2 ? ` \\oplus \\dots \\oplus \\mathbb{Z}\\alpha^{${d - 1}}` : ''}`}`
    : '\\mathbb{Z}[x]/I_\\alpha \\cong \\mathbb{Z}[\\alpha]';
  const monic = Alg.monicCoeffs(a);
  const scaled = Alg.scaledToInteger(a);

  const conjList = sInfo.roots.map((c, k) => `<button class="${k === selected.idx ? 'self' : ''}" data-conj="${k}"><span class="dot" style="opacity:${k === selected.idx ? 1 : 0.45}"></span>${Alg.formatComplex(c.x, c.y, 10)}</button>`).join('');

  const html = `
    <h2>${info.isInt ? 'Algebraic integer' : 'Algebraic number'} ${tex('\\alpha')}</h2>
    <div class="value">${Alg.formatComplex(alpha.x, alpha.y, 15)}</div>
    ${closed ? `<div class="closed">${tex(`\\alpha = ${closed}`)}</div>` : ''}
    <div class="chips">${chips.join('')}</div>
    ${notDrawn.length ? `<p class="warn">Not drawn with the current settings: ${notDrawn.join('; ')}.</p>` : ''}

    <section>
      <h3>Minimal polynomial</h3>
      <div class="math-line">${tex(`p(x) = ${pTex}`)}</div>
      ${lead !== 1 ? `<p>Over ${tex('\\mathbb{Q}')}, monic: ${tex(`m(x) = ${Alg.polyTex(monic)}`)}</p>` : ''}
    </section>

    <section>
      <h3>The ideal of ${tex('\\alpha')}</h3>
      <div class="ideal-box">
        <div class="math-line">${tex(`I_\\alpha = \\{\\, f \\in \\mathbb{Z}[x] : f(\\alpha) = 0 \\,\\} = \\big(${pTex}\\big)`)}</div>
      </div>
      <p>The kernel of evaluation ${tex('\\mathbb{Z}[x] \\to \\mathbb{C},\\ f \\mapsto f(\\alpha)')}. It is principal because ${tex('p')} is primitive (Gauss’s lemma), and prime of height 1. ${d === 1 ? 'α is rational, so it is its own only conjugate.' : `${d === 2 ? 'Both conjugates' : `All ${d} conjugates`} (ringed on the map) have the same ideal.`}</p>
      <div class="math-line">${tex(ringTex)}</div>
      <p>${info.isInt
        ? (d === 1 ? 'α is a rational integer.' : `A free ${tex('\\mathbb{Z}')}-module of rank ${d}, since ${tex('p')} is monic.`)
        : `Not finitely generated as a ${tex('\\mathbb{Z}')}-module, since α is not an algebraic integer. Instead ${tex(`${lead}\\alpha`)} is, with minimal polynomial ${tex(Alg.polyTex(scaled))}.`}</p>
      <p>Over ${tex('\\mathbb{Q}')}: ${tex(`I_\\alpha\\,\\mathbb{Q}[x] = (m)`)} is maximal and ${tex(`\\mathbb{Q}[x]/(m) \\cong \\mathbb{Q}(\\alpha)`)}, a field of degree ${d}.</p>
    </section>

    <section>
      <h3>Maximal ideals containing ${tex('I_\\alpha')}</h3>
      <p>Each irreducible factor ${tex('g')} of ${tex('p \\bmod \\ell')} gives a maximal ideal ${tex('(\\ell, g(x)) \\supset I_\\alpha')} with residue field ${tex('\\mathbb{F}_{\\ell^{\\deg g}}')}.</p>
      <table>${idealRows(a, info)}</table>
    </section>

    <section>
      <h3>Invariants</h3>
      <table class="kv">
        <tr><td>Degree</td><td>${d}</td></tr>
        <tr><td>Signature</td><td>${tex(`(r_1, r_2) = (${info.r1}, ${info.r2})`)}</td></tr>
        ${d > 1 ? `<tr><td>Discriminant</td><td>${tex(texInt(info.disc))}${info.disc !== 0n && (info.disc > 1n || info.disc < -1n) ? `<div class="sub">${tex(`= ${texFactored(info.disc)}`)}</div>` : ''}</td></tr>` : ''}
        <tr><td>Mahler measure</td><td>${fmtNum(info.mahler)}</td></tr>
        <tr><td>House</td><td>${tex(`\\max |\\alpha_i| = ${fmtNum(info.house)}`)}</td></tr>
        <tr><td>Height</td><td>${tex(`\\max |a_k| = ${info.height}`)}</td></tr>
        <tr><td>Length</td><td>${tex(`\\textstyle\\sum |a_k| = ${info.length}`)} <span class="sub">(sets the dot size)</span></td></tr>
      </table>
    </section>

    <section>
      <h3>Conjugates</h3>
      <div class="conj">${conjList}</div>
    </section>

    <div class="actions">
      <button class="text-btn" id="act-center">Centre</button>
      <button class="text-btn" id="act-copy">Copy polynomial</button>
      <button class="text-btn" id="act-link">Copy link</button>
    </div>`;
  const body = $('info-body');
  body.innerHTML = html;
  renderTexIn(body);
  for (const b of body.querySelectorAll('[data-conj]')) {
    b.onclick = () => {
      const k = +b.dataset.conj;
      select({ coeffs: a, idx: k });
      const c = selectionInfo().roots[k];
      focusOn(c.x, c.y, view.zoom, 600);
    };
  }
  $('act-center').onclick = () => focusOn(alpha.x, alpha.y, view.zoom, 500);
  $('act-copy').onclick = (e) => copyText(Alg.polyText(a, 'x', true), e.target);
  $('act-link').onclick = (e) => { saveHash(); copyText(location.href, e.target); };
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch {
    window.prompt('Copy:', text);
  }
}

$('info-close').onclick = () => select(null);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function searchMsg(text, error = false) {
  const el = $('search-msg');
  el.hidden = !text;
  el.className = `search-msg${error ? ' error' : ''}`;
  el.innerHTML = text || '';
}

// zoom at which a dot of this number is about `px` pixels across (radius)
function zoomForDot(a, cls, px = 10) {
  const d = a.length - 1, L = a.reduce((s, v) => s + Math.abs(v), 0);
  const cfg = makeConfig(settings, S0_CSS, 1);
  const r = radiusWorld(cfg, L, d, cls);
  return Math.log2(px / r / S0_CSS);
}

function goToPolynomial(poly) {
  const factors = Alg.factorOverZ(poly).filter((f) => f.length > 1);
  if (!factors.length) { searchMsg('That polynomial has no roots.', true); return; }
  const uniq = [];
  for (const f of factors) if (!uniq.some((u) => u.join() === f.join())) uniq.push(f);
  uniq.sort((u, v) => v.length - u.length);
  const f = uniq[0], d = f.length - 1;
  const r = polyRoots(f, d);
  let idx = 0, best = Infinity;
  for (let k = 0; k < d; k++) {
    if (r[2 * k + 1] < 0) continue;
    const dd = Math.hypot(r[2 * k] - view.cx, r[2 * k + 1] - view.cy);
    if (dd < best) { best = dd; idx = k; }
  }
  const notes = [];
  if (uniq.length > 1 || factors.length > 1) notes.push(`Reducible: ${factors.map((u) => `(${Alg.polyText(u)})`).join('')}. Showing a root of ${Alg.polyText(f)}.`);
  if (d > settings.maxDeg && d <= 7) notes.push(`Degree ${d} is above Max degree — <a href="#" id="raise-deg">show degree ≤ ${d}</a>.`);
  else if (d > 7) notes.push(`Degree ${d} is above what the map draws (7), but its ideals are below.`);
  searchMsg(notes.join(' '));
  const raise = $('raise-deg');
  if (raise) raise.onclick = (e) => { e.preventDefault(); setSetting('maxDeg', Math.min(7, d)); searchMsg(''); };
  select({ coeffs: f, idx });
  const c = selectionInfo().roots[idx];
  focusOn(c.x, c.y, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomForDot(f, c.cls, 14))), 900);
  $('search-input').blur();
}

function goToPoint(p) {
  searchMsg('');
  const zoom = Math.max(view.zoom, 1);
  animateTo(p.x, p.y, zoom, 700);
  setTimeout(() => {
    flash = { x: p.x, y: p.y, t0: performance.now() };
    requestRender();
    const s = toScreen(p.x, p.y);
    postQuery(s.x, s.y, (hit) => {
      if (hit && Math.hypot(hit.x - p.x, hit.y - p.y) < 1e-9 * (1 + Math.hypot(p.x, p.y))) clickAt(s.x, s.y);
    }, true);
  }, 720);
}

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('search-input').value.trim();
  if (!text) { searchMsg(''); return; }
  const poly = Alg.parsePolynomial(text);
  if (poly) { goToPolynomial(poly); return; }
  const p = Alg.parseComplex(text);
  if (p) { goToPoint(p); return; }
  searchMsg('Couldn’t read that. Try <code>x^3 - x - 1</code>, <code>(1+sqrt(5))/2</code> or <code>0.5+0.87i</code>.', true);
});

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

const detailToSlider = (r) => Math.log(1.6 / r) / Math.log(1.6 / 0.25);
const sliderToDetail = (t) => 1.6 * Math.pow(0.25 / 1.6, t);

function fmtSetting(key, v) {
  if (key === 'maxDeg') return String(v);
  if (key === 'detail') return `${v.toFixed(2)} px`;
  if (key === 'falloff') return v.toFixed(2);
  return `${(+v).toFixed(2)}×`;
}

function syncSettingsUI() {
  for (const seg of document.querySelectorAll('.seg[data-setting]')) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(settings[seg.dataset.setting] === b.dataset.value));
  }
  const leadBtn = document.querySelector('.seg[data-setting="colorMode"] [data-value="lead"]');
  leadBtn.disabled = settings.numbers === 'integers';
  $('row-highlead').hidden = settings.colorMode !== 'lead' || settings.numbers === 'integers';
  for (const inp of document.querySelectorAll('input[data-setting]')) {
    const key = inp.dataset.setting;
    if (inp.type === 'checkbox') inp.checked = !!settings[key];
    else inp.value = key === 'detail' ? detailToSlider(settings[key]) : settings[key];
    const out = document.querySelector(`output[data-for="${key}"]`);
    if (out) out.textContent = fmtSetting(key, settings[key]);
  }
  $('opt-grid').checked = ui.grid;
}

function setSetting(key, value) {
  settings[key] = value;
  if (key === 'numbers' && value === 'integers') settings.colorMode = 'degree';
  syncSettingsUI();
  updateLegend();
  setHover(null);
  invalidate();
  if (selected) renderInfo();
  saveHashSoon();
}

for (const seg of document.querySelectorAll('.seg[data-setting]')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    setSetting(seg.dataset.setting, b.dataset.value);
  });
}
for (const inp of document.querySelectorAll('input[data-setting]')) {
  const key = inp.dataset.setting;
  const read = () => (inp.type === 'checkbox' ? inp.checked : key === 'detail' ? sliderToDetail(+inp.value) : +inp.value);
  inp.addEventListener('input', () => {
    const out = document.querySelector(`output[data-for="${key}"]`);
    if (out) out.textContent = fmtSetting(key, read());
  });
  inp.addEventListener('change', () => setSetting(key, read()));
}
$('opt-grid').addEventListener('change', (e) => { ui.grid = e.target.checked; requestRender(); saveHashSoon(); });
$('btn-reset-settings').onclick = () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  syncSettingsUI();
  updateLegend();
  invalidate();
  if (selected) renderInfo();
  saveHashSoon();
};
$('btn-reset-view').onclick = () => { const v = resetView(); animateTo(v.cx, v.cy, v.zoom, 700); };

function toggleSettings(open) {
  const el = $('settings');
  open = open ?? el.hidden;
  el.hidden = !open;
  $('btn-settings').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('settings-open', open);
}
$('btn-settings').onclick = () => toggleSettings();
$('btn-help').onclick = () => { $('help').hidden = false; renderTexIn($('help')); };
$('help-close').onclick = () => { $('help').hidden = true; };
$('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').hidden = true; });

function cssColor(c, k = 1.6) {
  const f = (v) => Math.round(255 * (1 - Math.exp(-k * v)));
  return `rgb(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;
}

function updateLegend() {
  const el = $('legend');
  let items = [], title;
  if (settings.colorMode === 'degree') {
    title = settings.numbers === 'integers' ? 'Algebraic integers · degree' : 'Degree';
    for (let d = 1; d <= settings.maxDeg; d++) items.push([DEGREE_COLORS[d], String(d)]);
  } else {
    title = 'Leading coefficient';
    items = [[LEAD_COLORS[1], '1 (integers)'], [LEAD_COLORS[2], '2'], [LEAD_COLORS[3], '3'], [LEAD_COLORS[4], '4']];
    if (settings.highLead) items.push([LEAD_COLORS[5], '≥ 5']);
  }
  el.innerHTML = `<span class="title">${title}</span>` + items.map(([c, t]) => `<span class="item"><span class="swatch" style="background:${cssColor(c)};box-shadow:0 0 6px ${cssColor(c)}"></span>${t}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function updateStatus() {
  const s = sCss();
  const digits = Math.max(3, Math.ceil(Math.log10(s)) + 1);
  if (pointerPos) {
    const w = toWorld(pointerPos.x, pointerPos.y);
    const f = (v) => v.toFixed(Math.min(17, digits));
    $('status-pos').textContent = `${f(w.x)} ${w.y < 0 ? '−' : '+'} ${f(Math.abs(w.y))}i`;
  } else $('status-pos').textContent = '';
  const mag = Math.pow(2, view.zoom);
  const magText = mag < 1000 ? `${mag < 10 ? mag.toFixed(2) : mag.toFixed(0)}×` : `${mag.toExponential(1).replace('e+', '·10^')}×`;
  $('status-zoom').textContent = `zoom ${magText}${view.zoom >= MAX_ZOOM ? ' (max)' : ''}`;
}

// ---------------------------------------------------------------------------
// URL hash: view, settings and selection
// ---------------------------------------------------------------------------

const HASH_KEYS = { maxDeg: 'deg', numbers: 'num', colorMode: 'col', highLead: 'hl', dotScale: 'ds', detail: 'det', falloff: 'k', exposure: 'ex', glow: 'gl' };

function saveHash() {
  const p = new URLSearchParams();
  const prec = Math.max(6, Math.ceil(Math.log10(sCss())) + 4);
  p.set('x', view.cx.toPrecision(Math.min(17, prec)));
  p.set('y', view.cy.toPrecision(Math.min(17, prec)));
  p.set('z', view.zoom.toFixed(3));
  const def = DEFAULT_SETTINGS;
  for (const [k, short] of Object.entries(HASH_KEYS)) {
    if (settings[k] !== def[k]) p.set(short, typeof settings[k] === 'boolean' ? (settings[k] ? '1' : '0') : String(+settings[k] === settings[k] ? +settings[k].toFixed(4) : settings[k]));
  }
  if (ui.grid) p.set('grid', '1');
  if (selected) p.set('sel', `${selected.coeffs.join('_')}.${selected.idx}`);
  history.replaceState(null, '', `#${p.toString()}`);
}
let hashTimer = 0;
function saveHashSoon() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(saveHash, 400);
}

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const v = resetView();
  view.cx = p.has('x') ? parseFloat(p.get('x')) : v.cx;
  view.cy = p.has('y') ? parseFloat(p.get('y')) : v.cy;
  view.zoom = p.has('z') ? clampZoom(parseFloat(p.get('z'))) : v.zoom;
  if (!Number.isFinite(view.cx) || !Number.isFinite(view.cy) || !Number.isFinite(view.zoom)) Object.assign(view, v);
  for (const [k, short] of Object.entries(HASH_KEYS)) {
    if (!p.has(short)) continue;
    const raw = p.get(short), def = DEFAULT_SETTINGS[k];
    if (typeof def === 'boolean') settings[k] = raw === '1';
    else if (typeof def === 'number') { const n = parseFloat(raw); if (Number.isFinite(n)) settings[k] = n; }
    else settings[k] = raw;
  }
  settings.maxDeg = Math.max(1, Math.min(7, Math.round(settings.maxDeg)));
  if (settings.numbers === 'integers') settings.colorMode = 'degree';
  ui.grid = p.get('grid') === '1';
  const sel = p.get('sel');
  if (sel) {
    const m = sel.match(/^(-?\d+(?:_-?\d+)+)\.(\d+)$/);
    if (m) {
      const coeffs = m[1].split('_').map(Number);
      const idx = +m[2];
      if (coeffs.length >= 2 && coeffs.length <= 13 && idx < coeffs.length - 1 && coeffs[coeffs.length - 1] > 0) return { coeffs, idx };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

W = window.innerWidth;
H = window.innerHeight;
const initialSel = loadHash();
syncSettingsUI();
updateLegend();
window.addEventListener('resize', resize);
resize();
if (initialSel) select(initialSel);
window.addEventListener('load', () => { if (selected) renderInfo(); });
