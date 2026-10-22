// Checks the tile enumeration against brute force: for each test tile, every
// integer polynomial up to the length bound is tried, and the set of dots must
// match exactly — for the automatic choice and with each method forced.
//
//   node tests/brute-force.mjs
import {
  collect, makeConfig, maxLength, glowReach, polyRoots, isIrreducible,
  S0_CSS, TILE, COMPLEX, REAL, CIRCLE,
} from '../js/core.js';

// all polynomials of degree d with a_d ≥ 1 and |a_0| + … + |a_d| ≤ Lmax
function* polys(d, Lmax) {
  const a = new Array(d + 1).fill(0);
  function* rec(j, rem) {
    for (let v = j === d ? 1 : -rem; v <= rem; v++) {
      a[j] = v;
      if (j === 0) yield a.slice();
      else yield* rec(j - 1, rem - Math.abs(v));
    }
  }
  yield* rec(d, Lmax);
}

const gcd = (a, b) => {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
};

function dotsByEnumeration(cfg, target, force) {
  const reach = (L, d, cls) => glowReach(cfg, L, d, cls);
  const got = new Set();
  const ctx = { nodes: 0, nodeBudget: 1e9, aborted: false, cands: 0, rootCalls: 0, lattice: 0, direct: 0, force };
  collect(target, cfg, reach, (x, y, L, d, a) => got.add(`${Array.from(a)}@${x.toFixed(9)},${y.toFixed(9)}`), ctx);
  return got;
}

function dotsByBruteForce(cfg, target) {
  const reach = (L, d, cls) => glowReach(cfg, L, d, cls);
  const want = new Set();
  for (let d = 1; d <= cfg.maxDeg; d++) {
    const Lmax = [d >= 2 ? maxLength(cfg, d, COMPLEX) : 0, maxLength(cfg, d, REAL), maxLength(cfg, d, CIRCLE)];
    const palindromic = (a) => d % 2 === 0 && a.every((v, k) => v === a[d - k]);
    for (const a of polys(d, Math.max(...Lmax))) {
      if ((d > 1 && a[0] === 0) || a.reduce(gcd, 0) !== 1) continue;
      if (cfg.monic && a[d] !== 1) continue;
      const L = a.reduce((s, v) => s + Math.abs(v), 0);
      const r = polyRoots(a, d);
      let irreducible = null;
      for (let t = 0; t < d; t++) {
        const x = r[2 * t], y = r[2 * t + 1];
        const cls = y === 0 ? REAL : palindromic(a) && Math.abs(x * x + y * y - 1) < 1e-11 ? CIRCLE : COMPLEX;
        if (L > Lmax[cls]) continue;
        const dx = Math.max(target.x0 - x, 0, x - target.x1), dy = Math.max(target.y0 - y, 0, y - target.y1);
        if (Math.hypot(dx, dy) > reach(L, d, cls)) continue;
        if (irreducible === null) irreducible = isIrreducible(a, d, r);
        if (!irreducible) break;
        want.add(`${a}@${x.toFixed(9)},${y.toFixed(9)}`);
      }
    }
  }
  return want;
}

// [zoom level, settings, a point inside the tile]
const CASES = [
  [0, { maxDeg: 4 }, [0.3, 0.9]],             // off the axis
  [0, { maxDeg: 4 }, [1.1, 0.1]],             // touching the real axis
  [2, { maxDeg: 4 }, [0.01, 1.3]],
  [2, { maxDeg: 4 }, [0.55, 0.01]],
  [3, { maxDeg: 3 }, [0.0001, 1.0001]],       // contains i
  [3, { maxDeg: 3 }, [1.0001, 0.0001]],       // contains 1
  [3, { maxDeg: 3 }, [0.5001, 0.0001]],       // contains 1/2
  [1, { maxDeg: 4 }, [0.0001, 1.0001]],
  [2, { maxDeg: 4 }, [0.5001, 0.866]],        // near e^{iπ/3}
  [0, { maxDeg: 4, numbers: 'integers' }, [0.3, 0.9]],
  [2, { maxDeg: 4, numbers: 'integers' }, [0.55, 0.01]],
];

let failures = 0;
for (const [z, settings, [px, py]] of CASES) {
  const cfg = makeConfig(settings, S0_CSS * 2 ** z, 1);
  const h = TILE / cfg.sDev;
  const i = Math.floor(px / h), j = Math.floor(py / h);
  const target = { x0: i * h, x1: (i + 1) * h, y0: j * h, y1: (j + 1) * h };
  const want = dotsByBruteForce(cfg, target);
  for (const force of [undefined, 'lattice', 'direct']) {
    const got = dotsByEnumeration(cfg, target, force);
    const missing = [...want].filter((k) => !got.has(k));
    const extra = [...got].filter((k) => !want.has(k));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} z=${z} ${JSON.stringify(settings)} near (${px}, ${py}) ${force || 'auto'}: ${want.size} dots`
      + (ok ? '' : `, missing ${missing.length} ${missing.slice(0, 3)}, extra ${extra.length} ${extra.slice(0, 3)}`));
  }
}
console.log(failures ? `${failures} failures` : 'all passed');
process.exit(failures ? 1 : 0);
