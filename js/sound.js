// sound.js — listen to the dots: a playhead sweeps the view and every dot it
// crosses plays a note.
//
// Families of dots around a centre γ with minimal polynomial q (residue classes
// p + n·q^k) are equally spaced in u = |z − γ|^(−k), at a spacing inversely
// proportional to their value |p(γ)|. For the fans of quadratics at a rational
// centre (k = 2) this is exact: at γ = 0 the roots of n x² + b x + c have
// |z|^(−2) = n/c (see cycleUnit for r/s). So a ring around γ whose radius falls so that r^(−k) grows
// steadily is the analogue of a line sliding across a polyrhythm grid: family c
// ticks c times as often as family 1. The natural pitch is the family's value at
// γ, an integer at rational centres, so rhythm and pitch are both a harmonic
// series. Round a complex quadratic γ the quadratics form families p + n·q
// (k = 1, evenly spaced only for large n), and the values are square roots of
// norms: √(b² + c²) at i, like the overtones of a square drum.
//
// The Sonifier only knows events {p, h, amp, pan, x, y}: p ∈ [0, 1) is where in
// the sweep the dot sits, h its harmonic number. It plays them in a loop with
// sample-accurate Web Audio scheduling.

const LOOKAHEAD = 0.15; // seconds scheduled ahead
const SLICE = 0.05;     // scheduling granularity
const MAX_VOICES = 40;  // per slice

function impulse(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  }
  return buf;
}

export class Sonifier {
  constructor() {
    this.ctx = null;
    this.events = [];
    this.T = 30;
    this.f0 = 110;
    this.vol = 0.7;
    this.playing = false;
    this.hits = [];
  }

  ensure() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.bus = ctx.createGain();
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.25;
    this.bus.connect(comp);
    this.bus.connect(verb);
    verb.connect(wet);
    wet.connect(comp);
    comp.connect(this.master);
    this.master.connect(ctx.destination);
    // a soft tone: the fundamental with a little second and third harmonic
    this.wave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.16, 0.05]));
  }

  // New notes (sorted by p) or settings; keeps the sweep's position when playing.
  setEvents(events, T, f0, vol) {
    if (this.playing && T !== this.T) {
      const now = this.ctx.currentTime;
      const ph = this.phase(now);
      this.start = now - ph * T;
    }
    this.events = events;
    this.T = T;
    this.f0 = f0;
    this.vol = vol;
    if (this.playing) this.master.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
  }

  // Create and resume the audio context. Call it from a click or key press:
  // browsers only let audio start there.
  unlock() {
    this.ensure();
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  async play() {
    this.ensure();
    await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.playing = true;
    this.start = now + 0.05;
    this.cursor = this.start;
    this.hits = [];
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.vol, now, 0.03);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    if (!this.ctx) return;
    this.playing = false;
    clearInterval(this.timer);
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.06);
  }

  // The time of the sound reaching the speakers now (currentTime runs ahead by
  // the output latency), so the pictures line up with what is heard.
  heard() {
    const c = this.ctx;
    return c ? c.currentTime - (c.outputLatency || 0) - (c.baseLatency || 0) : 0;
  }

  // Position in the sweep, 0…1, or null when stopped.
  phase(t = this.heard()) {
    if (!this.playing) return null;
    const x = (t - this.start) / this.T;
    return x < 0 ? 0 : x - Math.floor(x);
  }

  // Dots that have just sounded, for drawing flashes: [{x, y, rs, age}]
  recentHits(span = 0.35) {
    if (!this.ctx) return [];
    const t = this.heard();
    this.hits = this.hits.filter((h) => t - h.time < span);
    return this.hits.filter((h) => h.time <= t).map((h) => ({ ...h, age: (t - h.time) / span }));
  }

  // first event with p ≥ x
  lower(x) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].p < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  schedule() {
    if (!this.playing) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD;
    if (this.cursor < ctx.currentTime) this.cursor = ctx.currentTime;
    while (this.cursor < horizon) {
      const tA = this.cursor, tB = Math.min(horizon, tA + SLICE);
      this.cursor = tB;
      if (!this.events.length) continue;
      const xA = (tA - this.start) / this.T, xB = (tB - this.start) / this.T;
      const loop = Math.floor(xA);
      const ranges = [[xA - loop, Math.min(1, xB - loop), loop]];
      if (xB - loop > 1) ranges.push([0, xB - loop - 1, loop + 1]);
      const groups = new Map();
      for (const [pa, pb, lp] of ranges) {
        for (let k = this.lower(pa); k < this.events.length && this.events[k].p < pb; k++) {
          const e = this.events[k];
          const time = this.start + (lp + e.p) * this.T;
          if (time < ctx.currentTime) continue;
          // dots of one pitch at (nearly) one moment become one louder voice
          const key = `${Math.round(time * 40)}|${e.h.toFixed(3)}`;
          let gr = groups.get(key);
          if (!gr) groups.set(key, (gr = { time, h: e.h, a2: 0, pan: 0, n: 0 }));
          gr.a2 += e.amp * e.amp;
          gr.pan += e.pan;
          gr.n++;
          if (this.hits.length < 800) this.hits.push({ x: e.x, y: e.y, rs: e.rs, time });
        }
      }
      const voices = [...groups.values()].sort((a, b) => b.a2 - a.a2).slice(0, MAX_VOICES);
      for (const v of voices) this.voice(v.time, this.f0 * v.h, Math.min(0.9, 0.22 * Math.sqrt(v.a2)), v.pan / v.n);
    }
  }

  voice(t, f, a, pan) {
    if (f > 12000 || f < 20) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.wave);
    o.frequency.value = f;
    const g = ctx.createGain();
    const dec = Math.min(1.6, Math.max(0.12, 0.9 * Math.sqrt(220 / f)));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, a), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(g);
    g.connect(p);
    p.connect(this.bus);
    o.start(t);
    o.stop(t + dec + 0.02);
  }
}

// ---------------------------------------------------------------------------
// Notes from dots (pure: shared by the page and offline tools)
// ---------------------------------------------------------------------------

// A centre {x, y, coeffs}: coeffs = its minimal polynomial (low → high) or null.
export const isRationalCentre = (c) => !!(c && c.coeffs && c.coeffs.length === 2);

// The pitch value of polynomial a at the centre. At a rational centre r/s it is the
// integer s^deg · a(r/s), so pitches are exact harmonics; elsewhere |a(γ)|.
export function centreValue(a, c) {
  const d = a.length - 1;
  if (isRationalCentre(c)) {
    const s = c.coeffs[1], r = -c.coeffs[0];
    let F = 0;
    for (let k = 0; k <= d; k++) F += a[k] * Math.pow(r, k) * Math.pow(s, d - k);
    return Math.abs(F);
  }
  let pr = 0, pi = 0;
  for (let k = d; k >= 0; k--) {
    const t = pr * c.x - pi * c.y + a[k];
    pi = pr * c.y + pi * c.x;
    pr = t;
  }
  return Math.hypot(pr, pi);
}

// The view's distances from the centre: its farthest corner and its nearest point
// (0 when the centre is on screen).
export function screenRadii(c, rect) {
  const corners = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x0, rect.y1], [rect.x1, rect.y1]];
  const far = Math.max(...corners.map(([x, y]) => Math.hypot(x - c.x, y - c.y)));
  const dx = Math.max(rect.x0 - c.x, 0, c.x - rect.x1), dy = Math.max(rect.y0 - c.y, 0, c.y - rect.y1);
  return { far, near: Math.hypot(dx, dy) };
}

// One cycle of the ring's clock, in u = r^(−k), and whether it is exact.
//  - rational centre r/s, k = 2: the dots of value F sit at u = s²·a/F with the
//    leading coefficient a ≡ F·r⁻² (mod s), so value F recurs every s³/F: one
//    cycle is s³, and in it value F plays exactly F times.
//  - algebraic centre γ of degree ≥ 2, k = 1: the family p + n·q has
//    u ≈ n·|q′(γ)|/|p(γ)|, so one cycle is |q′(γ)| (for large n).
//  - otherwise there is no natural cycle: one cycle is the first halving of
//    the radius, from the farthest corner of the screen.
export function cycleUnit(c, k, far) {
  if (isRationalCentre(c) && k === 2) return { unit: Math.pow(c.coeffs[1], 3), kind: 'exact' };
  if (c.coeffs && c.coeffs.length > 2 && k === 1) {
    const a = c.coeffs;
    let pr = 0, pi = 0;
    for (let j = a.length - 1; j >= 1; j--) {
      const t = pr * c.x - pi * c.y + j * a[j];
      pi = pr * c.y + pi * c.x;
      pr = t;
    }
    return { unit: Math.hypot(pr, pi), kind: 'asymptotic' };
  }
  return { unit: (Math.pow(2, k) - 1) * Math.pow(far, -k), kind: 'none' };
}

// Notes for one sweep.
//   dots: [{x, y, d, r, a}], r in CSS px at the zoom the dots were computed for
//   o: {mode: 'ring' | 'line', centre, exp, pitch: 'value' | 'lead' | 'const',
//       rect: world rectangle on screen {x0, x1, y0, y1},
//       sizeK (screen px per dot CSS px), minPx, maxH,
//       slow, cycles, cycleSec (ring), sweepSec (line, or ring with slow = false)}
// The playhead's path and speed depend only on the view, the centre and these
// settings, never on where the dots are. The ring starts at the farthest corner
// of the screen. With slow (the default) r^(−k) grows steadily, one cycle per
// cycleSec, so the rhythm stays exact and the ring slows down as it closes in;
// without, the ring shrinks at a steady speed to the centre in sweepSec.
// Returns {events: [{p, h, amp, pan, x, y, rs}] sorted by p, geom, duration,
//          cycles, maxCycles, cycle: {unit, kind}, rational}
export function sweepEvents(dots, o) {
  const c = o.centre;
  const rational = o.pitch === 'value' && isRationalCentre(c);
  const value = (dt) => (o.pitch === 'lead' ? dt.a[dt.d] : o.pitch === 'const' ? Math.abs(dt.a[0]) : centreValue(dt.a, c));
  // the dots that sound, with their pitch
  const notes = [];
  for (const dt of dots) {
    const rs = dt.r * o.sizeK;
    if (rs < o.minPx) continue;
    const dist = Math.hypot(dt.x - c.x, dt.y - c.y);
    if (o.mode === 'ring' && !(dist > 0)) continue;
    notes.push({ dt, rs, dist, v: value(dt) });
  }
  // Elsewhere the lowest value present is the base pitch (at an algebraic centre;
  // at i, |p(i)| = √(b² + c²) ≥ 1), or a low percentile at an arbitrary point.
  let unitV = 1;
  if (o.pitch === 'value' && !rational) {
    const nz = notes.map((n) => n.v).filter((v) => v > 1e-9).sort((a, b) => a - b);
    unitV = !nz.length ? 1 : c.coeffs ? nz[0] : nz[Math.floor(nz.length * 0.02)];
  }
  const kept = notes.filter((n) => {
    n.h = rational ? Math.round(n.v) : n.v / unitV;
    return n.h >= 0.5 && n.h <= o.maxH;
  });
  let geom, coord, duration = o.sweepSec, cycles = null, maxCycles = null, cycle = null;
  if (o.mode === 'ring') {
    const k = o.exp;
    const { far, near } = screenRadii(c, o.rect);
    if (o.slow === false) {
      geom = { mode: 'ring', cx: c.x, cy: c.y, steady: true, r0: far, r1: near };
      coord = (n) => (far - n.dist) / (far - near);
    } else {
      cycle = cycleUnit(c, k, far);
      const u0 = Math.pow(far, -k);
      // past the screen's nearest point there is nothing more to hear
      if (near > 0) maxCycles = Math.max(1, Math.ceil((Math.pow(near, -k) - u0) / cycle.unit));
      cycles = Math.max(1, Math.min(o.cycles || 1, maxCycles || Infinity));
      const u1 = u0 + cycles * cycle.unit;
      duration = cycles * o.cycleSec;
      geom = { mode: 'ring', cx: c.x, cy: c.y, d: k, u0, u1 };
      coord = (n) => (Math.pow(n.dist, -k) - u0) / (u1 - u0);
    }
  } else {
    geom = { mode: 'line', x0: o.rect.x0, x1: o.rect.x1 };
    coord = (n) => (n.dt.x - o.rect.x0) / (o.rect.x1 - o.rect.x0);
  }
  const events = [];
  for (const n of kept) {
    const p = coord(n);
    if (!(p >= 0 && p < 1)) continue;
    const pan = ((n.dt.x - o.rect.x0) / (o.rect.x1 - o.rect.x0)) * 1.4 - 0.7;
    events.push({ p, h: n.h, amp: Math.min(1, Math.pow(n.rs / 10, 0.8)), pan, x: n.dt.x, y: n.dt.y, rs: n.rs });
  }
  events.sort((a, b) => a.p - b.p);
  return { events, geom, duration, cycles, maxCycles, cycle, rational };
}
