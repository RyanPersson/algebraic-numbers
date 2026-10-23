// main.js — map view, tile scheduling, interaction and the info panel.
import {
  TILE, S0_CSS, DEFAULT_SETTINGS, LEAD_COLORS, DEGREE_COLORS,
  polyRoots, radiusCss, radiusWorld, makeConfig, maxLength, COMPLEX, REAL, CIRCLE,
} from './core.js';
import { findArcs, traceArc } from './arcs.js';
import * as Alg from './algebra.js';
import { makePath, ease, autoDuration, encodeViews, decodeViews } from './flight.js';
import { Sonifier, sweepEvents, isRationalCentre } from './sound.js';

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
// Tiles are 256×256 images at half-octave zoom levels k (zoom k/2), rendered at
// tileDpr device pixels per CSS pixel (2 on high-density screens; flights may use 1).

const NW = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const pool = [];
let gen = 0;
let tileDpr = 1;
let cache = new Map(); // key -> {bmp, last, born}
let stale = new Map(); // previous settings' tiles, shown until replaced
const inflight = new Map(); // key -> generation it was requested for
let queue = [];
let protect = new Set(); // tiles a flight is about to need: never evicted
let frame = 0;
// Zooming between levels crossfades the two nearest ones, so brightness, dot sizes
// and fine dust change continuously instead of jumping at each level. (false: draw
// only the nearest level, as before; kept for benchmarks.)
let crossfade = true;
let fadeMs = 180; // newly computed tiles fade in over this long

for (let k = 0; k < NW; k++) {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.job = null;
  w.onmessage = (ev) => onTile(w, ev.data);
  pool.push(w);
}
const qWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const tkey = (k, i, j, dpr = tileDpr) => `${dpr}|${k}|${i}|${j}`;
const tileWorld = (k, dpr = tileDpr) => TILE / (S0_CSS * Math.pow(2, k / 2) * dpr);
const naturalTileDpr = () => (DPR >= 1.5 ? 2 : 1);

// The levels drawn at a zoom: [k, weight of level k+1]
function levelsFor(zoom) {
  const z2 = Math.max(KMIN, Math.min(KMAX, 2 * zoom));
  if (!crossfade) return [Math.round(z2), 0];
  const k = Math.floor(z2);
  return [k, k >= KMAX ? 0 : z2 - k];
}
// the level that dominates the picture (hit tests and ring sizes follow it)
const level = () => { const [k, t] = levelsFor(view.zoom); return t > 0.5 ? k + 1 : k; };
const levelZoom = (k) => k / 2;

function visibleRange(k, pad, v = view) {
  const s = sCss(v.zoom), h = tileWorld(k);
  const hw = W / 2 / s, hh = H / 2 / s;
  return {
    i0: Math.floor((v.cx - hw) / h) - pad,
    i1: Math.floor((v.cx + hw) / h) + pad,
    j0: Math.floor((v.cy - hh) / h) - pad,
    j1: Math.floor((v.cy + hh) / h) + pad,
  };
}

// Every tile a view draws, the dominant level first: [{k, i, j, rank}]
function tilesOf(v, pad = 0) {
  const [k, t] = levelsFor(v.zoom);
  const layers = t === 0 ? [k] : t > 0.5 ? [k + 1, k] : [k, k + 1];
  const out = [];
  layers.forEach((kk, rank) => {
    const r = visibleRange(kk, pad, v);
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) out.push({ k: kk, i, j, rank });
  });
  return out;
}

// Are all the tiles this view draws in the cache?
function viewComplete(v) {
  for (const q of tilesOf(v)) if (!cache.has(tkey(q.k, q.i, q.j))) return false;
  return true;
}

function schedule() {
  const jobs = [], seen = new Set();
  const add = (k, i, j, pri) => {
    const key = tkey(k, i, j);
    if (seen.has(key) || cache.has(key) || inflight.get(key) === gen) return;
    seen.add(key);
    jobs.push({ key, k, i, j, pri });
  };
  if (flight && flight.active) planFlight(add);
  else {
    protect = new Set();
    const dist = (q) => {
      const h = tileWorld(q.k), dx = (q.i + 0.5) * h - view.cx, dy = (q.j + 0.5) * h - view.cy;
      return (dx * dx + dy * dy) * sCss() ** 2;
    };
    for (const q of tilesOf(view)) add(q.k, q.i, q.j, q.rank * 1e12 + dist(q));
    // the level just past the ones on screen, ready for zooming on
    const [k, t] = levelsFor(view.zoom);
    if (t === 0 && crossfade && k < KMAX) {
      const r = visibleRange(k + 1, 0);
      for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) add(k + 1, i, j, 2e12 + dist({ k: k + 1, i, j }));
    }
    const r = visibleRange(level(), 1);
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) add(level(), i, j, 3e12 + dist({ k: level(), i, j }));
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
    w.job = { ...job, gen, dpr: tileDpr };
    inflight.set(job.key, gen);
    w.postMessage({ type: 'tile', key: job.key, z: levelZoom(job.k), i: job.i, j: job.j, dpr: tileDpr, settings: { ...settings } });
  }
  updateBusy();
}

async function onTile(w, msg) {
  const job = w.job;
  w.job = null;
  if (inflight.get(job.key) === job.gen) inflight.delete(job.key);
  if (job.gen !== gen) {
    schedule(); // the settings changed meanwhile: this tile still needs doing
    return;
  }
  dispatch();
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(msg.pixels.buffer), TILE, TILE));
  if (job.gen === gen) {
    cache.set(job.key, { bmp, last: frame, born: performance.now() });
    requestRender();
  } else bmp.close();
  updateBusy();
}

function cacheMax() {
  const perLevel = (Math.ceil((W * tileDpr) / TILE) + 2) * (Math.ceil((H * tileDpr) / TILE) + 2);
  return Math.max(300, Math.min(1000, perLevel * 8, protect.size + perLevel * 4));
}

function evict() {
  const max = cacheMax();
  if (cache.size <= max) return;
  const entries = [...cache.entries()]
    .filter(([k, t]) => t.last < frame && !protect.has(k))
    .sort((a, b) => a[1].last - b[1].last);
  for (const [k, t] of entries.slice(0, cache.size - Math.floor(max * 0.85))) {
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
  soundFetchSoon();
}

function setTileDpr(d) {
  if (d === tileDpr) return;
  tileDpr = d; // tiles of the other resolution stay cached and serve as fallbacks
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

function tileRect(k, i, j, dpr = tileDpr) {
  const h = tileWorld(k, dpr), s = sCss();
  const x0 = ((i * h - view.cx) * s + W / 2) * DPR;
  const x1 = (((i + 1) * h - view.cx) * s + W / 2) * DPR;
  const y0 = ((view.cy - (j + 1) * h) * s + H / 2) * DPR;
  const y1 = ((view.cy - j * h) * s + H / 2) * DPR;
  const X0 = Math.round(x0), Y0 = Math.round(y0);
  return [X0, Y0, Math.round(x1) - X0, Math.round(y1) - Y0];
}

// Any cached image covering exactly the area of tile (k, i, j): this resolution,
// the other one (a 2× tile at level k−2 covers the same area), or a stale one.
function lookupArea(k, i, j) {
  for (const [kk, d] of [[k, tileDpr], [tileDpr === 1 ? k - 2 : k + 2, 3 - tileDpr]]) {
    const key = tkey(kk, i, j, d);
    const t = cache.get(key);
    if (t) { t.last = frame; return [t.bmp, kk, d]; }
    const b = stale.get(key);
    if (b) return [b, kk, d];
  }
  return null;
}

// Patch a missing tile with whatever cached tiles of nearby levels cover it,
// coarse first so finer ones end up on top.
function drawFallback(k, i, j, rect) {
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
      const hit = lookupArea(kk, ii, jj);
      if (hit) g.drawImage(hit[0], ...tileRect(hit[1], ii, jj, hit[2]));
    }
  }
  g.restore();
}

let fading = false;
// One level's tiles at opacity alpha. The base layer patches holes from other
// levels; the layer blended on top only draws what it has.
function drawLayer(k, alpha, base) {
  const r = visibleRange(k, 0);
  const now = performance.now();
  for (let j = r.j0; j <= r.j1; j++) {
    for (let i = r.i0; i <= r.i1; i++) {
      const key = tkey(k, i, j);
      const t = cache.get(key);
      const rect = tileRect(k, i, j);
      let a = 0;
      if (t) {
        t.last = frame;
        a = fadeMs > 0 ? Math.min(1, (now - t.born) / fadeMs) : 1;
        if (a < 1) fading = true;
      }
      if (base && a < 1) {
        g.globalAlpha = 1;
        const st = stale.get(key);
        if (st) g.drawImage(st, ...rect);
        else drawFallback(k, i, j, rect);
      }
      if (t) {
        g.globalAlpha = alpha * a;
        g.drawImage(t.bmp, ...rect);
      }
    }
  }
  g.globalAlpha = 1;
}

function render() {
  renderQueued = false;
  frame++;
  if (flight && flight.active) flightTick(performance.now());
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const [k, t] = levelsFor(view.zoom);
  fading = false;
  drawLayer(k, 1, true);
  if (t > 0) drawLayer(k + 1, t, false);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (ui.grid) drawGrid();
  drawMarkers();
  drawSound();
  evict();
  updateStatus();
  positionTooltip();
  if (flight && flight.capture) signalCapture(viewComplete(view));
  if (fading || (flash && performance.now() - flash.t0 < 1600) || (flight && flight.active) || sonifier.playing) requestRender();
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

function drawArc() {
  const data = arc.data;
  const vis = dotVisible(levelConfig());
  g.save();
  g.lineWidth = 1.2;
  g.strokeStyle = 'rgba(255, 190, 90, 0.55)';
  g.beginPath();
  data.curve.forEach(([x, y], n) => {
    const p = toScreen(x, y);
    if (n === 0) g.moveTo(p.x, p.y);
    else g.lineTo(p.x, p.y);
  });
  g.stroke();
  g.restore();
  for (const m of data.members) {
    if (!m.irreducible || m.t === 0 || !vis(m.a, m.d, m.cls, m.L)) continue;
    const p = toScreen(m.x, m.y);
    if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) continue;
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255, 200, 120, 0.8)';
    g.beginPath();
    g.arc(p.x, p.y, Math.max(5, dotScreenRadius(m.L, m.d, m.cls) + 2.5), 0, 2 * Math.PI);
    g.stroke();
    g.restore();
  }
  const c = toScreen(data.center.x, data.center.y);
  const Lq = data.q.reduce((acc, v) => acc + Math.abs(v), 0);
  ring(c.x, c.y, Math.max(10, dotScreenRadius(Lq, data.q.length - 1, COMPLEX) + 6), 'rgba(255, 190, 90, 0.95)', [3, 4]);
}

function drawMarkers() {
  if (document.body.classList.contains('clean')) return;
  if (selected && arc && arc.show && arc.data) drawArc();
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

let arcTimer = 0;
function viewChanged() {
  schedule();
  requestRender();
  saveHashSoon();
  soundFetchSoon();
  // which arcs show depends on the zoom: look again once it has changed a lot
  if (selected && arc && Math.abs(view.zoom - arc.zoom) > 1.5) {
    clearTimeout(arcTimer);
    arcTimer = setTimeout(() => { if (selected && arc && Math.abs(view.zoom - arc.zoom) > 1.5) renderInfo(); }, 400);
  }
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
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  if (flight && flight.active) {
    flight.path = makePath(resolveViews(flight.spec.views), W, S0_CSS);
    setTileDpr(flight.dpr);
    requestRender();
  } else {
    setTileDpr(naturalTileDpr());
    viewChanged();
  }
}

// ---------------------------------------------------------------------------
// Flights: a smooth zoom through a list of views, played like a video
// ---------------------------------------------------------------------------
// Tiles are computed ahead along the path. Playback slows down smoothly (and
// holds if it must) when they can't keep up, rather than showing holes.

let flight = null;        // the flight playing (or just finished)
let pendingFlight = null; // a flight from the link, waiting for Play
const FLIGHT_LOOKAHEAD = 6; // seconds of flight computed ahead
const FLIGHT_BUFFER = 2;    // seconds that must be ready to play at full speed

function resolveViews(views) {
  const o = resetView();
  return views.map((v) => (v.overview ? { x: o.cx, y: o.cy, zoom: o.zoom } : v));
}

const flightView = (f, t) => f.path.viewAt(f.path.S * ease(f.T > 0 ? t / f.T : 1));

// spec: {views: [{x, y, zoom} | {overview: true}], duration (s, 0 = automatic), quality}
function startFlight(spec, opts = {}) {
  stopAnim();
  if (sonifier.playing || sound.want) soundToggle(false); // the notes are for the view it leaves
  pendingFlight = null;
  $('flight-card').hidden = true;
  $('flight-end').hidden = true;
  const path = makePath(resolveViews(spec.views), W, S0_CSS);
  const capture = !!opts.capture;
  flight = {
    active: true, spec, path, T: spec.duration || autoDuration(path.S), t: 0,
    last: performance.now(), start: performance.now(), lastPlan: 0, stall: 0,
    phase: capture ? 'play' : 'buffer', rate: 1, capture, paused: false,
    // standard quality computes 1× tiles even on high-density screens: 4× less work
    dpr: spec.quality === 'sharp' ? naturalTileDpr() : 1,
  };
  fadeMs = capture ? 0 : 180;
  document.body.classList.add('clean', 'flying');
  setHover(null);
  Object.assign(view, flightView(flight, 0));
  setTileDpr(flight.dpr);
  if (capture && window.__pixeldif) window.__pixeldif.gl = true; // see signalCapture
  schedule();
  requestRender();
}

function planFlight(add) {
  const f = flight;
  const keep = new Set();
  const t0 = f.phase === 'buffer' ? 0 : f.t;
  const span = Math.max(0, Math.min(FLIGHT_LOOKAHEAD, f.T - t0));
  const steps = Math.max(1, Math.ceil(span * 12));
  for (let n = 0; n <= steps && keep.size < 500; n++) {
    const tau = t0 + (span * n) / steps;
    for (const q of tilesOf(flightView(f, tau))) {
      keep.add(tkey(q.k, q.i, q.j));
      add(q.k, q.i, q.j, (tau - t0) * 1e3 + q.rank);
    }
  }
  protect = keep;
}

// How many seconds of flight from t on can be drawn completely (up to span).
function readyHorizon(f, t, span) {
  const steps = 24;
  for (let n = 0; n <= steps; n++) {
    const tau = Math.min(f.T, t + (span * n) / steps);
    if (!viewComplete(flightView(f, tau))) return tau - t;
    if (tau >= f.T) return span;
  }
  return span;
}

function readyFraction(f, t0, t1) {
  const seen = new Set();
  let have = 0;
  for (let tau = t0; tau <= t1 + 1e-9; tau += 1 / 15) {
    for (const q of tilesOf(flightView(f, tau))) {
      const key = tkey(q.k, q.i, q.j);
      if (seen.has(key)) continue;
      seen.add(key);
      if (cache.has(key)) have++;
    }
  }
  return seen.size ? have / seen.size : 1;
}

function flightTick(now) {
  const f = flight;
  const dt = Math.min(0.1, Math.max(0, (now - f.last) / 1000));
  f.last = now;
  if (f.capture) {
    // frame-locked recording: the recorder's clock only moves on complete frames
    f.t = Math.min(f.T, (now - f.start) / 1000);
  } else if (f.phase === 'buffer') {
    const goal = Math.min(f.T, FLIGHT_BUFFER);
    const frac = readyFraction(f, 0, goal);
    if (frac >= 1) {
      f.phase = 'play';
      flightStatus('');
    } else flightStatus(`Preparing the flight… ${Math.floor(frac * 100)}%`);
  } else if (!f.paused) {
    const h = readyHorizon(f, f.t, FLIGHT_BUFFER);
    const target = h >= FLIGHT_BUFFER ? 1 : (h / FLIGHT_BUFFER) ** 2;
    f.rate += (target - f.rate) * (1 - Math.exp(-dt / 0.35));
    if (h <= 0) f.rate = 0; // this frame isn't computed yet: hold rather than show holes
    f.t = Math.min(f.T, f.t + dt * f.rate);
    f.stall = f.rate < 0.03 ? f.stall + dt : 0;
    flightStatus(f.stall > 0.6 ? 'Computing…' : '');
  }
  Object.assign(view, flightView(f, f.t));
  // re-plan every few frames (counted in frames: a recorder's clock stands still
  // while a frame waits), and at once if the workers have run dry
  if (frame - f.lastPlan >= 8 || (queue.length === 0 && !pool.some((w) => w.job))) {
    f.lastPlan = frame;
    schedule();
  }
  if (f.t >= f.T && f.phase === 'play') finishFlight();
}

function finishFlight() {
  const f = flight;
  f.active = false;
  Object.assign(view, flightView(f, f.T));
  if (f.capture && window.__pixeldif) window.__pixeldif.gl = false;
  fadeMs = 180;
  protect = new Set();
  flightStatus('');
  document.body.classList.remove('flying');
  if (!f.capture) $('flight-end').hidden = false;
  requestRender();
}

// The viewer takes over: back to exploring, with the controls.
function stopFlight() {
  if (!flight && !pendingFlight) return;
  if (flight && flight.capture && window.__pixeldif) window.__pixeldif.gl = false;
  flight = null;
  pendingFlight = null;
  fadeMs = 180;
  protect = new Set();
  flightStatus('');
  $('flight-card').hidden = true;
  $('flight-end').hidden = true;
  document.body.classList.remove('flying', 'clean');
  setTileDpr(naturalTileDpr());
  viewChanged();
}

function togglePause() {
  if (!flight || !flight.active || flight.capture) return;
  flight.paused = !flight.paused;
  flightStatus(flight.paused ? 'Paused · space to resume' : '');
}

function flightStatus(text) {
  const el = $('flight-status');
  if (el.textContent !== text) el.textContent = text;
  el.hidden = !text;
}

// Tells pixeldif's recorder when a frame is complete. Like a WebGL engine it then
// captures it and advances its virtual clock; until then it waits.
function signalCapture(complete) {
  const st = window.__pixeldif;
  if (!st) return;
  if (!flight || !flight.active || complete) st.drawn = true;
  else st.waits = 0;
}

function showFlightCard(spec) {
  pendingFlight = spec;
  const end = spec.views[spec.views.length - 1];
  const T = spec.duration || autoDuration(makePath(resolveViews(spec.views), W, S0_CSS).S);
  const mag = end.overview ? '' : ` at ${fmtMag(Math.pow(2, end.zoom))}`;
  $('flight-desc').textContent = end.overview
    ? `${spec.views.length} views, ${Math.round(T)} s`
    : `To ${Alg.formatComplex(end.x, end.y, 8)}${mag} · ${Math.round(T)} s`;
  $('flight-card').hidden = false;
  document.body.classList.add('clean');
}
$('flight-play').onclick = () => { if (pendingFlight) startFlight(pendingFlight); };
$('flight-skip').onclick = () => stopFlight();
$('flight-replay').onclick = () => { if (flight) startFlight(flight.spec); };
$('flight-explore').onclick = () => stopFlight();

// ---------------------------------------------------------------------------
// Pointer, wheel and keyboard
// ---------------------------------------------------------------------------

const pointers = new Map();
let drag = null, pinch = null;

canvas.addEventListener('pointerdown', (e) => {
  stopAnim();
  if (flight || pendingFlight) stopFlight();
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
  if (flight || pendingFlight) stopFlight();
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
  if (flight && flight.active && e.key === ' ') { e.preventDefault(); togglePause(); return; }
  if ((flight || pendingFlight) && e.key !== 'v' && e.key !== 'V') {
    stopFlight();
    if (e.key === 'Escape') { e.preventDefault(); return; }
  }
  const s = sCss();
  if (e.key === 'v' || e.key === 'V') toggleControls();
  else if (e.key === 'l' || e.key === 'L') soundToggle();
  else if (e.key === '+' || e.key === '=') animateTo(view.cx, view.cy, view.zoom + 1, 300);
  else if (e.key === '-' || e.key === '_') animateTo(view.cx, view.cy, view.zoom - 1, 300);
  else if (e.key === 'ArrowLeft') animateTo(view.cx - W / 5 / s, view.cy, view.zoom, 250);
  else if (e.key === 'ArrowRight') animateTo(view.cx + W / 5 / s, view.cy, view.zoom, 250);
  else if (e.key === 'ArrowUp') animateTo(view.cx, view.cy + H / 5 / s, view.zoom, 250);
  else if (e.key === 'ArrowDown') animateTo(view.cx, view.cy - H / 5 / s, view.zoom, 250);
  else if (e.key === '/') { e.preventDefault(); $('search-input').focus(); }
  else if (e.key === 'Escape') {
    if (!$('help').hidden) $('help').hidden = true;
    else if (sound.picking) setPicking(false);
    else if (!$('settings').hidden) toggleSettings(false);
    else if (!$('sound').hidden) toggleSound(false);
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
  if (sound.picking) { pickCentre(px, py); return; }
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

// ---- arcs: the family p + t·v the selected dot belongs to (see arcs.js) ----

let arc = null; // {sel, cands, index, data, show}
let arcShow = true;

const levelConfig = () => makeConfig(settings, sCss(levelZoom(level())), tileDpr);

// Would a dot with this polynomial be drawn at the current zoom and settings?
function dotVisible(cfg) {
  return (a, d, cls, L) => d >= 1 && d <= settings.maxDeg
    && (settings.numbers !== 'integers' || a[d] === 1)
    && !(settings.numbers !== 'integers' && settings.colorMode === 'lead' && !settings.highLead && a[d] >= 5)
    && L <= maxLength(cfg, d, cls);
}

function computeArc() {
  const a = selected.coeffs, alpha = selectionInfo().roots[selected.idx];
  const scale = sCss();
  const cands = findArcs(a, alpha.x, alpha.y, { scale, visible: dotVisible(levelConfig()), viewR: Math.max(W, H) / 2 / scale });
  arc = { sel: selected, zoom: view.zoom, cands, index: 0, data: null, show: arcShow };
  if (cands.length) arc.data = traceArc(a, cands[0].v, alpha.x, alpha.y, { scale });
}

function arcSection(a) {
  if (!arc.data) {
    return `<p>No arc of dots runs through this number at this zoom. (Arcs show up when zooming in near a simpler number.)</p>`;
  }
  const { v, q, s, center } = arc.data;
  const sameAsQ = s.length === 1 && s[0] === 1;
  const vis = dotVisible(levelConfig());
  const qL = q.reduce((acc, c) => acc + Math.abs(c), 0);
  const gammaDrawn = vis(q, q.length - 1, center.y === 0 ? REAL : COMPLEX, qL);
  const why = settings.numbers === 'integers' && q[q.length - 1] !== 1 ? ' (it isn’t drawn: it is not an algebraic integer)'
    : q.length - 1 > settings.maxDeg ? ' (it isn’t drawn: its degree is above Max degree)' : '';
  const shown = arc.data.members
    .filter((m) => m.irreducible && vis(m.a, m.d, m.cls, m.L))
    .sort((x, y) => Math.abs(x.t) - Math.abs(y.t))
    .slice(0, 9)
    .sort((x, y) => x.t - y.t);
  const rows = shown.map((m) => `<tr class="${m.t === 0 ? 'self' : ''}" data-member="${m.t}"><td>${m.t}</td><td>${tex(Alg.polyTex(m.a))}</td></tr>`).join('');
  const others = arc.cands.length > 1 ? `<button class="text-btn" id="arc-next">Another arc (${arc.index + 1}/${arc.cands.length})</button>` : '';
  return `
      <p>This dot is on an arc of dots: the family ${tex('p(x) + t\\,v(x)')}, ${tex('t \\in \\mathbb{Z}')}, with</p>
      <div class="math-line">${tex(`v(x) = ${Alg.polyTex(v)}`)}</div>
      <p>${sameAsQ ? 'the minimal polynomial' : `a multiple of the minimal polynomial ${tex(`q(x) = ${Alg.polyTex(q)}`)}`} of ${tex('\\gamma')} ≈ ${Alg.formatComplex(center.x, center.y, 9)}, ${gammaDrawn ? 'the dot the arc circles' : `the point the arc circles${why}`} (dashed ring).
      The members are where ${tex('p/v = -t')}. Near ${tex('\\gamma')}, ${tex('p/v')} has a pole, so they lie on a circle through ${tex('\\gamma')} and crowd towards it.
      Every member has the same value at ${tex('\\gamma')}, ${tex('(p + t\\,v)(\\gamma) = p(\\gamma)')}: the arc is ${sameAsQ ? 'the residue class of ' + tex('p') + ' modulo the ideal ' + tex('(q)') : 'a line in the residue class of ' + tex('p') + ' modulo ' + tex('(q)')}.
      Gaps are members that factor or have a common divisor.</p>
      <table class="arc-members">${rows}</table>
      <div class="actions">
        <button class="text-btn" id="arc-toggle">${arc.show ? 'Hide arc' : 'Show arc'}</button>
        <button class="text-btn" id="arc-gamma">Select ${tex('\\gamma')}</button>
        ${others}
      </div>`;
}

function bindArcSection(body) {
  if (!arc || !arc.data) return;
  for (const row of body.querySelectorAll('[data-member]')) {
    row.onclick = () => {
      const m = arc.data.members.find((mm) => mm.t === +row.dataset.member);
      if (m && m.t !== 0) select({ coeffs: m.a, idx: m.idx });
    };
  }
  $('arc-toggle').onclick = () => {
    arcShow = arc.show = !arc.show;
    $('arc-toggle').textContent = arc.show ? 'Hide arc' : 'Show arc';
    requestRender();
  };
  $('arc-gamma').onclick = () => {
    const { q, center } = arc.data;
    const r = polyRoots(q, q.length - 1);
    let idx = 0, bd = Infinity;
    for (let k = 0; k < q.length - 1; k++) {
      const d = Math.hypot(r[2 * k] - center.x, r[2 * k + 1] - center.y);
      if (d < bd) { bd = d; idx = k; }
    }
    select({ coeffs: q, idx });
  };
  if ($('arc-next')) {
    $('arc-next').onclick = () => {
      const a = selected.coeffs, alpha = selectionInfo().roots[selected.idx];
      arc.index = (arc.index + 1) % arc.cands.length;
      arc.data = traceArc(a, arc.cands[arc.index].v, alpha.x, alpha.y, { scale: sCss() });
      renderInfo(true);
      requestRender();
    };
  }
}

function renderInfo(keepArc = false) {
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

  if (!keepArc || !arc || arc.sel !== selected) computeArc();
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
      <h3>Arc</h3>
      ${arcSection(a)}
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
      <button class="text-btn" id="act-fly">Fly here</button>
      <button class="text-btn" id="act-center">Centre</button>
      <button class="text-btn" id="act-copy">Copy polynomial</button>
      <button class="text-btn" id="act-link">Copy link</button>
    </div>`;
  const body = $('info-body');
  body.innerHTML = html;
  renderTexIn(body);
  bindArcSection(body);
  for (const b of body.querySelectorAll('[data-conj]')) {
    b.onclick = () => {
      const k = +b.dataset.conj;
      select({ coeffs: a, idx: k });
      const c = selectionInfo().roots[k];
      focusOn(c.x, c.y, view.zoom, 600);
    };
  }
  $('act-center').onclick = () => focusOn(alpha.x, alpha.y, view.zoom, 500);
  $('act-fly').onclick = () => {
    // a flight from the overview to this number at the current zoom, also put in the editor
    editor.views = [{ x: alpha.x, y: alpha.y, zoom: Math.max(view.zoom, 1) }];
    editor.overview = true;
    startFlight(editorSpec());
  };
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
  if (open) { toggleFlights(false); toggleSound(false); }
  el.hidden = !open;
  $('btn-settings').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('settings-open', open);
}
$('btn-settings').onclick = () => toggleSettings();

// ---------------------------------------------------------------------------
// Flight editor
// ---------------------------------------------------------------------------

const FLIGHTS_KEY = 'algebraic-numbers.flights';
const editor = { overview: true, views: [], duration: 0, quality: 'standard' };

function editorSpec() {
  const views = (editor.overview ? [{ overview: true }] : []).concat(editor.views);
  return views.length >= 2 ? { views, duration: editor.duration, quality: editor.quality } : null;
}

function toggleFlights(open) {
  const el = $('flights');
  open = open ?? el.hidden;
  if (open) {
    toggleSettings(false);
    toggleSound(false);
    renderEditor();
  }
  el.hidden = !open;
  $('btn-flights').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('settings-open', open);
}
$('btn-flights').onclick = () => toggleFlights();

function renderEditor() {
  const rows = [];
  if (editor.overview) rows.push('<li class="kf fixed"><span>Overview</span></li>');
  editor.views.forEach((v, n) => rows.push(
    `<li class="kf"><button class="kf-go" data-go="${n}" title="Go to this view">${Alg.formatComplex(v.x, v.y, 7)} <span class="sub">${fmtMag(Math.pow(2, v.zoom))}</span></button>`
    + `<button class="icon-btn" data-del="${n}" title="Remove" aria-label="Remove">×</button></li>`));
  if (!editor.views.length) rows.push('<li class="kf empty">Zoom in to something you like, then add it here.</li>');
  const list = $('kf-list');
  list.innerHTML = rows.join('');
  for (const b of list.querySelectorAll('[data-go]')) {
    b.onclick = () => { const v = editor.views[+b.dataset.go]; animateTo(v.x, v.y, v.zoom, 700); };
  }
  for (const b of list.querySelectorAll('[data-del]')) {
    b.onclick = () => { editor.views.splice(+b.dataset.del, 1); renderEditor(); };
  }
  const spec = editorSpec();
  const auto = spec ? Math.round(autoDuration(makePath(resolveViews(spec.views), W, S0_CSS).S)) : 0;
  $('fl-dur').value = editor.duration;
  $('fl-dur-out').textContent = editor.duration ? `${editor.duration} s` : spec ? `auto (${auto} s)` : 'auto';
  $('kf-overview').checked = editor.overview;
  for (const b of $('fl-quality').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === editor.quality));
  for (const id of ['fl-play', 'fl-link', 'fl-save']) $(id).disabled = !spec;
  renderSaved();
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(FLIGHTS_KEY) || '[]'); } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(FLIGHTS_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

function renderSaved() {
  const list = loadSaved();
  const el = $('fl-saved');
  el.innerHTML = list.length
    ? list.map((f, n) => `<div class="saved"><span class="name" title="${esc(f.name)}">${esc(f.name)}</span>`
      + `<button class="text-btn" data-sp="${n}" title="Play">▶</button><button class="text-btn" data-sl="${n}">Link</button>`
      + `<button class="icon-btn" data-sd="${n}" title="Delete" aria-label="Delete">×</button></div>`).join('')
    : '<p class="hint">Saved flights stay in this browser.</p>';
  for (const b of el.querySelectorAll('[data-sp]')) b.onclick = () => playLink(list[+b.dataset.sp].link);
  for (const b of el.querySelectorAll('[data-sl]')) b.onclick = (e) => copyText(list[+b.dataset.sl].link, e.target);
  for (const b of el.querySelectorAll('[data-sd]')) {
    b.onclick = () => { list.splice(+b.dataset.sd, 1); storeSaved(list); renderSaved(); };
  }
}

// Play a flight link, taking on its settings.
function playLink(link) {
  const p = new URLSearchParams(link.split('#')[1] || '');
  const spec = parseFlight(p);
  if (!spec) return;
  let changed = false;
  for (const [k, short] of Object.entries(HASH_KEYS)) {
    const def = DEFAULT_SETTINGS[k], raw = p.get(short);
    let v = def;
    if (raw !== null) v = typeof def === 'boolean' ? raw === '1' : typeof def === 'number' ? parseFloat(raw) : raw;
    if (v !== settings[k] && !(typeof v === 'number' && !Number.isFinite(v))) { settings[k] = v; changed = true; }
  }
  if (changed) { syncSettingsUI(); updateLegend(); invalidate(); }
  toggleFlights(false);
  startFlight(spec);
}

$('kf-add').onclick = () => {
  editor.views.push({ x: view.cx, y: view.cy, zoom: view.zoom });
  renderEditor();
};
$('kf-overview').onchange = (e) => { editor.overview = e.target.checked; renderEditor(); };
$('fl-dur').oninput = (e) => { editor.duration = +e.target.value; renderEditor(); };
$('fl-quality').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) { editor.quality = b.dataset.value; renderEditor(); }
};
$('fl-play').onclick = () => { const spec = editorSpec(); if (spec) { toggleFlights(false); startFlight(spec); } };
$('fl-link').onclick = (e) => { const spec = editorSpec(); if (spec) copyText(flightLink(spec), e.target); };
$('fl-save').onclick = () => {
  const spec = editorSpec();
  if (!spec) return;
  const list = loadSaved();
  const end = spec.views[spec.views.length - 1];
  const name = $('fl-name').value.trim() || (end.overview ? 'Flight' : `${Alg.formatComplex(end.x, end.y, 6)} · ${fmtMag(Math.pow(2, end.zoom))}`);
  list.unshift({ name, link: flightLink(spec), created: Date.now() });
  storeSaved(list);
  $('fl-name').value = '';
  renderSaved();
};

// The panel folds away into a small button (remembered in this browser).
const COLLAPSED_KEY = 'algebraic-numbers.panel-collapsed';
function setPanelCollapsed(collapsed) {
  if (collapsed) { toggleSettings(false); toggleFlights(false); toggleSound(false); }
  $('brand').hidden = collapsed;
  $('brand-mini').hidden = !collapsed;
  try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
}
$('btn-minimize').onclick = () => setPanelCollapsed(true);
$('brand-mini').onclick = () => setPanelCollapsed(false);
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
  $('status-zoom').textContent = `zoom ${fmtMag(Math.pow(2, view.zoom))}${view.zoom >= MAX_ZOOM ? ' (max)' : ''}`;
}

function fmtMag(mag) {
  if (mag < 1000) return `${mag < 10 ? mag.toFixed(2) : mag.toFixed(0)}×`;
  const e = Math.floor(Math.log10(mag));
  return `${(mag / 10 ** e).toFixed(1)}·10${String(e).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]).join('')}×`;
}

// ---------------------------------------------------------------------------
// URL hash: view, settings and selection
// ---------------------------------------------------------------------------

const HASH_KEYS = { maxDeg: 'deg', numbers: 'num', colorMode: 'col', highLead: 'hl', dotScale: 'ds', detail: 'det', falloff: 'k', exposure: 'ex', glow: 'gl' };

function settingsParams() {
  const p = new URLSearchParams();
  for (const [k, short] of Object.entries(HASH_KEYS)) {
    if (settings[k] !== DEFAULT_SETTINGS[k]) p.set(short, typeof settings[k] === 'boolean' ? (settings[k] ? '1' : '0') : String(+settings[k] === settings[k] ? +settings[k].toFixed(4) : settings[k]));
  }
  return p;
}

// A link that opens as a flight.
function flightLink(spec) {
  const p = settingsParams();
  p.set('fly', encodeViews(spec.views));
  if (spec.duration) p.set('dur', String(Math.round(spec.duration)));
  if (spec.quality === 'sharp') p.set('q', 'sharp');
  return `${location.origin}${location.pathname}#${p.toString()}`;
}

function parseFlight(p) {
  const views = p.has('fly') ? decodeViews(p.get('fly')) : null;
  if (!views) return null;
  const dur = parseFloat(p.get('dur'));
  return { views, duration: Number.isFinite(dur) && dur > 0 ? Math.min(600, dur) : 0, quality: p.get('q') === 'sharp' ? 'sharp' : 'standard' };
}

function saveHash() {
  if (pendingFlight || (flight && flight.active)) return; // keep the flight link
  const p = new URLSearchParams();
  const prec = Math.max(6, Math.ceil(Math.log10(sCss())) + 4);
  p.set('x', view.cx.toPrecision(Math.min(17, prec)));
  p.set('y', view.cy.toPrecision(Math.min(17, prec)));
  p.set('z', view.zoom.toFixed(3));
  for (const [k, v] of settingsParams()) p.set(k, v);
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
  const spec = parseFlight(p);
  if (spec) {
    const first = resolveViews(spec.views)[0];
    Object.assign(view, { cx: first.x, cy: first.y, zoom: first.zoom });
    return { flight: spec };
  }
  if (sel) {
    const m = sel.match(/^(-?\d+(?:_-?\d+)+)\.(\d+)$/);
    if (m) {
      const coeffs = m[1].split('_').map(Number);
      const idx = +m[2];
      if (coeffs.length >= 2 && coeffs.length <= 13 && idx < coeffs.length - 1 && coeffs[coeffs.length - 1] > 0) return { sel: { coeffs, idx } };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Listen (the sound player in js/sound.js)
// ---------------------------------------------------------------------------
// A worker of its own lists every dot on screen, so the hover queries stay quick.

const sonifier = new Sonifier();
const SOUND_KEY = 'algebraic-numbers.sound.2';
const SOUND_MAX_DOTS = 8000;
const sound = {
  mode: 'ring', exp: 2, pitch: 'value', slow: true,
  cycles: 8, cycleSec: 14.9, sweepSec: 20, f0: 58.27, maxH: 24, minPx: 0.6, volume: 0.6,
  centre: { x: 0, y: 0, coeffs: [0, 1] }, centreText: '0',
  dots: null, req: null, got: null, res: null, dirty: true, want: false, picking: false,
};
const SOUND_SAVED = ['mode', 'exp', 'pitch', 'slow', 'cycles', 'cycleSec', 'sweepSec', 'f0', 'maxH', 'minPx', 'volume', 'centreText'];

const gcdInt = (a, b) => {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
};

function rationalCentre(r, s) {
  if (s < 0) { r = -r; s = -s; }
  const d = gcdInt(r, s) || 1;
  r /= d;
  s /= d;
  return { x: r / s, y: 0, coeffs: [-r, s] };
}

// "0", "1/2", "0.25", "x^2+1" (its root nearest the middle of the screen), "0.5+0.87i"
function parseCentre(text) {
  const t = text.trim().replace(/[−–]/g, '-').replace(/½/g, '1/2');
  const m = t.match(/^([+-]?\d+)(?:\s*\/\s*(\d+))?$/);
  if (m && (!m[2] || +m[2] > 0)) return rationalCentre(+m[1], m[2] ? +m[2] : 1);
  const dm = t.match(/^[+-]?\d*\.(\d{1,6})$/);
  if (dm) return rationalCentre(Math.round(+t * 10 ** dm[1].length), 10 ** dm[1].length);
  const poly = Alg.parsePolynomial(t);
  if (poly) {
    let best = null;
    for (const f of Alg.factorOverZ(poly)) {
      const d = f.length - 1;
      if (d < 1) continue;
      const r = polyRoots(f, d);
      for (let k = 0; k < d; k++) {
        const dist = Math.hypot(r[2 * k] - view.cx, r[2 * k + 1] - view.cy);
        if (!best || dist < best.dist) best = { dist, x: r[2 * k], y: r[2 * k + 1], coeffs: f };
      }
    }
    if (best) return best.coeffs.length === 2 ? rationalCentre(-best.coeffs[0], best.coeffs[1]) : { x: best.x, y: best.y, coeffs: best.coeffs };
  }
  const p = Alg.parseComplex(t);
  return p ? { x: p.x, y: p.y, coeffs: null } : null;
}

function centreText(c) {
  if (isRationalCentre(c)) return c.coeffs[1] === 1 ? String(-c.coeffs[0]) : `${-c.coeffs[0]}/${c.coeffs[1]}`;
  if (c.coeffs) return Alg.polyText(c.coeffs, 'x', true).replace(/ /g, '');
  return Alg.formatComplex(c.x, c.y, 8);
}

function centreLabel(c) {
  if (isRationalCentre(c)) return '· rational';
  return `≈ ${Alg.formatComplex(c.x, c.y, 5)}`;
}

const fmtSound = {
  cycles: (v) => String(v),
  cycleSec: (v) => `${(+v).toFixed(1)} s`,
  sweepSec: (v) => `${v} s`,
  f0: (v) => `${(+v).toFixed(1)} Hz`,
  maxH: (v) => String(v),
  minPx: (v) => `${(+v).toFixed(1)} px`,
  volume: (v) => `${Math.round(v * 100)}%`,
};

function syncSoundUI() {
  for (const [id, key] of [['snd-mode', 'mode'], ['snd-exp', 'exp'], ['snd-pitch', 'pitch']]) {
    for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(String(sound[key]) === b.dataset.value));
  }
  for (const inp of document.querySelectorAll('input[data-snd]')) {
    const key = inp.dataset.snd;
    if (document.activeElement !== inp) inp.value = sound[key];
    document.querySelector(`output[data-snd-out="${key}"]`).textContent = fmtSound[key](sound[key]);
  }
  const ring = sound.mode === 'ring';
  const cyc = ring && sound.slow;
  $('snd-slow-row').hidden = !ring;
  $('snd-slow').checked = sound.slow;
  $('snd-exp-row').hidden = !cyc;
  $('snd-cycles-row').hidden = !cyc;
  $('snd-cyclesec-row').hidden = !cyc;
  $('snd-sweepsec-row').hidden = cyc;
  if (document.activeElement !== $('snd-centre')) $('snd-centre').value = sound.centreText;
  $('snd-centre-out').textContent = centreLabel(sound.centre);
  const on = sonifier.playing || sound.want;
  $('snd-play').textContent = on ? '■ Stop' : '▶ Play';
  $('snd-play').classList.toggle('playing', on);
  $('snd-pick').classList.toggle('on', sound.picking);
  $('btn-sound').classList.toggle('on', on);
}

function saveSound() {
  try { localStorage.setItem(SOUND_KEY, JSON.stringify(Object.fromEntries(SOUND_SAVED.map((k) => [k, sound[k]])))); } catch { /* private mode */ }
}

function loadSound() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SOUND_KEY)); } catch { /* private mode */ }
  if (!saved || typeof saved !== 'object') return;
  for (const k of SOUND_SAVED) if (typeof saved[k] === typeof sound[k]) sound[k] = saved[k];
  const c = parseCentre(sound.centreText);
  if (c) sound.centre = c;
  else sound.centreText = centreText(sound.centre);
}

const soundActive = () => !$('sound').hidden || sonifier.playing || sound.want;

let sWorker = null, sBusy = false, sAgain = false, sTimer = 0;
function soundFetchSoon(ms = 300) {
  sound.dirty = true;
  if (!soundActive()) return;
  clearTimeout(sTimer);
  sTimer = setTimeout(soundFetch, ms);
}

// Every dot on screen at the level the tiles are drawn at, biggest first.
function soundFetch() {
  clearTimeout(sTimer);
  if (flight && flight.active) return;
  if (sBusy) { sAgain = true; return; }
  if (!sWorker) {
    sWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    sWorker.onmessage = onSoundDots;
  }
  const z = levelZoom(level());
  const k = Math.pow(2, view.zoom - z);
  const a = toWorld(0, 0), b = toWorld(W, H);
  const rect = { x0: a.x, x1: b.x, y0: b.y, y1: a.y };
  sound.req = { rect, k, minPx: sound.minPx };
  sound.dirty = false;
  sBusy = true;
  sWorker.postMessage({
    type: 'dots', id: 0, ...rect, z, dpr: tileDpr, settings: { ...settings },
    minCss: sound.minPx / k, max: SOUND_MAX_DOTS,
  });
  if (!sound.res) soundInfo('Finding the dots on screen…');
}

function onSoundDots(ev) {
  sBusy = false;
  sound.dots = ev.data.dots;
  sound.got = sound.req;
  rebuildSound();
  if (sAgain) { sAgain = false; soundFetch(); }
}

function rebuildSound() {
  if (!sound.dots) return;
  const got = sound.got;
  sound.res = sweepEvents(sound.dots, {
    mode: sound.mode, centre: sound.centre, exp: sound.exp, pitch: sound.pitch, slow: sound.slow,
    rect: got.rect, sizeK: got.k, minPx: sound.minPx, maxH: sound.maxH,
    cycles: sound.cycles, cycleSec: sound.cycleSec, sweepSec: sound.sweepSec,
  });
  sonifier.setEvents(sound.res.events, sound.res.duration, sound.f0, sound.volume);
  if (sound.want && !sonifier.playing) sonifier.play().then(syncSoundUI);
  soundInfo();
  syncSoundUI();
  requestRender();
}

const fmtH = (h) => (Number.isInteger(h) ? String(h) : h.toFixed(2));

function soundInfo(text) {
  const el = $('snd-info');
  if (text !== undefined) { el.textContent = text; return; }
  const r = sound.res;
  if (!r) { el.textContent = ''; return; }
  if (!r.events.length) {
    el.textContent = 'Nothing to play here. Zoom out, lower “Smallest dot that plays” or raise “Highest harmonic”.';
    return;
  }
  const hs = [...new Set(r.events.map((e) => (r.rational ? e.h : Math.round(e.h * 100) / 100)))].sort((a, b) => a - b);
  const parts = [`${r.events.length.toLocaleString()} notes from ${sound.dots.length.toLocaleString()} dots`];
  parts.push(r.rational
    ? `harmonics ${hs[0]}–${hs[hs.length - 1]} (${hs.length} different)`
    : `${hs.length} different pitches, ${fmtH(hs[0])}–${fmtH(hs[hs.length - 1])} × base`);
  const gm = r.geom;
  if (r.cycles) {
    const rEnd = Math.pow(gm.u1, -1 / gm.d);
    parts.push(`${r.cycles} cycle${r.cycles > 1 ? 's' : ''} in to radius ${+rEnd.toPrecision(2)}, ${r.duration.toFixed(1)} s loop`);
  } else parts.push(`${r.duration.toFixed(1)} s loop`);
  let s = `${parts.join(' · ')}.`;
  if (r.maxCycles && r.cycles === r.maxCycles && sound.cycles > r.cycles) s += ' The centre is off screen, so the ring stops once it has crossed the screen.';
  if (gm.steady) s += ' Steady speed: the rhythm speeds up as the ring closes in.';
  else if (r.cycle && r.cycle.kind === 'exact') s += ' In each cycle the dots of value F play exactly F times.';
  else if (r.cycle && r.cycle.kind === 'asymptotic') s += ` One cycle is |q′(γ)| = ${+r.cycle.unit.toPrecision(3)} in 1/r, so the families keep time with their pitch (more exactly further in).`;
  if (sound.dots.length >= SOUND_MAX_DOTS) s += ` Only the biggest ${SOUND_MAX_DOTS.toLocaleString()} dots play.`;
  const c = sound.centre;
  if (sound.pitch === 'value' && !r.rational) s += ' The centre isn’t rational, so the pitches aren’t whole multiples of the base: it sounds more like a drum or a bell.';
  if (sound.mode === 'ring' && sound.slow && c.coeffs) {
    const want = c.coeffs.length === 2 ? 2 : 1;
    if (sound.exp !== want) s += ` The families round this centre are evenly spaced with clock 1/r${want === 2 ? '²' : ''}.`;
  }
  el.textContent = s;
}

async function soundToggle(on = !(sonifier.playing || sound.want)) {
  if (on) {
    if (flight || pendingFlight) stopFlight();
    sonifier.unlock(); // browsers only let audio start inside a click or key press
    sound.want = true;
    if (sound.res && sound.res.events.length) await sonifier.play();
    if (!sound.got || sound.dirty) soundFetch();
  } else {
    sound.want = false;
    sonifier.stop();
  }
  syncSoundUI();
  requestRender();
}

// The ring clock that spaces the families round c evenly: 1/r² at a rational
// centre (quadratics form fans p + n·q²), 1/r round an algebraic one (p + n·q).
function setCentre(c, text, exp = c.coeffs ? (c.coeffs.length === 2 ? 2 : 1) : sound.exp) {
  sound.centre = c;
  sound.exp = exp;
  sound.centreText = text ?? centreText(c);
  saveSound();
  syncSoundUI();
  rebuildSound();
}

function setPicking(on) {
  sound.picking = on;
  document.body.classList.toggle('picking', on);
  syncSoundUI();
  if (on) soundInfo('Click a dot on the map to put the centre there.');
  else soundInfo();
}

function pickCentre(px, py) {
  setPicking(false);
  postQuery(px, py, (hit) => {
    if (hit) setCentre(hit.d === 1 ? rationalCentre(-hit.coeffs[0], hit.coeffs[1]) : { x: hit.x, y: hit.y, coeffs: hit.coeffs });
    else {
      const w = toWorld(px, py);
      setCentre({ x: w.x, y: w.y, coeffs: null });
    }
  }, true);
}

function toggleSound(open) {
  const el = $('sound');
  open = open ?? el.hidden;
  if (open) { toggleSettings(false); toggleFlights(false); }
  el.hidden = !open;
  $('btn-sound').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('settings-open', open);
  if (!open && sound.picking) setPicking(false);
  if (open) {
    syncSoundUI();
    if (!sound.got || sound.dirty) soundFetch();
    else soundInfo();
  }
  requestRender();
}
$('btn-sound').onclick = () => toggleSound();
$('snd-play').onclick = () => soundToggle();

for (const [id, key] of [['snd-mode', 'mode'], ['snd-exp', 'exp'], ['snd-pitch', 'pitch']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    sound[key] = key === 'exp' ? +b.dataset.value : b.dataset.value;
    saveSound();
    syncSoundUI();
    rebuildSound();
  });
}
for (const inp of document.querySelectorAll('input[data-snd]')) {
  const key = inp.dataset.snd;
  inp.addEventListener('input', () => {
    sound[key] = +inp.value;
    document.querySelector(`output[data-snd-out="${key}"]`).textContent = fmtSound[key](sound[key]);
    if (key === 'minPx' && (!sound.got || sound.minPx < sound.got.minPx)) soundFetchSoon(150);
    else rebuildSound();
  });
  inp.addEventListener('change', saveSound);
}
$('snd-centre').addEventListener('change', () => {
  const text = $('snd-centre').value.trim();
  const c = text ? parseCentre(text) : null;
  if (c) setCentre(c, text);
  else $('snd-centre-out').textContent = '· couldn’t read that';
});
$('snd-slow').addEventListener('change', (e) => {
  sound.slow = e.target.checked;
  saveSound();
  syncSoundUI();
  rebuildSound();
});
$('snd-pick').onclick = () => setPicking(!sound.picking);
$('snd-sel').onclick = () => {
  if (!selected) { soundInfo('Click a number on the map first, then press Selected.'); return; }
  const a = selected.coeffs, r = selectionInfo().roots[selected.idx];
  setCentre(a.length === 2 ? rationalCentre(-a[0], a[1]) : { x: r.x, y: r.y, coeffs: a.slice() });
};

// Views where the sound is clearest: quadratics only, small dots included.
// at: the centre's place on screen (bottom: just above the bottom edge).
const SOUND_PRESETS = {
  zero: { centre: rationalCentre(0, 1), zoom: 0, at: 'bottom', sweep: {} },
  half: { centre: rationalCentre(1, 2), zoom: 1, at: 'bottom', sweep: {} },
  i: { centre: { x: 0, y: 1, coeffs: [1, 0, 1] }, zoom: 2, at: 'middle', sweep: { cycleSec: 6 } },
  w: { centre: { x: 0.5, y: Math.sqrt(3) / 2, coeffs: [1, -1, 1] }, zoom: 2, at: 'middle', sweep: { cycleSec: 6 } },
};
function soundPreset(name) {
  const pr = SOUND_PRESETS[name];
  Object.assign(sound, { mode: 'ring', pitch: 'value', cycles: 8, cycleSec: 14.9, minPx: 0.3, maxH: 24 }, pr.sweep);
  Object.assign(settings, { maxDeg: 2, detail: 0.2 });
  syncSettingsUI();
  updateLegend();
  invalidate();
  if (selected) renderInfo();
  setCentre(pr.centre);
  const c = pr.centre;
  animateTo(c.x, pr.at === 'bottom' ? c.y + (H / 2 - 24) / sCss(pr.zoom) : c.y, pr.zoom, 700);
  soundToggle(true);
}
for (const b of document.querySelectorAll('[data-preset]')) b.onclick = () => soundPreset(b.dataset.preset);

// The playhead, the centre and the dots that just played. Drawn with the
// controls hidden too, so it can be recorded.
function drawSound() {
  const open = !$('sound').hidden && !document.body.classList.contains('clean');
  const playing = sonifier.playing;
  if (!open && !playing) return;
  const r = sound.res;
  g.save();
  if (sound.mode === 'ring') {
    const c = toScreen(sound.centre.x, sound.centre.y);
    g.lineWidth = 1.2;
    g.strokeStyle = 'rgba(255, 106, 77, 0.9)';
    g.beginPath();
    g.moveTo(c.x - 7, c.y); g.lineTo(c.x - 2.5, c.y);
    g.moveTo(c.x + 2.5, c.y); g.lineTo(c.x + 7, c.y);
    g.moveTo(c.x, c.y - 7); g.lineTo(c.x, c.y - 2.5);
    g.moveTo(c.x, c.y + 2.5); g.lineTo(c.x, c.y + 7);
    g.stroke();
  }
  const ph = sonifier.phase();
  if (r && ph !== null) {
    const gm = r.geom;
    const stroke = (path) => {
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(255, 106, 77, 0.18)';
      path(); g.stroke();
      g.lineWidth = 1.3;
      g.strokeStyle = 'rgba(255, 120, 90, 0.95)';
      path(); g.stroke();
    };
    if (gm.mode === 'ring') {
      const rad = (gm.steady ? gm.r0 + ph * (gm.r1 - gm.r0) : Math.pow(gm.u0 + ph * (gm.u1 - gm.u0), -1 / gm.d)) * sCss();
      const c = toScreen(gm.cx, gm.cy);
      if (Number.isFinite(rad) && rad > 0.5 && rad < 1e6) stroke(() => { g.beginPath(); g.arc(c.x, c.y, rad, 0, 2 * Math.PI); });
    } else {
      const x = toScreen(gm.x0 + ph * (gm.x1 - gm.x0), 0).x;
      stroke(() => { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); });
    }
    g.lineWidth = 1.5;
    for (const h of sonifier.recentHits()) {
      const p = toScreen(h.x, h.y);
      if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) continue;
      g.strokeStyle = `rgba(255, 236, 200, ${(0.9 * (1 - h.age)).toFixed(3)})`;
      g.beginPath();
      g.arc(p.x, p.y, Math.min(30, h.rs) + 2 + 10 * h.age, 0, 2 * Math.PI);
      g.stroke();
    }
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

W = window.innerWidth;
H = window.innerHeight;
const initial = loadHash();
loadSound();
syncSettingsUI();
syncSoundUI();
updateLegend();
window.addEventListener('resize', resize);
resize();
if (initial && initial.sel) select(initial.sel);
if (initial && initial.flight) showFlightCard(initial.flight);
try { if (localStorage.getItem(COLLAPSED_KEY) === '1') setPanelCollapsed(true); } catch { /* private mode */ }
window.addEventListener('load', () => { if (selected) renderInfo(); });

// For scripts and recordings (e.g. pixeldif record --ready "viewer.loaded"
// --setup "viewer.play({capture: true})" --probe "viewer.probe()").
window.viewer = {
  get loaded() { return viewComplete(view); },
  play(opts = {}) {
    const spec = opts.spec || pendingFlight || (flight && flight.spec) || editorSpec();
    if (spec) startFlight(spec, opts);
    return !!spec;
  },
  stop: () => stopFlight(),
  probe: () => ({ zoom: view.zoom, x: view.cx, y: view.cy, t: flight ? flight.t : 0 }),
  get crossfade() { return crossfade; },
  set crossfade(on) { crossfade = !!on; schedule(); requestRender(); },
  get idle() { return !pool.some((w) => w.job) && queue.length === 0; },
  get fadeMs() { return fadeMs; },
  set fadeMs(ms) { fadeMs = Math.max(0, +ms || 0); },
  animateTo: (cx, cy, zoom, ms) => animateTo(cx, cy, zoom, ms),
};
