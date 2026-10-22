// algebra.js — exact algebra for the info panel: formatting, discriminants,
// factorisation mod ℓ (maximal ideals of Z[x] over the ideal (p)), closed forms,
// classification, and parsing what the user types into the search box.
import { polyRoots, findFactor, polyGcdBig } from './core.js';

// ---------------------------------------------------------------------------
// Formatting (coefficient arrays are low → high)
// ---------------------------------------------------------------------------

const sup = (k) => (k === 1 ? '' : `^{${k}}`);

// LaTeX for Σ c_k x^k; coefficients may be numbers, BigInts or {n, d} fractions.
export function polyTex(c, v = 'x') {
  const terms = [];
  for (let k = c.length - 1; k >= 0; k--) {
    let { n, d } = asFrac(c[k]);
    if (n === 0n) continue;
    const neg = n < 0n;
    if (neg) n = -n;
    let body;
    if (d === 1n) {
      body = k === 0 ? `${n}` : n === 1n ? '' : `${n}`;
    } else {
      body = `\\tfrac{${n}}{${d}}`;
    }
    if (k > 0) body += `${v}${sup(k)}`;
    terms.push({ neg, body });
  }
  if (!terms.length) return '0';
  return terms.map((t, i) => (i === 0 ? (t.neg ? '-' : '') + t.body : (t.neg ? ' - ' : ' + ') + t.body)).join('');
}

// Plain-text polynomial with Unicode superscripts (tooltips, clipboard).
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
export function polyText(c, v = 'x', ascii = false) {
  const parts = [];
  for (let k = c.length - 1; k >= 0; k--) {
    let n = Number(c[k]);
    if (n === 0) continue;
    const neg = n < 0;
    n = Math.abs(n);
    let s = k === 0 || n !== 1 ? `${n}` : '';
    if (k > 0) s += v + (k === 1 ? '' : ascii ? `^${k}` : String(k).split('').map((ch) => SUP[ch]).join(''));
    parts.push(parts.length === 0 ? (neg ? '-' : '') + s : (neg ? ' - ' : ' + ') + s);
  }
  return parts.join('') || '0';
}

function asFrac(x) {
  if (typeof x === 'object' && x !== null && 'n' in x) return x;
  return { n: BigInt(x), d: 1n };
}

const gcdB = (a, b) => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};

function frac(n, d) {
  if (d < 0n) { n = -n; d = -d; }
  const g = gcdB(n, d) || 1n;
  return { n: n / g, d: d / g };
}

// Monic minimal polynomial over Q.
export function monicCoeffs(a) {
  const ad = BigInt(a[a.length - 1]);
  return a.map((v) => frac(BigInt(v), ad));
}

export function formatComplex(x, y, digits = 12) {
  const f = (v) => {
    if (Math.abs(v) < 1e-300) return '0';
    const s = Math.abs(v) >= 1e6 || Math.abs(v) < 1e-4 ? v.toExponential(digits - 1) : v.toPrecision(digits);
    return s.includes('e') ? s : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  };
  if (y === 0) return f(x);
  const ay = f(Math.abs(y));
  const im = ay === '1' ? 'i' : `${ay}i`;
  if (x === 0) return (y < 0 ? '−' : '') + im;
  return `${f(x)} ${y < 0 ? '−' : '+'} ${im}`;
}

// ---------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------

// Trial-division factorisation (up to `limit`); returns {factors: [[p, e]], rest}.
export function factorInteger(n, limit = 2e5) {
  n = n < 0n ? -n : n;
  const factors = [];
  for (let p = 2n; p * p <= n && p <= BigInt(limit); p += p === 2n ? 1n : 2n) {
    let e = 0;
    while (n % p === 0n) { n /= p; e++; }
    if (e) factors.push([p, e]);
  }
  let rest = 1n;
  if (n > 1n) {
    if (n <= BigInt(limit) * BigInt(limit)) factors.push([n, 1]);
    else rest = n;
  }
  return { factors, rest };
}

function detBareiss(M) {
  const n = M.length;
  let sign = 1n, prev = 1n;
  for (let k = 0; k < n - 1; k++) {
    if (M[k][k] === 0n) {
      let r = k + 1;
      while (r < n && M[r][k] === 0n) r++;
      if (r === n) return 0n;
      [M[k], M[r]] = [M[r], M[k]];
      sign = -sign;
    }
    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) M[i][j] = (M[i][j] * M[k][k] - M[i][k] * M[k][j]) / prev;
    }
    prev = M[k][k];
  }
  return sign * M[n - 1][n - 1];
}

function resultant(p, q) {
  // p, q: BigInt arrays low → high
  const m = p.length - 1, n = q.length - 1;
  const N = m + n;
  const M = Array.from({ length: N }, () => new Array(N).fill(0n));
  for (let r = 0; r < n; r++) for (let k = 0; k <= m; k++) M[r][r + k] = p[m - k];
  for (let r = 0; r < m; r++) for (let k = 0; k <= n; k++) M[n + r][r + k] = q[n - k];
  return detBareiss(M);
}

export function discriminant(a) {
  const d = a.length - 1;
  const P = a.map((v) => BigInt(v));
  if (d === 1) return 1n;
  const D = P.slice(1).map((v, k) => v * BigInt(k + 1));
  const res = resultant(P, D);
  const sign = (d * (d - 1)) / 2 % 2 === 0 ? 1n : -1n;
  return (sign * res) / P[d];
}

// ---------------------------------------------------------------------------
// Polynomials over F_ℓ
// ---------------------------------------------------------------------------

const mod = (a, m) => ((a % m) + m) % m;
function invMod(a, m) {
  let [r0, r1, s0, s1] = [a, m, 1, 0];
  while (r1) {
    const q = Math.floor(r0 / r1);
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}
function trimP(f) {
  let n = f.length;
  while (n > 0 && f[n - 1] === 0) n--;
  return f.slice(0, n);
}
// Divide f by monic g over F_ℓ: [quotient, remainder].
function divModP(f, g, l) {
  const r = f.slice(), dg = g.length - 1;
  const q = new Array(Math.max(0, r.length - dg)).fill(0);
  for (let i = r.length - 1; i >= dg; i--) {
    const c = r[i];
    if (!c) continue;
    q[i - dg] = c;
    for (let k = 0; k <= dg; k++) r[i - dg + k] = mod(r[i - dg + k] - c * g[k], l);
  }
  return [q, trimP(r.slice(0, dg))];
}

// p mod ℓ = unit · ∏ g_i^e_i with monic irreducible g_i (trial division by
// all monic polynomials of increasing degree).
export function factorModP(a, l) {
  let f = trimP(a.map((v) => mod(Number(BigInt(v) % BigInt(l)), l)));
  if (f.length <= 1) return { unit: f[0] || 0, factors: [] };
  const lc = f[f.length - 1];
  const inv = invMod(lc, l);
  f = f.map((v) => mod(v * inv, l));
  const factors = [];
  for (let k = 1; f.length - 1 >= 1; k++) {
    if (f.length - 1 < 2 * k) {
      factors.push({ g: f, e: 1 });
      break;
    }
    const total = Math.pow(l, k);
    if (total > 2e5) { // too many trial divisors: leave the rest unfactored
      factors.push({ g: f, e: 1, unknown: true });
      break;
    }
    const g = new Array(k + 1).fill(0);
    g[k] = 1;
    for (let idx = 0; idx < total; idx++) {
      let t = idx;
      for (let j = 0; j < k; j++) { g[j] = t % l; t = Math.floor(t / l); }
      let e = 0;
      for (;;) {
        const [q, r] = divModP(f, g, l);
        if (r.length) break;
        f = q;
        e++;
      }
      if (e) factors.push({ g: g.slice(), e });
      if (f.length - 1 < 2 * k) break;
    }
  }
  return { unit: lc, factors };
}

// ---------------------------------------------------------------------------
// Factorisation over Z (degrees here are small)
// ---------------------------------------------------------------------------

function contentOf(a) {
  let g = 0n;
  for (const v of a) g = gcdB(g, BigInt(v));
  return g || 1n;
}

export function primitive(a) {
  const g = contentOf(a);
  let b = a.map((v) => Number(BigInt(v) / g));
  while (b.length > 1 && b[b.length - 1] === 0) b.pop();
  if (b[b.length - 1] < 0) b = b.map((v) => -v);
  return b;
}

function divExact(a, q) {
  const A = a.map(BigInt), Q = q.map(BigInt);
  const dq = Q.length - 1, out = new Array(A.length - dq).fill(0n);
  for (let i = A.length - 1; i >= dq; i--) {
    const c = A[i] / Q[dq];
    out[i - dq] = c;
    for (let k = 0; k <= dq; k++) A[i - dq + k] -= c * Q[k];
  }
  return out.map(Number);
}

// Irreducible primitive factors of a (with multiplicity), positive leading coefficient.
export function factorOverZ(a) {
  const out = [];
  const rec = (f) => {
    f = primitive(f);
    const d = f.length - 1;
    if (d < 1) return;
    if (d === 1) { out.push(f); return; }
    const q = findFactor(f, d, polyRoots(f, d));
    if (!q) { out.push(f); return; }
    const g = primitive(q);
    rec(g);
    rec(divExact(f, g));
  };
  rec(a);
  return out;
}

// ---------------------------------------------------------------------------
// Closed forms and classification
// ---------------------------------------------------------------------------

function squarefreeSplit(n) {
  // n = s² · m with m squarefree (as far as trial division goes); n > 0
  let s = 1n, m = 1n;
  const { factors, rest } = factorInteger(n, 1e5);
  for (const [p, e] of factors) {
    s *= p ** BigInt(Math.floor(e / 2));
    if (e % 2) m *= p;
  }
  return { s, m: m * rest };
}

// LaTeX closed form for degree ≤ 2, else null.
export function closedForm(a, x, y) {
  const d = a.length - 1;
  if (d === 1) {
    const f = frac(-BigInt(a[0]), BigInt(a[1]));
    return f.d === 1n ? `${f.n}` : `${f.n < 0n ? '-' : ''}\\frac{${f.n < 0n ? -f.n : f.n}}{${f.d}}`;
  }
  if (d !== 2) return null;
  const A = BigInt(a[2]), B = BigInt(a[1]), C = BigInt(a[0]);
  const D = B * B - 4n * A * C;
  const neg = D < 0n;
  const { s, m } = squarefreeSplit(neg ? -D : D);
  const sign = neg ? (y > 0 ? 1 : -1) : x > Number(-B) / Number(2n * A) ? 1 : -1;
  // α = (−B + sign·s·√(±m)) / 2A, reduced by g = gcd(B, s, 2A)
  let g = gcdB(gcdB(B, s), 2n * A);
  const num = -B / g, rs = s / g, den = (2n * A) / g;
  const rad = m === 1n ? (neg ? 'i' : '') : neg ? `\\sqrt{${m}}\\,i` : `\\sqrt{${m}}`;
  const radTerm = (rs === 1n ? '' : `${rs}`) + rad;
  let top;
  if (num === 0n) top = (sign < 0 ? '-' : '') + radTerm;
  else top = `${num} ${sign < 0 ? '-' : '+'} ${radTerm}`;
  return den === 1n ? top : `\\frac{${top}}{${den}}`;
}

function eulerPhi(n) {
  let r = n;
  for (let p = 2; p * p <= n; p++) {
    if (n % p === 0) {
      while (n % p === 0) n /= p;
      r -= r / p;
    }
  }
  if (n > 1) r -= r / n;
  return r;
}

export function describe(a, x, y) {
  const d = a.length - 1;
  const roots = polyRoots(a, d);
  const conj = [];
  for (let k = 0; k < d; k++) conj.push({ x: roots[2 * k], y: roots[2 * k + 1] });
  const lead = Math.abs(a[d]);
  const isInt = lead === 1;
  const isUnit = isInt && Math.abs(a[0]) === 1;
  const r1 = conj.filter((c) => c.y === 0).length;
  const mods = conj.map((c) => Math.hypot(c.x, c.y));
  const house = Math.max(...mods);
  const mahler = lead * mods.reduce((m, r) => m * Math.max(1, r), 1);
  const height = Math.max(...a.map(Math.abs));
  const length = a.reduce((s, v) => s + Math.abs(v), 0);
  const tags = [];
  let rootOfUnity = 0;
  if (isInt && mods.every((r) => Math.abs(r - 1) < 1e-9)) {
    const t = Math.atan2(y, x) / (2 * Math.PI);
    for (let n = 1; n <= 400; n++) {
      if (Math.abs(n * t - Math.round(n * t)) < 1e-8 && eulerPhi(n) === d) { rootOfUnity = n; break; }
    }
  }
  const self = Math.hypot(x, y);
  const others = mods.filter((_, k) => Math.hypot(conj[k].x - x, conj[k].y - y) > 1e-12);
  if (isInt && y === 0 && x > 1 && d >= 2) {
    if (others.every((r) => r < 1 - 1e-9)) tags.push('Pisot number');
    else if (d >= 4 && others.every((r) => r < 1 + 1e-9) && others.some((r) => Math.abs(r - 1) < 1e-9)) tags.push('Salem number');
  }
  if (r1 === d && d > 1) tags.push('totally real');
  if (r1 === 0 && d > 1 && Math.abs(self - 1) < 1e-12) tags.push('on the unit circle');
  const disc = discriminant(a);
  return { d, conj, lead, isInt, isUnit, r1, r2: (d - r1) / 2, house, mahler, height, length, tags, rootOfUnity, disc };
}

// Minimal polynomial of a_d·α (an algebraic integer): x^d + a_{d−1} x^{d−1} + a_{d−2} a_d x^{d−2} + …
export function scaledToInteger(a) {
  const d = a.length - 1, ad = BigInt(a[d]);
  return a.map((v, k) => (k === d ? 1n : BigInt(v) * ad ** BigInt(d - 1 - k)));
}

// ---------------------------------------------------------------------------
// Parsing user input
// ---------------------------------------------------------------------------

// "x^3 - x - 1", "2x^2+x+1", "3*x**4 - 2 x + 7" → integer coefficients (low → high)
export function parsePolynomial(str) {
  const s = str.replace(/\s+/g, '').replace(/[−–]/g, '-').replace(/\*\*/g, '^').replace(/·/g, '*');
  const vm = s.match(/[xzt]/);
  if (!vm) return null;
  const v = vm[0];
  if (new RegExp(`[^0-9${v}+\\-*^]`).test(s)) return null;
  const terms = s.match(/[+-]?[^+-]+/g);
  if (!terms) return null;
  const c = [];
  for (const t of terms) {
    const m = t.match(new RegExp(`^([+-]?)(\\d*)\\*?(${v}(?:\\^(\\d+))?)?$`));
    if (!m || (!m[2] && !m[3])) return null;
    const coef = BigInt(m[2] || '1') * (m[1] === '-' ? -1n : 1n);
    const k = m[3] ? (m[4] ? parseInt(m[4], 10) : 1) : 0;
    if (k > 12) return null;
    while (c.length <= k) c.push(0n);
    c[k] += coef;
  }
  while (c.length > 1 && c[c.length - 1] === 0n) c.pop();
  if (c.length < 2) return null;
  if (c.some((x) => x > BigInt(Number.MAX_SAFE_INTEGER) || x < -BigInt(Number.MAX_SAFE_INTEGER))) return null;
  return c.map(Number);
}

// Complex expression: numbers, i, pi, e, + − * / ^, sqrt cbrt exp ln, parentheses.
export function parseComplex(str) {
  const src = str.replace(/\s+/g, '').replace(/[−–]/g, '-').replace(/√/g, 'sqrt').replace(/π/g, 'pi').replace(/\*\*/g, '^');
  let pos = 0;
  const peek = () => src[pos];
  const C = (re, im = 0) => ({ re, im });
  const add = (a, b) => C(a.re + b.re, a.im + b.im);
  const sub = (a, b) => C(a.re - b.re, a.im - b.im);
  const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const div = (a, b) => {
    const m = b.re * b.re + b.im * b.im;
    return C((a.re * b.re + a.im * b.im) / m, (a.im * b.re - a.re * b.im) / m);
  };
  const cexp = (a) => C(Math.exp(a.re) * Math.cos(a.im), Math.exp(a.re) * Math.sin(a.im));
  const clog = (a) => C(Math.log(Math.hypot(a.re, a.im)), Math.atan2(a.im, a.re));
  const cpow = (a, b) => {
    if (b.im === 0 && Number.isInteger(b.re) && Math.abs(b.re) <= 64) {
      let r = C(1), base = b.re < 0 ? div(C(1), a) : a;
      for (let k = 0; k < Math.abs(b.re); k++) r = mul(r, base);
      return r;
    }
    if (a.re === 0 && a.im === 0) return C(0);
    return cexp(mul(b, clog(a)));
  };
  const fns = {
    sqrt: (a) => cpow(a, C(0.5)),
    cbrt: (a) => (a.im === 0 ? C(Math.cbrt(a.re)) : cpow(a, C(1 / 3))),
    exp: cexp,
    ln: clog,
    log: clog,
  };
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[pos++];
      const r = term();
      v = op === '+' ? add(v, r) : sub(v, r);
    }
    return v;
  }
  function term() {
    let v = unary();
    for (;;) {
      if (peek() === '*' || peek() === '/') {
        const op = src[pos++];
        const r = unary();
        v = op === '*' ? mul(v, r) : div(v, r);
      } else if (peek() && /[0-9.a-z(]/i.test(peek())) {
        v = mul(v, unary()); // implicit multiplication: 2i, 3sqrt(2)
      } else return v;
    }
  }
  function unary() {
    if (peek() === '-') { pos++; const v = unary(); return C(-v.re, -v.im); }
    if (peek() === '+') { pos++; return unary(); }
    return power();
  }
  function power() {
    const b = atom();
    if (peek() === '^') { pos++; return cpow(b, unary()); }
    return b;
  }
  function atom() {
    const ch = peek();
    if (ch === '(') {
      pos++;
      const v = expr();
      if (src[pos++] !== ')') throw new Error('paren');
      return v;
    }
    const num = src.slice(pos).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
    if (num) { pos += num[0].length; return C(parseFloat(num[0])); }
    const id = src.slice(pos).match(/^[a-z]+/i);
    if (id) {
      const w = id[0].toLowerCase();
      for (const name of Object.keys(fns)) {
        if (w.startsWith(name)) {
          pos += name.length;
          return fns[name](atom());
        }
      }
      if (w.startsWith('pi')) { pos += 2; return C(Math.PI); }
      if (w[0] === 'i') { pos += 1; return C(0, 1); }
      if (w[0] === 'e') { pos += 1; return C(Math.E); }
    }
    throw new Error('bad input');
  }
  try {
    const v = expr();
    if (pos !== src.length || !Number.isFinite(v.re) || !Number.isFinite(v.im)) return null;
    return { x: v.re, y: v.im };
  } catch {
    return null;
  }
}

export { polyGcdBig };
