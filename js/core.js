// core.js — finds the algebraic numbers that are visible in a region of the
// complex plane and renders them. Shared by the tile workers and the query worker.
//
// Every algebraic number α is drawn once, using its minimal polynomial
//   p(x) = a_d x^d + … + a_0  (integer, primitive, irreducible, a_d > 0).
// Its size is a function of the "length" L = |a_0| + … + |a_d| and the degree d:
//   complex α:   r(L, d) = ρ0 · (L/2)^(-β) · g(L),   β = κ (d+1)/2
//   real α:      the same up to L = KNEE, then falling off like L^(-κ (d+1))
//   |α| = 1:     the same up to L = KNEE, then falling off like L^(-κ (d/2+1))
// g eases from 1 to TAIL_SCALE around L ≈ 14: small L sets the look of the overview
// (Brooks' picture), the tail sets how crowded deep zooms are.
// These are the Dirichlet exponents for approximating a point of the plane, of the
// real line and of the unit circle by algebraic numbers of degree d (numbers on the
// unit circle come from palindromic polynomials, which have d/2+1 free coefficients).
// With them every zoom level shows the same density of dots on average, in the plane
// and along both special curves: you can zoom forever and the picture neither
// empties nor saturates.
//
// For a tile we need every polynomial with a root inside (tile + glow margin) whose
// dot is at least `rMin` pixels. Deep in a zoom that is a needle-in-a-haystack
// problem (lengths in the thousands), so the polynomials are found as lattice points
// in a thin ellipsoid: "p(z0) is small" is linear in the coefficients. Shallow
// views use a direct walk over the L1 ball instead, whichever is cheaper.

export const TILE = 256;   // tile edge in device pixels
export const S0_CSS = 360; // CSS pixels per unit at zoom level 0
const KNEE = 6;
const TAIL_SCALE = 0.4, TAIL_L = 14;
const LINE_CAP = 9; // CSS px: past L = 4, dots on the real line / unit circle stay this small
export const COMPLEX = 0, REAL = 1, CIRCLE = 2; // dot classes

export const DEFAULT_SETTINGS = {
  maxDeg: 4,
  colorMode: 'lead', // 'lead' | 'degree'
  highLead: true,    // show leading coefficient ≥ 5
  dotScale: 1,
  detail: 0.5,       // smallest dot drawn, in CSS px
  falloff: 1,        // κ
  exposure: 1,
  glow: 0.5,
  numbers: 'all',    // 'all' | 'integers' (monic only)
};

// Emission colours (linear RGB). Non-zero minor channels make bright dots burn to white.
export const LEAD_COLORS = [
  null,
  [1.0, 0.17, 0.05], // 1: algebraic integers
  [0.12, 1.0, 0.1],  // 2
  [0.16, 0.3, 1.0],  // 3
  [1.0, 0.78, 0.05], // 4
  [0.55, 0.3, 0.85], // ≥ 5
];
export const DEGREE_COLORS = [
  null,
  [1.0, 0.17, 0.05],
  [0.12, 1.0, 0.1],
  [0.16, 0.3, 1.0],
  [1.0, 0.78, 0.05],
  [0.05, 0.85, 1.0],
  [1.0, 0.2, 0.85],
  [1.0, 0.48, 0.05],
  [0.8, 0.8, 0.8],
];

export function makeConfig(settings, sCss, dpr) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const halo = 0.15 * s.glow;
  const haloK = 3;
  return {
    sCss,
    dpr,
    sDev: sCss * dpr,
    maxDeg: s.maxDeg,
    colorMode: s.colorMode,
    highLead: s.highLead,
    monic: s.numbers === 'integers',
    rho0: 0.06 * s.dotScale * (s.numbers === 'integers' ? 0.85 : 1),
    kappa: s.falloff,
    rMin: s.detail,
    rCap: 46,
    maxLenCache: new Map(),
    peakA: s.peakA ?? 1.1,   // peak intensity = peakA + peakB · r
    peakB: s.peakB ?? 0.6,
    coreP: s.coreP ?? 1.6,   // core profile exp(−(ρ/r)^(2p))
    exposure: s.exposure,
    halo,                    // halo amplitude relative to the core, for big dots
    haloK,                   // halo radius in units of r
    haloR: s.haloR ?? 34,    // dots smaller than this (CSS px) get proportionally less halo
    nodeBudget: 2e7 * Math.max(1, 2 * (s.maxDeg - 4)), // high degrees need far more search
  };
}

// Exponents come from counting free coefficients: d+1 in general, d for monic
// polynomials, d/2+1 (resp. d/2) for palindromic ones, whose roots lie on |z| = 1.
const freeCoeffs = (cfg, d) => (cfg.monic ? d : d + 1);
const tailExponent = (cfg, d, cls) =>
  cfg.kappa * (cls === REAL ? freeCoeffs(cfg, d) : cfg.monic ? d / 2 : d / 2 + 1);

function baseRadius(cfg, L, d) {
  const u = (L / TAIL_L) * (L / TAIL_L);
  const g = (1 + TAIL_SCALE * u) / (1 + u);
  return cfg.rho0 * Math.pow(L / 2, (-cfg.kappa * freeCoeffs(cfg, d)) / 2) * g;
}

// Dot radius in world units (non-increasing in L). Dots on the real line and the
// unit circle are never bigger than complex ones of the same length: the search
// relies on the complex size to bound every class.
export function radiusWorld(cfg, L, d, cls) {
  const r = baseRadius(cfg, L, d);
  if (cls === COMPLEX || L <= KNEE) return r;
  return Math.min(r, baseRadius(cfg, KNEE, d) * Math.pow(L / KNEE, -tailExponent(cfg, d, cls)));
}

export function radiusCss(cfg, L, d, cls) {
  const r = Math.min(radiusWorld(cfg, L, d, cls) * cfg.sCss, cfg.rCap);
  return cls !== COMPLEX && L > 4 ? Math.min(r, LINE_CAP) : r;
}

// Largest length whose dot is at least rMin pixels.
export function maxLength(cfg, d, cls) {
  const key = d * 3 + cls;
  let v = cfg.maxLenCache.get(key);
  if (v !== undefined) return v;
  const ok = (L) => radiusWorld(cfg, L, d, cls) * cfg.sCss >= cfg.rMin;
  let hi = 2;
  while (ok(hi) && hi < 1e15) hi *= 2;
  let lo = hi / 2;
  if (!ok(lo)) lo = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  cfg.maxLenCache.set(key, lo);
  return lo;
}

export function peakIntensity(cfg, rCss) {
  return cfg.peakA + cfg.peakB * rCss;
}

export function haloWeight(cfg, rCss) {
  const t = Math.min(1, rCss / cfg.haloR);
  return cfg.halo * t * t;
}

// Splat radius in units of r: the core, or as far as the halo stays visible.
// Non-decreasing in r, so the reach below is non-increasing in L.
export function splatExtent(cfg, rCss) {
  const hA = haloWeight(cfg, rCss) * peakIntensity(cfg, rCss);
  const halo = hA > 0.004 ? cfg.haloK * Math.sqrt(Math.log(hA / 0.004)) : 0;
  return Math.min(9.9, Math.max(1.9, halo)); // 9.9² < U_MAX
}

// World-space distance at which a dot stops contributing light.
export function glowReach(cfg, L, d, cls) {
  const rCss = radiusCss(cfg, L, d, cls);
  const rDev = rCss * cfg.dpr;
  if (rDev < 0.7) return 1.5 / cfg.sDev;
  return (splatExtent(cfg, rCss) * rDev) / cfg.sDev;
}

// ---------------------------------------------------------------------------
// Polynomial roots
// ---------------------------------------------------------------------------

// Roots of a[0] + a[1] x + … + a[d] x^d as [re0, im0, re1, im1, …].
// Real roots have im exactly 0 and complex roots come in exact conjugate pairs.
export function polyRoots(a, d) {
  const out = new Float64Array(2 * d);
  if (d === 1) {
    out[0] = -a[0] / a[1];
    return out;
  }
  if (d === 2) {
    const A = a[2], B = a[1], C = a[0];
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const q = -0.5 * (B + (B >= 0 ? s : -s));
      out[0] = q / A;
      out[2] = q !== 0 ? C / q : 0;
    } else {
      out[0] = out[2] = -B / (2 * A);
      out[1] = Math.sqrt(-disc) / (2 * A);
      out[3] = -out[1];
    }
    return out;
  }
  aberth(a, d, out);
  cleanConjugates(a, d, out);
  return out;
}

const zr = new Float64Array(16), zi = new Float64Array(16), cm = new Float64Array(17);

function aberth(a, d, out) {
  const an = a[d];
  for (let k = 0; k <= d; k++) cm[k] = a[k] / an;
  let r0 = Math.pow(Math.abs(cm[0]), 1 / d);
  if (!(r0 > 1e-6 && r0 < 1e6)) r0 = 1;
  for (let i = 0; i < d; i++) {
    const t = (2 * Math.PI * i) / d + 0.4;
    zr[i] = r0 * Math.cos(t);
    zi[i] = r0 * Math.sin(t);
  }
  for (let iter = 0; iter < 120; iter++) {
    let maxRel = 0;
    for (let i = 0; i < d; i++) {
      const x = zr[i], y = zi[i];
      let pr = 1, pim = 0, dr = 0, di = 0;
      for (let k = d - 1; k >= 0; k--) {
        let t = dr * x - di * y + pr;
        di = dr * y + di * x + pim;
        dr = t;
        t = pr * x - pim * y + cm[k];
        pim = pr * y + pim * x;
        pr = t;
      }
      if (pr === 0 && pim === 0) continue;
      let den = dr * dr + di * di;
      if (den === 0) {
        zr[i] += 1e-7 * (1 + Math.abs(x));
        maxRel = 1;
        continue;
      }
      const nr = (pr * dr + pim * di) / den;
      const ni = (pim * dr - pr * di) / den;
      let sr = 0, si = 0;
      for (let j = 0; j < d; j++) {
        if (j === i) continue;
        const ur = x - zr[j], ui = y - zi[j];
        const m = ur * ur + ui * ui;
        if (m === 0) continue;
        sr += ur / m;
        si -= ui / m;
      }
      const tr = 1 - (nr * sr - ni * si);
      const ti = -(nr * si + ni * sr);
      den = tr * tr + ti * ti;
      const wr = (nr * tr + ni * ti) / den;
      const wi = (ni * tr - nr * ti) / den;
      zr[i] = x - wr;
      zi[i] = y - wi;
      const rel = (wr * wr + wi * wi) / (1 + x * x + y * y);
      if (rel > maxRel) maxRel = rel;
    }
    if (maxRel < 1e-30) break;
  }
  for (let i = 0; i < d; i++) {
    out[2 * i] = zr[i];
    out[2 * i + 1] = zi[i];
  }
}

function evalReal(a, d, x) {
  let p = a[d], dp = 0;
  for (let k = d - 1; k >= 0; k--) {
    dp = dp * x + p;
    p = p * x + a[k];
  }
  return [p, dp];
}

function cleanConjugates(a, d, out) {
  for (let i = 0; i < d; i++) {
    const re = out[2 * i], im = out[2 * i + 1];
    if (Math.abs(im) >= 1e-7 * (1 + Math.abs(re))) continue;
    let partner = false;
    for (let j = 0; j < d && !partner; j++) {
      if (j === i) continue;
      const dx = out[2 * j] - re, dy = out[2 * j + 1] + im;
      if (dx * dx + dy * dy < 0.25 * im * im) partner = true;
    }
    if (partner) continue;
    out[2 * i + 1] = 0;
    let x = re;
    for (let it = 0; it < 3; it++) {
      const [p, dp] = evalReal(a, d, x);
      if (dp === 0) break;
      const nx = x - p / dp;
      if (!(Math.abs(nx - re) < 1e-6 * (1 + Math.abs(re)))) break;
      x = nx;
    }
    out[2 * i] = x;
  }
  // make conjugate pairs exact
  let used = 0;
  for (let i = 0; i < d; i++) {
    if (used & (1 << i) || out[2 * i + 1] <= 0) continue;
    let best = -1, bd = Infinity;
    for (let j = 0; j < d; j++) {
      if (j === i || used & (1 << j) || out[2 * j + 1] >= 0) continue;
      const dx = out[2 * j] - out[2 * i], dy = out[2 * j + 1] + out[2 * i + 1];
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = j; }
    }
    if (best < 0) continue;
    const re = 0.5 * (out[2 * i] + out[2 * best]);
    const im = 0.5 * (out[2 * i + 1] - out[2 * best + 1]);
    out[2 * i] = out[2 * best] = re;
    out[2 * i + 1] = im;
    out[2 * best + 1] = -im;
    used |= (1 << i) | (1 << best);
  }
}

// ---------------------------------------------------------------------------
// Irreducibility over Z (for primitive a with a_d > 0)
// ---------------------------------------------------------------------------

function divisors(n) {
  n = Math.abs(n);
  const small = [], large = [];
  for (let i = 1; i * i <= n; i++) {
    if (n % i === 0) {
      small.push(i);
      if (i * i !== n) large.push(n / i);
    }
  }
  return small.concat(large.reverse());
}

function isSquare(D) {
  if (D < 0) return false;
  if (D < 4.5e15) {
    const s = Math.round(Math.sqrt(D));
    return s * s === D;
  }
  const B = BigInt(D);
  let x = BigInt(Math.floor(Math.sqrt(D)));
  for (let i = 0; i < 4; i++) x = (x + B / x) >> 1n;
  for (let dx = -2n; dx <= 2n; dx++) if ((x + dx) * (x + dx) === B) return true;
  return false;
}

// Does Q divide a in Q[x]? (pseudo-remainder test, exact)
function dividesExact(a, d, Q, s) {
  const r = Array.from({ length: d + 1 }, (_, k) => BigInt(a[k]));
  const q = Q.map((v) => BigInt(v));
  const c = q[s];
  for (let i = d; i >= s; i--) {
    const lead = r[i];
    if (lead === 0n) continue;
    for (let k = 0; k <= i; k++) r[k] *= c;
    for (let k = 0; k <= s; k++) r[k + i - s] -= lead * q[k];
  }
  for (let k = 0; k < s; k++) if (r[k] !== 0n) return false;
  return true;
}

export function isIrreducible(a, d, roots) {
  if (d === 1) return true;
  if (a[0] === 0) return false;
  if (d === 2) return !isSquare(a[1] * a[1] - 4 * a[2] * a[0]);
  return findFactor(a, d, roots) === null;
}

// A proper factor of a (primitive, degree d ≥ 2) as an integer coefficient array, or null.
export function findFactor(a, d, roots) {
  if (a[0] === 0) return [0, 1];
  // A factor of degree ≤ d/2 has, up to a constant c | a_d, the form c·∏(x − α)
  // over a conjugation-closed subset of the roots. Look for integral ones.
  const orb = []; // [size, c0, c1, (c2)] monic real factor of each conjugation orbit
  let minSep = Infinity, scale = 1;
  for (let i = 0; i < d; i++) {
    const re = roots[2 * i], im = roots[2 * i + 1];
    scale = Math.max(scale, Math.abs(re) + Math.abs(im));
    for (let j = i + 1; j < d; j++) {
      const s = Math.hypot(roots[2 * j] - re, roots[2 * j + 1] - im);
      if (s < minSep) minSep = s;
    }
    if (im === 0) orb.push([1, -re, 1]);
    else if (im > 0) orb.push([2, re * re + im * im, -2 * re, 1]);
  }
  const clustered = minSep < 1e-5 * scale;
  if (clustered) {
    // a repeated root splits into a fake conjugate pair numerically: test square-freeness exactly
    const P = Array.from({ length: d + 1 }, (_, k) => BigInt(a[k]));
    const D = P.slice(1).map((v, k) => v * BigInt(k + 1));
    const g = polyGcdBig(P, D);
    if (g.length > 1) return g.map(Number);
  }
  const tol = clustered ? 1e-3 : 1e-6;
  const divs = divisors(a[d]);
  const m = orb.length;
  const half = d >> 1;
  const q = new Float64Array(d + 1);
  for (let mask = 1; mask < (1 << m) - 1; mask++) {
    let size = 0;
    for (let t = 0; t < m; t++) if (mask & (1 << t)) size += orb[t][0];
    if (size > half) continue;
    // multiply out the orbit factors
    q.fill(0);
    q[0] = 1;
    let deg = 0;
    for (let t = 0; t < m; t++) {
      if (!(mask & (1 << t))) continue;
      const f = orb[t], fs = f[0];
      for (let k = deg + fs; k >= 0; k--) {
        let v = 0;
        for (let j = 0; j <= fs; j++) if (k - j >= 0 && k - j <= deg) v += f[1 + j] * q[k - j];
        q[k] = v;
      }
      deg += fs;
    }
    for (const c of divs) {
      let ok = true;
      for (let k = 0; k < deg; k++) {
        const v = c * q[k];
        if (Math.abs(v - Math.round(v)) > tol * Math.max(1, Math.abs(v))) { ok = false; break; }
      }
      if (!ok) continue;
      const Q = [];
      for (let k = 0; k <= deg; k++) Q.push(Math.round(c * q[k]));
      if (dividesExact(a, d, Q, deg)) return Q;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Root memo (per worker): the same polynomial shows up in many tiles.
// ---------------------------------------------------------------------------

const memo = new Map();
const MEMO_MAX = 150000;

function memoGet(a, d) {
  const key = a.join(',');
  let e = memo.get(key);
  if (!e) {
    if (memo.size >= MEMO_MAX) memo.clear();
    e = { roots: polyRoots(a, d), irr: -1 };
    memo.set(key, e);
  }
  return e;
}

// ---------------------------------------------------------------------------
// Enumeration of integer polynomials a with box constraints |F_i · a| ≤ eps_i,
// L1(a) ∈ [Llo, Lhi] and a_d ≥ 1.
// ---------------------------------------------------------------------------

function l1Count(n, L) {
  let s = 0, b1 = 1, b2 = 1, p2 = 1;
  for (let k = 0; k <= Math.min(n, L); k++) {
    s += p2 * b1 * b2;
    b1 = (b1 * (n - k)) / (k + 1);
    b2 = (b2 * (L - k)) / (k + 1);
    p2 *= 2;
  }
  return s;
}

const BALL = [1, 2, Math.PI, (4 / 3) * Math.PI];
for (let n = 4; n <= 12; n++) BALL[n] = ((2 * Math.PI) / n) * BALL[n - 2];

function latticeEstimate(F, eps, n, L) {
  const k = F.length;
  const M = [];
  for (let i = 0; i < k; i++) {
    M.push([]);
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += F[i][t] * F[j][t];
      M[i].push((s * L * L) / (eps[i] * eps[j]));
    }
  }
  for (let i = 0; i < k; i++) M[i][i] += 1;
  let det = 1;
  for (let c = 0; c < k; c++) {
    det *= M[c][c];
    for (let r = c + 1; r < k; r++) {
      const f = M[r][c] / M[c][c];
      for (let t = c; t < k; t++) M[r][t] -= f * M[c][t];
    }
  }
  // volume of the weighted ellipsoid used by enumLattice (λ = k/n)
  const w = Math.pow(n / k, k / 2) * Math.pow(n / (n - k), (n - k) / 2);
  return (BALL[n] * w * Math.pow(L, n)) / Math.sqrt(Math.max(det, 1));
}

function boxOk(F, eps, a, n) {
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    let s = 0;
    for (let m = 0; m < n; m++) s += f[m] * a[m];
    if (!(Math.abs(s) <= eps[i])) return false;
  }
  return true;
}

// Direct walk over the L1 ball, a_d first, pruning with the box constraints.
function enumDirect(d, Llo, Lhi, F, eps, ctx, onCand) {
  const k = F.length, n = d + 1;
  const tau = F.map((f) => {
    const t = new Float64Array(n);
    let mx = 0;
    for (let j = 0; j < n; j++) {
      t[j] = mx;
      mx = Math.max(mx, Math.abs(f[j]));
    }
    return t;
  });
  const epsR = eps.map((e) => e * (1 + 1e-9) + 1e-300);
  const a = new Float64Array(n);
  const P = new Float64Array((n + 1) * k); // P[(j+1)*k + i]: sum over m > j
  const rec = (j, Lrem) => {
    const pb = (j + 1) * k;
    let lo = j === d ? 1 : -Lrem, hi = j === d && ctx.monic ? 1 : Lrem;
    for (let i = 0; i < k; i++) {
      const c = F[i][j], p = P[pb + i], slack = epsR[i] + tau[i][j] * Lrem;
      if (c === 0) {
        if (Math.abs(p) > slack) return;
        continue;
      }
      let u = (-slack - p) / c, v = (slack - p) / c;
      if (u > v) { const t = u; u = v; v = t; }
      if (u > lo) lo = Math.ceil(u - 1e-9);
      if (v < hi) hi = Math.floor(v + 1e-9);
    }
    for (let aj = lo; aj <= hi; aj++) {
      if (++ctx.nodes > ctx.nodeBudget) { ctx.aborted = true; return; }
      const rem = Lrem - Math.abs(aj);
      let ok = true;
      for (let i = 0; i < k; i++) {
        const v = P[pb + i] + F[i][j] * aj;
        if (Math.abs(v) > epsR[i] + tau[i][j] * rem) { ok = false; break; }
        P[j * k + i] = v;
      }
      if (!ok) continue;
      a[j] = aj;
      if (j === 0) {
        const L1 = Lhi - rem;
        if (L1 >= Llo && boxOk(F, eps, a, n)) onCand(a, L1);
      } else {
        rec(j - 1, rem);
        if (ctx.aborted) return;
      }
    }
  };
  rec(d, Lhi);
}

// --- exact integer polynomial gcd (primitive PRS), coefficient arrays low→high ---
function trimBig(a) {
  let n = a.length;
  while (n > 0 && a[n - 1] === 0n) n--;
  return a.slice(0, n);
}
function primPartBig(a) {
  let g = 0n;
  for (const v of a) {
    let x = v < 0n ? -v : v, y = g;
    while (x) { const t = y % x; y = x; x = t; }
    g = y;
  }
  if (g === 0n) return a;
  const sign = a[a.length - 1] < 0n ? -1n : 1n;
  return a.map((v) => (v / g) * sign);
}
function premBig(a, b) {
  const r = a.slice(), db = b.length - 1, c = b[db];
  for (let i = r.length - 1; i >= db; i--) {
    const lead = r[i];
    if (lead === 0n) continue;
    for (let k = 0; k <= i; k++) r[k] *= c;
    for (let k = 0; k <= db; k++) r[k + i - db] -= lead * b[k];
  }
  return trimBig(r.slice(0, db));
}
export function polyGcdBig(a, b) {
  a = primPartBig(trimBig(a));
  b = primPartBig(trimBig(b));
  if (a.length < b.length) [a, b] = [b, a];
  while (b.length > 0) {
    if (b.length === 1) return [1n];
    const r = premBig(a, b);
    a = b;
    b = r.length ? primPartBig(r) : r;
  }
  return a;
}

// Lattice enumeration: LLL-reduce, then Schnorr–Euchner inside the ellipsoid
//   (λ/k) Σ (F_i·a / eps_i)² + (1 − λ) |a|²/Lhi² ≤ 1,   λ = k/n,
// which contains every point satisfying the box constraints (λ = k/n minimises
// its volume).
function enumLattice(d, Llo, Lhi, F, eps, ctx, onCand, detectSkip = true) {
  const n = d + 1, k = F.length, m = n + k;
  const A = new Float64Array(m * n); // row-major m x n
  const w1 = Math.sqrt(1 / n), w2 = Math.sqrt(1 - k / n);
  for (let i = 0; i < k; i++) for (let t = 0; t < n; t++) A[i * n + t] = (w1 * F[i][t]) / eps[i];
  for (let t = 0; t < n; t++) A[(k + t) * n + t] = w2 / Lhi;
  const U = new Float64Array(n * n); // column j = coefficients of basis vector j
  for (let t = 0; t < n; t++) U[t * n + t] = 1;
  const B = new Float64Array(n * m); // column-major: B[j*m + r]
  const setB = (j) => {
    for (let r = 0; r < m; r++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += A[r * n + t] * U[t * n + j];
      B[j * m + r] = s;
    }
  };
  for (let j = 0; j < n; j++) setB(j);
  const mu = new Float64Array(n * n), Bn = new Float64Array(n), Bs = new Float64Array(n * m);
  const gs = () => {
    for (let i = 0; i < n; i++) {
      for (let r = 0; r < m; r++) Bs[i * m + r] = B[i * m + r];
      for (let j = 0; j < i; j++) {
        let s = 0;
        for (let r = 0; r < m; r++) s += B[i * m + r] * Bs[j * m + r];
        const u = Bn[j] > 0 ? s / Bn[j] : 0;
        mu[i * n + j] = u;
        for (let r = 0; r < m; r++) Bs[i * m + r] -= u * Bs[j * m + r];
      }
      let s = 0;
      for (let r = 0; r < m; r++) s += Bs[i * m + r] * Bs[i * m + r];
      Bn[i] = s;
    }
  };
  gs();
  let kk = 1, guard = 0;
  while (kk < n && guard++ < 5000) {
    let changed = false;
    let blown = false;
    for (let j = kk - 1; j >= 0; j--) {
      const q = Math.round(mu[kk * n + j]);
      if (q === 0) continue;
      // keep U exactly integral (and so unimodular): stop reducing rather than
      // let an entry pass 2^50
      let big = !Number.isFinite(q);
      for (let t = 0; t < n && !big; t++) if (Math.abs(U[t * n + kk] - q * U[t * n + j]) > 1e15) big = true;
      if (big) { blown = true; break; }
      changed = true;
      for (let t = 0; t < n; t++) U[t * n + kk] -= q * U[t * n + j];
      for (let l = 0; l < j; l++) mu[kk * n + l] -= q * mu[j * n + l];
      mu[kk * n + j] -= q;
    }
    if (changed) setB(kk);
    if (blown) break;
    const u = mu[kk * n + kk - 1];
    if (Bn[kk] < (0.99 - u * u) * Bn[kk - 1]) {
      for (let t = 0; t < n; t++) {
        const tmp = U[t * n + kk];
        U[t * n + kk] = U[t * n + kk - 1];
        U[t * n + kk - 1] = tmp;
      }
      setB(kk);
      setB(kk - 1);
      gs();
      kk = Math.max(kk - 1, 1);
    } else {
      if (changed) gs();
      kk++;
    }
  }
  for (let j = 0; j < n; j++) setB(j);
  gs();
  // a degenerate Gram–Schmidt norm would make the search below unbounded
  for (let t = 0; t < n; t++) {
    if (!(Bn[t] > 0) || !Number.isFinite(Bn[t])) { ctx.aborted = true; return; }
  }

  // Near an algebraic number α0 of lower degree, the multiples m(x)·q(x) of its
  // minimal polynomial m all make p(z0) tiny and would flood the ellipsoid. LLL puts
  // that sublattice first: if the first j basis vectors share a factor of degree
  // d+1−j they span exactly m·Z[x], and the search below skips it.
  let skipJ = 0;
  if (d >= 2 && detectSkip && shareRoot(U, n, 0, 1)) {
    const col = (j) => {
      const v = [];
      for (let t = 0; t < n; t++) v.push(BigInt(U[t * n + j]));
      return v;
    };
    let g = col(0);
    for (let j = 2; j <= d; j++) {
      g = polyGcdBig(g, col(j - 1));
      const dg = g.length - 1;
      if (dg <= 0) break;
      if (dg === d + 1 - j) skipJ = j;
    }
    if (skipJ) ctx.deflated = (ctx.deflated || 0) + 1;
  }

  // Schnorr–Euchner enumeration of y with Σ Bn_i (y_i - c_i)² ≤ C.
  // part[i*n + t] = Σ_{j>i} U[t][j] y[j], so a leaf costs O(n).
  const C = 1 + 1e-9;
  const y = new Float64Array(n), c = new Float64Array(n), l = new Float64Array(n + 1);
  const dx = new Float64Array(n), ddx = new Float64Array(n);
  const part = new Float64Array(n * n);
  const Ut = new Float64Array(n * n); // Ut[j*n + t] = U[t][j]
  for (let t = 0; t < n; t++) for (let j = 0; j < n; j++) Ut[j * n + t] = U[t * n + j];
  const a = new Float64Array(n);
  let i = n - 1;
  c[i] = 0;
  y[i] = 0;
  dx[i] = ddx[i] = 1;
  for (;;) {
    if (++ctx.nodes > ctx.nodeBudget) { ctx.aborted = true; return; }
    const diff = y[i] - c[i];
    const li = l[i + 1] + diff * diff * Bn[i];
    if (li <= C) {
      if (i === 0) {
        // leaf: a = U y
        const y0 = y[0];
        const ad = Ut[d] * y0 + part[d];
        if (ad >= 1) {
          let L1 = 0;
          for (let t = 0; t < n; t++) {
            const v = Ut[t] * y0 + part[t];
            a[t] = v;
            L1 += v < 0 ? -v : v;
          }
          if (L1 >= Llo && L1 <= Lhi && boxOk(F, eps, a, n)) onCand(a, L1);
        }
        y[0] += dx[0];
        ddx[0] = -ddx[0];
        dx[0] = ddx[0] - dx[0];
      } else if (i === skipJ && allZeroFrom(y, skipJ, n)) {
        y[i] += dx[i];
        ddx[i] = -ddx[i];
        dx[i] = ddx[i] - dx[i];
      } else if (i === 1 && allZeroFrom(y, 1, n)) {
        // the multiples k·b_0 with |k| ≥ 2 are not primitive: only ±b_0 can matter
        // (near a number of degree d this line would otherwise hold millions of points)
        if (Bn[0] <= C) {
          for (const sg of [1, -1]) {
            let L1 = 0;
            for (let t = 0; t < n; t++) {
              a[t] = sg * Ut[t];
              L1 += Math.abs(a[t]);
            }
            if (a[d] >= 1 && L1 >= Llo && L1 <= Lhi && boxOk(F, eps, a, n)) onCand(a, L1);
          }
        }
        y[i] += dx[i];
        ddx[i] = -ddx[i];
        dx[i] = ddx[i] - dx[i];
      } else {
        l[i] = li;
        // part for level i-1 = part(i) + U[:, i] y_i
        const yi = y[i], pi = i * n, po = (i - 1) * n, ui = i * n;
        if (i === n - 1) for (let t = 0; t < n; t++) part[po + t] = Ut[ui + t] * yi;
        else for (let t = 0; t < n; t++) part[po + t] = part[pi + t] + Ut[ui + t] * yi;
        i--;
        let s = 0;
        for (let j = i + 1; j < n; j++) s -= mu[j * n + i] * y[j];
        c[i] = s;
        y[i] = Math.round(s);
        dx[i] = ddx[i] = c[i] < y[i] ? -1 : 1;
      }
    } else {
      i++;
      if (i >= n) return;
      y[i] += dx[i];
      ddx[i] = -ddx[i];
      dx[i] = ddx[i] - dx[i];
    }
  }
}

// Cheap test before the exact gcd: do basis vectors j0 and j1 (columns of U, as
// polynomials) have a common root numerically?
function shareRoot(U, n, j0, j1) {
  const col = (j) => {
    const v = [];
    for (let t = 0; t < n; t++) v.push(U[t * n + j]);
    while (v.length > 1 && v[v.length - 1] === 0) v.pop();
    return v;
  };
  const p = col(j0), q = col(j1);
  if (p.length < 2 || q.length < 2) return false;
  if (p.length > q.length) return shareRootOf(q, p);
  return shareRootOf(p, q);
}
function shareRootOf(p, q) {
  const dp = p.length - 1;
  let lo = 0;
  while (p[lo] === 0) lo++;
  if (lo > 0) { // x | p
    if (q[0] === 0) return true;
    p = p.slice(lo);
  }
  if (p.length < 2) return false;
  const r = polyRoots(p, p.length - 1);
  for (let k = 0; k < p.length - 1; k++) {
    const x = r[2 * k], y = r[2 * k + 1];
    let pr = q[q.length - 1], pim = 0, sc = Math.abs(pr);
    const m = Math.hypot(x, y);
    for (let t = q.length - 2; t >= 0; t--) {
      const u = pr * x - pim * y + q[t];
      pim = pr * y + pim * x;
      pr = u;
      sc = sc * m + Math.abs(q[t]);
    }
    if (Math.hypot(pr, pim) <= 1e-6 * sc) return true;
  }
  return false;
}

function allZeroFrom(y, j, n) {
  for (let t = j; t < n; t++) if (y[t] !== 0) return false;
  return true;
}

// flood: estimated number of multiples of a nearby lower-degree minimal polynomial
// in the box. Only the lattice search can skip those, and its volume estimate
// can't know that in advance — so try it on a budget first.
function enumerate(d, Llo, Lhi, F, eps, estDirect, flood, ctx, onCand) {
  if (Lhi < Llo) return;
  const n = d + 1;
  // A functional can't be evaluated more precisely than ~1e-16 · L · max|F_i|.
  // Asking for less (the ρ² bound deep on the real axis) only feeds rounding noise
  // to LLL; relaxing a bound is always safe.
  eps = eps.map((e, i) => {
    let m = 0;
    for (const v of F[i]) m = Math.max(m, Math.abs(v));
    return Math.max(e, 1e-14 * n * Lhi * m);
  });
  estDirect = Math.min(estDirect, ctx.monic ? l1Count(n - 1, Lhi) : l1Count(n, Lhi) / 2);
  const estLat = 3 * latticeEstimate(F, eps, n, Lhi) + 600;
  if (!ctx.force && flood > 1000 && estLat >= estDirect && estLat < 50 * estDirect) {
    const buf = [];
    const sub = { nodes: 0, nodeBudget: Math.max(2e4, estDirect), aborted: false };
    enumLattice(d, Llo, Lhi, F, eps, sub, (a, L1) => buf.push(Float64Array.from(a), L1), true);
    ctx.nodes += sub.nodes;
    if (!sub.aborted) {
      ctx.lattice++;
      for (let t = 0; t < buf.length; t += 2) onCand(buf[t], buf[t + 1]);
      return;
    }
  }
  // (ctx.force lets tests/brute-force.mjs pin one method)
  if (ctx.force ? ctx.force === 'lattice' : estLat < estDirect) {
    ctx.lattice++;
    enumLattice(d, Llo, Lhi, F, eps, ctx, onCand, true);
  } else {
    ctx.direct++;
    enumDirect(d, Llo, Lhi, F, eps, ctx, onCand);
  }
}

// max_{k ≥ j} C(k, j) R^(k - j): bounds |p^(j)(z)/j!| / L1(p) for |z| ≤ R
function derivBound(d, j, R) {
  let best = 0, binom = 1;
  for (let k = j; k <= d; k++) {
    if (k > j) binom = (binom * k) / (k - j);
    best = Math.max(best, binom * Math.pow(R, k - j));
  }
  return best;
}

// Can p have a root in the closed disc |z − z0| ≤ ρ? (Taylor expansion + triangle inequality)
const tr_ = new Float64Array(17), ti_ = new Float64Array(17);
function mayHaveRoot(a, d, cr, ci, rho) {
  for (let k = 0; k <= d; k++) { tr_[k] = a[k]; ti_[k] = 0; }
  for (let j = 0; j < d; j++) {
    for (let k = d - 1; k >= j; k--) {
      const xr = tr_[k + 1], xi = ti_[k + 1];
      tr_[k] += cr * xr - ci * xi;
      ti_[k] += cr * xi + ci * xr;
    }
  }
  const b0 = Math.sqrt(tr_[0] * tr_[0] + ti_[0] * ti_[0]);
  let s = 0, rp = 1;
  for (let j = 1; j <= d; j++) {
    rp *= rho;
    s += Math.sqrt(tr_[j] * tr_[j] + ti_[j] * ti_[j]) * rp;
  }
  return b0 <= s * (1 + 1e-7) + 1e-300;
}

function gcdArr(a, n) {
  let g = 0;
  for (let i = 0; i < n; i++) {
    let x = Math.abs(a[i]), y = g;
    while (x) { const t = y % x; y = x; x = t; }
    g = y;
    if (g === 1) return 1;
  }
  return g;
}

// ---------------------------------------------------------------------------
// Planner: every visible algebraic number whose light reaches the target rect.
//   target: {x0, x1, y0, y1} (world coords, y up)
//   reach(L, d, cls): how far (world units) from the target a dot matters
//   onDot(x, y, L, d, coeffs, cls)
// ---------------------------------------------------------------------------

function isPalindromic(a, d) {
  if (d & 1) return false;
  for (let k = 0; 2 * k < d; k++) if (a[k] !== a[d - k]) return false;
  return true;
}

// Is p a multiple of q.a (the minimal polynomial of q.x + i q.y)?
function divisibleAt(a, d, q) {
  const x = q.x, y = q.y;
  let pr = a[d], pim = 0, sc = Math.abs(a[d]);
  const r = Math.hypot(x, y);
  for (let k = d - 1; k >= 0; k--) {
    const t = pr * x - pim * y + a[k];
    pim = pr * y + pim * x;
    pr = t;
    sc = sc * r + Math.abs(a[k]);
  }
  if (pr * pr + pim * pim > 1e-18 * sc * sc) return false;
  return dividesExact(a, d, q.a, q.d);
}

export function collect(target, cfg, reach, onDot, ctx) {
  ctx.lowDots = [];
  ctx.monic = cfg.monic;
  const halfT = 0.5 * Math.max(target.x1 - target.x0, target.y1 - target.y0);
  const floorReach = reach(1e12, cfg.maxDeg, COMPLEX);
  for (let d = 1; d <= cfg.maxDeg; d++) {
    if (d >= 2) planTiers(d, maxLength(cfg, d, COMPLEX), false);
    planTiers(d, maxLength(cfg, d, REAL), true);
  }

  function planTiers(d, Lmax, isReal) {
    let L = 1;
    while (L <= Lmax && !ctx.aborted) {
      const m = reach(L, d, isReal ? REAL : COMPLEX);
      let L2;
      if (m <= Math.max(0.3 * halfT, floorReach * 1.0001)) L2 = Lmax;
      else {
        // largest L2 with reach(L2) > m/2 (reach is non-increasing in L)
        let lo = L, hi = Lmax;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if (reach(mid, d, isReal ? REAL : COMPLEX) > 0.5 * m) lo = mid;
          else hi = mid - 1;
        }
        L2 = lo;
      }
      runTier(d, L, L2, m, isReal);
      L = L2 + 1;
    }
  }

  function runTier(d, Llo, Lhi, m, isReal) {
    const rx0 = target.x0 - m, rx1 = target.x1 + m, ry0 = target.y0 - m, ry1 = target.y1 + m;
    const cx = 0.5 * (rx0 + rx1), cy = 0.5 * (ry0 + ry1);
    const hw = 0.5 * (rx1 - rx0), hh = 0.5 * (ry1 - ry0);
    const n = d + 1;
    const pw = new Float64Array(n);
    // tuples of v leading coefficients (a_d first) with L1 ≤ Lhi
    const free = (v) => (cfg.monic ? l1Count(v - 1, Lhi) : l1Count(v, Lhi) / 2);
    let F, eps, estDirect, tc, tr, trad, kind;
    // monic: the extra box constraint |a_d| ≤ 1 keeps the lattice homogeneous
    const pinLeading = (o) => {
      const e = new Array(n).fill(0);
      e[d] = 1;
      o.F = [...o.F, e];
      o.eps = [...o.eps, 1];
      return o;
    };
    if (isReal) {
      if (ry0 > 0 || ry1 < 0) return;
      // |p(x0)| ≤ w · max|p'| on the interval
      const R = Math.abs(cx) + hw;
      const B1 = Math.min(derivBound(d, 1, R), Math.pow(1 + Math.abs(cx), d - 1) / Math.max(1, Math.abs(cx) - hw));
      pw[0] = 1;
      for (let t = 1; t < n; t++) pw[t] = pw[t - 1] * cx;
      F = [Array.from(pw)];
      eps = [hw * Lhi * B1];
      // a_d … a_1 free, a_0 pinned to an interval by p(x0)
      estDirect = free(d) * Math.min(2 * Lhi + 1, 2 * eps[0] + 1);
      tc = cx; tr = 0; trad = hw; kind = 2;
      if (cfg.monic) ({ F, eps } = pinLeading({ F, eps }));
    } else {
      const rho = Math.hypot(hw, hh);
      let disc = null;
      if (Math.abs(cy) > rho) {
        // disc around z0 that stays off the real axis: |p(z0)| ≤ ρ · max|p'|.
        // Every root in it is non-real, so also |p(z0)| = |z0−α||z0−ᾱ||p[z0,α,ᾱ]|
        // ≤ ρ (2|y0| + 3ρ) max|p''|/2 — much tighter close to the axis, where the
        // nearby conjugate makes every |p'(α)| small.
        const az = Math.hypot(cx, cy), R = az + rho;
        const B1 = Math.min(derivBound(d, 1, R), Math.pow(1 + az, d - 1) / Math.max(1, az - rho));
        const R2 = az + 2 * Math.abs(cy) + 3 * rho;
        const B2 = d >= 2 ? Math.min(derivBound(d, 2, R2), Math.pow(1 + az, d - 2) / Math.pow(Math.max(1, az - rho), 2)) : Infinity;
        const re = new Float64Array(n), im = new Float64Array(n);
        re[0] = 1;
        for (let t = 1; t < n; t++) {
          re[t] = re[t - 1] * cx - im[t - 1] * cy;
          im[t] = re[t - 1] * cy + im[t - 1] * cx;
        }
        const e = rho * Lhi * Math.min(B1, (2 * Math.abs(cy) + 3 * rho) * B2);
        disc = {
          F: [Array.from(re), Array.from(im)],
          eps: [e, e],
          // a_d … a_2 free, a_1 pinned by Im p(z0), a_0 by Re p(z0)
          estDirect: free(d - 1) * Math.min(2 * Lhi + 1, (2 * e) / Math.abs(cy) + 1) * Math.min(2 * Lhi + 1, 2 * e + 1),
          tc: cx, tr: cy, trad: rho, kind: 0,
        };
      }
      // Near the real axis: a conjugate pair α, ᾱ near x0 makes both p(x0) and
      // p'(x0) small (O(ρ²) and O(ρ)), while polynomials with only a real root nearby
      // have p'(x0) of normal size — so they are not enumerated.
      const Y = Math.abs(cy) + hh, w = hw;
      const r2 = w * w + Y * Y, rho2 = Math.sqrt(r2), ax = Math.abs(cx), R = ax + rho2;
      const den = Math.pow(Math.max(1, ax - rho2), 2);
      const S0 = Lhi * Math.min(derivBound(d, 2, R), Math.pow(1 + ax, d - 2) / den);
      const S1 = d >= 3 ? Lhi * Math.min(derivBound(d, 3, R), ((d - 2) * Math.pow(1 + ax, d - 3)) / den) : 0;
      const p0 = new Float64Array(n), p1 = new Float64Array(n);
      p0[0] = 1;
      for (let t = 1; t < n; t++) p0[t] = p0[t - 1] * cx;
      for (let t = 1; t < n; t++) p1[t] = t * p0[t - 1];
      const e1 = r2 * S0, e2 = 2 * w * S0 + r2 * S1;
      const axis = {
        F: [Array.from(p0), Array.from(p1)],
        eps: [e1, e2],
        // a_1 pinned by p'(x0), a_0 by p(x0)
        estDirect: free(d - 1) * Math.min(2 * Lhi + 1, 2 * e2 + 1) * Math.min(2 * Lhi + 1, 2 * e1 + 1),
        tc: cx, tr: 0, trad: rho2, kind: 1,
      };
      if (cfg.monic) for (const o of [disc, axis]) if (o) pinLeading(o);
      let pick = axis;
      if (disc) {
        const cost = (o) => Math.min(o.estDirect, 3 * latticeEstimate(o.F, o.eps, n, Lhi));
        if (cost(disc) <= cost(axis)) pick = disc;
      }
      ({ F, eps, estDirect, tc, tr, trad, kind } = pick);
    }
    // lower-degree algebraic numbers inside the region: reject their multiples cheaply
    const defl = [];
    for (const q of ctx.lowDots) {
      if (q.d >= d || q.L * 2 > Lhi) continue;
      if (q.x < rx0 || q.x > rx1 || q.y < ry0 || q.y > ry1) continue;
      defl.push(q);
    }
    defl.sort((u, v) => u.L - v.L);
    if (defl.length > 24) defl.length = 24;
    let flood = 0;
    for (const q of defl) flood = Math.max(flood, l1Count(d - q.d + 1, Math.floor(Lhi / q.L)) / 2);
    enumerate(d, Llo, Lhi, F, eps, estDirect, flood, ctx, (a, L1) => {
      ctx.cands++;
      if (d > 1 && a[0] === 0) return;
      if (gcdArr(a, n) !== 1) return;
      if (!mayHaveRoot(a, d, tc, tr, trad)) return;
      for (const q of defl) if (divisibleAt(a, d, q)) return;
      ctx.rootCalls++;
      const palin = isPalindromic(a, d);
      const LmaxCircle = palin ? maxLength(cfg, d, CIRCLE) : 0;
      const e = memoGet(a, d);
      const roots = e.roots;
      let any = false;
      for (let t = 0; t < d; t++) {
        const x = roots[2 * t], y = roots[2 * t + 1];
        if ((y === 0) !== isReal) continue;
        let cls = isReal ? REAL : COMPLEX;
        if (palin && Math.abs(x * x + y * y - 1) < 1e-11) {
          cls = CIRCLE;
          if (L1 > LmaxCircle) continue;
        }
        if (x < rx0 || x > rx1 || y < ry0 || y > ry1) continue;
        const ddx = x < target.x0 ? target.x0 - x : x > target.x1 ? x - target.x1 : 0;
        const ddy = y < target.y0 ? target.y0 - y : y > target.y1 ? y - target.y1 : 0;
        const rr = reach(L1, d, cls);
        if (ddx * ddx + ddy * ddy > rr * rr) continue;
        if (!any) {
          if (e.irr < 0) e.irr = isIrreducible(a, d, roots) ? 1 : 0;
          if (!e.irr) return;
          any = true;
        }
        if (d < cfg.maxDeg) ctx.lowDots.push({ x, y, L: L1, d, a: Array.from(a) });
        onDot(x, y, L1, d, a, cls);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Tile rendering
// ---------------------------------------------------------------------------

function dotColor(cfg, d, lead) {
  if (cfg.colorMode === 'degree') return DEGREE_COLORS[Math.min(d, 8)];
  if (lead >= 5) return cfg.highLead ? LEAD_COLORS[5] : null;
  return LEAD_COLORS[lead];
}

// Profiles as functions of u = (ρ/r)², tabulated up to U_MAX.
const LUT_N = 4096, U_MAX = 100;
function makeLuts(cfg) {
  const core = new Float32Array(LUT_N + 1), halo = new Float32Array(LUT_N + 1);
  const k2 = cfg.haloK * cfg.haloK;
  for (let i = 0; i <= LUT_N; i++) {
    const u = (i / LUT_N) * U_MAX;
    core[i] = Math.exp(-Math.pow(u, cfg.coreP));
    halo[i] = Math.exp(-u / k2);
  }
  return { core, halo, scale: LUT_N / U_MAX };
}

// z: zoom level, (i, j): tile indices. Returns RGBA pixels and stats.
export function renderTile(settings, z, i, j, dpr) {
  const t0 = Date.now();
  const sCss = S0_CSS * Math.pow(2, z);
  const cfg = makeConfig(settings, sCss, dpr);
  const sDev = cfg.sDev;
  const h = TILE / sDev;
  const target = { x0: i * h, x1: (i + 1) * h, y0: j * h, y1: (j + 1) * h };
  const ctx = { nodes: 0, nodeBudget: cfg.nodeBudget, aborted: false, cands: 0, rootCalls: 0, lattice: 0, direct: 0 };
  const acc = new Float32Array(TILE * TILE * 3);
  const luts = makeLuts(cfg), lutScale = luts.scale;
  let dots = 0;
  const reach = (L, d, cls) => glowReach(cfg, L, d, cls);
  collect(target, cfg, reach, (x, y, L, d, a, cls) => {
    const col = dotColor(cfg, d, a[d]);
    if (!col) return;
    dots++;
    const rCss = radiusCss(cfg, L, d, cls);
    const rDev = rCss * dpr;
    const A = peakIntensity(cfg, rCss);
    const hw = haloWeight(cfg, rCss);
    const px = (x - target.x0) * sDev, py = (target.y1 - y) * sDev;
    if (rDev < 0.7) {
      const e = A * Math.PI * (1 + hw * cfg.haloK * cfg.haloK) * rDev * rDev;
      const fx = px - 0.5, fy = py - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy;
      for (let oy = 0; oy < 2; oy++) {
        const yy = iy + oy;
        if (yy < 0 || yy >= TILE) continue;
        const wy = oy ? ty : 1 - ty;
        for (let ox = 0; ox < 2; ox++) {
          const xx = ix + ox;
          if (xx < 0 || xx >= TILE) continue;
          const w = e * wy * (ox ? tx : 1 - tx);
          const o = (yy * TILE + xx) * 3;
          acc[o] += w * col[0];
          acc[o + 1] += w * col[1];
          acc[o + 2] += w * col[2];
        }
      }
      return;
    }
    const E = splatExtent(cfg, rCss);
    const R = E * rDev, uMax = E * E;
    const taperK = 1 / uMax;
    const xa = Math.max(0, Math.floor(px - R)), xb = Math.min(TILE - 1, Math.ceil(px + R));
    const ya = Math.max(0, Math.floor(py - R)), yb = Math.min(TILE - 1, Math.ceil(py + R));
    const inv = 1 / (rDev * rDev);
    const c0 = A * col[0], c1 = A * col[1], c2 = A * col[2];
    const { core, halo } = luts;
    for (let yy = ya; yy <= yb; yy++) {
      const dy = yy + 0.5 - py;
      const dy2 = dy * dy * inv;
      if (dy2 >= uMax) continue;
      let o = (yy * TILE + xa) * 3;
      for (let xx = xa; xx <= xb; xx++, o += 3) {
        const dxp = xx + 0.5 - px;
        const u = dxp * dxp * inv + dy2;
        if (u >= uMax) continue;
        const li = (u * lutScale) | 0;
        const t = 1 - u * taperK;
        const v = (core[li] + hw * halo[li]) * t * t;
        acc[o] += v * c0;
        acc[o + 1] += v * c1;
        acc[o + 2] += v * c2;
      }
    }
  }, ctx);

  // tone map: 1 − e^(−exposure · light)
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  const ex = cfg.exposure;
  for (let p = 0, q = 0; p < TILE * TILE; p++, q += 3) {
    px[4 * p] = 255 * (1 - Math.exp(-ex * acc[q]));
    px[4 * p + 1] = 255 * (1 - Math.exp(-ex * acc[q + 1]));
    px[4 * p + 2] = 255 * (1 - Math.exp(-ex * acc[q + 2]));
    px[4 * p + 3] = 255;
  }
  return {
    pixels: px,
    stats: { ms: Date.now() - t0, dots, nodes: ctx.nodes, cands: ctx.cands, rootCalls: ctx.rootCalls, lattice: ctx.lattice, direct: ctx.direct, aborted: ctx.aborted },
  };
}
