// flight.js — zoom "flights" through a list of views.
//
// Each leg uses van Wijk & Nuij's smooth and efficient zooming and panning
// (2003): the path that keeps the perceived speed constant, zooming out just
// enough to make a long pan short. Legs are joined into one path, and time is
// mapped to path length with a velocity profile that eases in and out.

const RHO = Math.SQRT2;

// One leg between views {x, y, w} (w = width of the view in world units).
// Returns {S, at(s)} with s ∈ [0, S] measured in the perceptual units of the paper.
function leg(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  const w0 = a.w, w1 = b.w;
  if (d2 < 1e-12 * Math.min(w0, w1) ** 2) {
    // (nearly) the same centre: a pure zoom, moving the centre along
    const S = Math.abs(Math.log(w1 / w0)) / RHO;
    return {
      S,
      at(s) {
        const t = S > 0 ? s / S : 1;
        return { x: a.x + dx * t, y: a.y + dy * t, w: w0 * Math.pow(w1 / w0, t) };
      },
    };
  }
  const d = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d2) / (2 * w0 * RHO * RHO * d);
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d2) / (2 * w1 * RHO * RHO * d);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  const c0 = Math.cosh(r0), s0 = Math.sinh(r0);
  return {
    S,
    at(s) {
      const u = (w0 / (RHO * RHO * d)) * (c0 * Math.tanh(RHO * s + r0) - s0);
      return { x: a.x + dx * u, y: a.y + dy * u, w: (w0 * c0) / Math.cosh(RHO * s + r0) };
    },
  };
}

// Velocity rises with a half-cosine over the first `ramp` of the time, stays
// constant, and falls the same way at the end: no jolt at either end.
export function ease(tau, ramp = 0.12) {
  tau = Math.min(1, Math.max(0, tau));
  const a = ramp, vmax = 1 / (1 - a);
  const up = (x) => x / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * x) / a);
  if (tau < a) return vmax * up(tau);
  if (tau > 1 - a) return 1 - vmax * up(1 - tau);
  return vmax * (a / 2 + (tau - a));
}

// views: [{x, y, zoom}], zoom as log2 of the magnification. width: viewport width
// in CSS px, s0: CSS px per unit at zoom 0. Returns {S, viewAt(s)}.
export function makePath(views, width, s0) {
  const toW = (v) => ({ x: v.x, y: v.y, w: width / (s0 * Math.pow(2, v.zoom)) });
  const legs = [];
  let S = 0;
  for (let k = 0; k + 1 < views.length; k++) {
    const l = leg(toW(views[k]), toW(views[k + 1]));
    legs.push({ start: S, l });
    S += l.S;
  }
  return {
    S,
    viewAt(s) {
      s = Math.min(S, Math.max(0, s));
      let k = legs.length - 1;
      while (k > 0 && s < legs[k].start) k--;
      const p = legs[k].l.at(s - legs[k].start);
      return { cx: p.x, cy: p.y, zoom: Math.log2(width / (s0 * p.w)) };
    },
  };
}

// Default duration: a constant perceived speed, kept within reason.
export const autoDuration = (S) => Math.min(120, Math.max(4, S / 0.3));

// --- links ---------------------------------------------------------------
// fly=o_x,y,z_x,y,z  ("o" is the overview, fitted to whoever opens the link)
const num = (v, digits) => String(+v.toPrecision(digits));

export function encodeViews(views) {
  return views
    .map((v) => (v.overview ? 'o' : `${num(v.x, 17)},${num(v.y, 17)},${num(v.zoom, 6)}`))
    .join('_');
}

export function decodeViews(text) {
  const views = [];
  for (const part of String(text).split('_')) {
    if (part === 'o') { views.push({ overview: true }); continue; }
    const [x, y, zoom] = part.split(',').map(Number);
    if (![x, y, zoom].every(Number.isFinite)) return null;
    views.push({ x, y, zoom });
  }
  return views.length >= 2 ? views : null;
}
