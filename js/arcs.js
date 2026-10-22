// arcs.js — the arcs of dots that show up when zooming in.
//
// A dot β with minimal polynomial p usually sits in a family p + t·v (t ∈ ℤ)
// whose roots line up: v is a short integer polynomial that nearly vanishes at β,
// in practice a multiple of the minimal polynomial q of a simpler number γ nearby.
// The family's roots are the points where p/v = −t. Near γ, where p/v has a pole,
// p/v ≈ A/(z − γ) + B, so they lie on a circle through γ and pile up towards it.
// Every member takes the same value at γ: the arc is a residue class modulo (q).
import { polyRoots, isIrreducible, lllReduce, COMPLEX, REAL, CIRCLE } from './core.js';
import { factorOverZ } from './algebra.js';

const STEP_PX = 40; // typical spacing of an arc's dots, which weights the search

function evalAt(a, x, y) {
  let pr = 0, pi = 0;
  for (let k = a.length - 1; k >= 0; k--) {
    const t = pr * x - pi * y + a[k];
    pi = pr * y + pi * x;
    pr = t;
  }
  return [pr, pi];
}

function derivAt(a, x, y) {
  return evalAt(a.slice(1).map((c, k) => c * (k + 1)), x, y);
}

function trim(a) {
  const b = a.slice();
  const big = Math.max(...b.map(Math.abs));
  while (b.length > 1 && Math.abs(b[b.length - 1]) <= 1e-12 * big) b.pop();
  return b;
}

const gcdAll = (a) => a.reduce((g, v) => {
  let x = Math.abs(v), y = g;
  while (x) [x, y] = [y % x, x];
  return y;
}, 0);

export function classOf(a, x, y) {
  if (y === 0) return REAL;
  const d = a.length - 1;
  const palin = d % 2 === 0 && a.every((v, k) => v === a[d - k]);
  return palin && Math.abs(x * x + y * y - 1) < 1e-11 ? CIRCLE : COMPLEX;
}

// p + t·v as an integer polynomial with positive leading coefficient
function member(p, v, t) {
  const n = Math.max(p.length, v.length);
  let a = [];
  for (let k = 0; k < n; k++) a.push((p[k] || 0) + t * (v[k] || 0));
  a = trim(a);
  if (a[a.length - 1] < 0) a = a.map((c) => -c);
  return a;
}

function nearestRoot(a, x, y) {
  const d = a.length - 1;
  if (d < 1) return null;
  const r = polyRoots(a, d);
  let best = 0, bd = Infinity;
  for (let k = 0; k < d; k++) {
    const dd = Math.hypot(r[2 * k] - x, r[2 * k + 1] - y);
    if (dd < bd) { bd = dd; best = k; }
  }
  return { x: r[2 * best], y: r[2 * best + 1], idx: best };
}

// Short integer polynomials v (degree ≤ deg p, not a multiple of p) with v(β)
// small: the reduced basis of the lattice under |v(β)|²/ε² + |v|²/L(p)².
function candidateSteps(p, bx, by, worldStep) {
  const d = p.length - 1, n = d + 1, m = n + 2;
  const [dr, di] = derivAt(p, bx, by);
  const eps = Math.max(1e-300, Math.hypot(dr, di) * worldStep);
  const L = p.reduce((s, c) => s + Math.abs(c), 0);
  const A = new Float64Array(m * n);
  let pr = 1, pi = 0;
  for (let k = 0; k < n; k++) {
    A[k] = pr / eps;
    A[n + k] = pi / eps;
    A[(2 + k) * n + k] = 1 / L;
    const t = pr * bx - pi * by;
    pi = pr * by + pi * bx;
    pr = t;
  }
  const { U } = lllReduce(A, m, n);
  const out = [];
  for (let j = 0; j < n; j++) {
    let v = [];
    for (let k = 0; k < n; k++) v.push(U[k * n + j]);
    v = trim(v);
    if (v.length < 2 || !v.every(Number.isSafeInteger)) continue;
    const c = v[d] / p[d] || 0;
    if (v.length === p.length && v.every((x, k) => Math.abs(x - c * p[k]) < 1e-9)) continue; // a multiple of p
    if (v[v.length - 1] < 0) v = v.map((x) => -x);
    out.push(v);
  }
  return out;
}

// How many members near β are visible dots on screen.
function score(p, v, bx, by, visible, viewR) {
  let count = 0;
  for (const dir of [1, -1]) {
    let x = bx, y = by, misses = 0;
    for (let k = 1; k <= 400 && misses < 12; k++) {
      const a = member(p, v, dir * k);
      const r = nearestRoot(a, x, y);
      if (!r) { misses++; continue; }
      x = r.x; y = r.y;
      const L = a.reduce((s, c) => s + Math.abs(c), 0);
      const d = a.length - 1;
      const ok = Math.hypot(x - bx, y - by) < viewR && gcdAll(a) === 1 && visible(a, d, classOf(a, x, y), L)
        && isIrreducible(a, d, polyRoots(a, d));
      if (ok) { count++; misses = 0; } else misses++;
    }
  }
  return count;
}

// The candidate arcs through the dot β = (bx, by) of p, best first:
// [{v, score}]. scale: CSS px per unit; visible(a, deg, cls, L): drawn at this zoom?
export function findArcs(p, bx, by, { scale, visible, viewR }) {
  const steps = candidateSteps(p, bx, by, STEP_PX / scale);
  return steps
    .map((v) => ({ v, score: score(p, v, bx, by, visible, viewR) }))
    .filter((c) => c.score >= 2)
    .sort((a, b) => b.score - a.score);
}

// Follow the root of cos θ·p + sin θ·v from β (θ = 0) to the centre (θ = ±π/2,
// the root of v), stopping on every integer t = tan θ. Returns the curve, the
// members and the centre γ with its minimal polynomial q.
export function traceArc(p, v, bx, by, { scale, maxMembers = 400 }) {
  const target = 2.5 / scale; // aim for a curve point every 2.5 px
  const curve = { [1]: [], [-1]: [] };
  const members = [{ t: 0, x: bx, y: by }];
  for (const dir of [1, -1]) {
    let th = 0, h = 1e-4, x = bx, y = by, nextK = 1, guard = 0;
    const pts = curve[dir];
    while (th < Math.PI / 2 && guard++ < 20000) {
      const kTh = nextK <= maxMembers ? Math.atan(nextK) : Infinity;
      let nt = Math.min(th + h, Math.PI / 2, kTh);
      const c = Math.cos(nt), s = dir * Math.sin(nt);
      const a = trim(p.map((pk, k) => c * pk + s * (v[k] || 0)).concat(v.slice(p.length).map((vk) => s * vk)));
      const r = nearestRoot(a, x, y);
      if (!r) break;
      const step = Math.hypot(r.x - x, r.y - y);
      if (step > 3 * target && h > 1e-9) { h /= 2; continue; } // too far: refine
      x = r.x; y = r.y; th = nt;
      pts.push([x, y]);
      if (nt === kTh) { members.push({ t: dir * nextK, x, y }); nextK++; }
      if (step < target) h *= 1.6;
    }
  }
  const curvePts = curve[-1].reverse().concat([[bx, by]], curve[1]);
  // the centre: the root of v both ends converge to, and its minimal polynomial
  const end = curve[1].length ? curve[1][curve[1].length - 1] : [bx, by];
  const g = nearestRoot(v, end[0], end[1]);
  let q = v, s = [1];
  for (const f of factorOverZ(v)) {
    const [fr, fi] = evalAt(f, g.x, g.y);
    const scaleF = f.reduce((acc, c) => acc + Math.abs(c), 0) * Math.max(1, Math.hypot(g.x, g.y)) ** (f.length - 1);
    if (Math.hypot(fr, fi) < 1e-8 * scaleF) { q = f; break; }
  }
  if (q !== v) {
    // v = s·q
    const n = v.length - q.length + 1;
    const rem = v.slice();
    s = new Array(n).fill(0);
    for (let k = n - 1; k >= 0; k--) {
      s[k] = rem[k + q.length - 1] / q[q.length - 1];
      for (let j = 0; j < q.length; j++) rem[k + j] -= s[k] * q[j];
    }
  }
  return {
    v, q, s,
    center: { x: g.x, y: g.y },
    curve: curvePts,
    members: members
      .sort((a, b) => a.t - b.t)
      .map((mm) => {
        const a = member(p, v, mm.t);
        const d = a.length - 1;
        const roots = d >= 1 ? polyRoots(a, d) : null;
        const irreducible = d >= 1 && gcdAll(a) === 1 && isIrreducible(a, d, roots);
        let idx = 0;
        if (roots) {
          let bd = Infinity;
          for (let k = 0; k < d; k++) {
            const dd = Math.hypot(roots[2 * k] - mm.x, roots[2 * k + 1] - mm.y);
            if (dd < bd) { bd = dd; idx = k; }
          }
        }
        return { ...mm, a, d, idx, irreducible, L: a.reduce((acc, c) => acc + Math.abs(c), 0), cls: classOf(a, mm.x, mm.y) };
      }),
  };
}
