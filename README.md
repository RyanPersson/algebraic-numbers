# Algebraic numbers map

An infinitely zoomable picture of the algebraic numbers in the complex plane. Click
any dot to see its minimal polynomial and the ideal of ℤ[x] it determines.

**Live:** https://ryanpersson.github.io/algebraic-numbers/

This project is inspired by, and its look is modelled on, Stephen J. Brooks'
pictures of the algebraic numbers (see [Inspiration](#inspiration) below).

It is a static site (plain HTML, CSS and ES modules, no build step), so it runs on
GitHub Pages as is.

## Using it

- Drag to pan, scroll or pinch to zoom, double-click to zoom in.
- Hover a dot to see its polynomial; click it to open the info panel.
- Type a polynomial (`x^3 - x - 1`) or a number (`(1+sqrt(5))/2`, `0.5+0.87i`) into
  the search box to jump there.
- The settings panel switches between all algebraic numbers and algebraic integers,
  colouring by leading coefficient or degree, and sets max degree (1–7), dot size,
  detail, size falloff, brightness and glow.
- The URL keeps the view, the settings and the selected number, so links can be
  shared.
- Press `V` to hide all the controls and see just the picture (for screenshots or
  screen recordings). Press it again to bring them back.

### Zoom flights

The flight button (next to settings) builds a smooth zoom through a list of views:
start from the overview, zoom in to something you like, press **Add this view**,
and repeat for more waypoints. **Copy link** gives a URL that opens as a little
player: press Play and it flies from the overview to your view like a fractal-zoom
video, then hands over to you for exploring. **Save** keeps flights in this browser,
and **Fly here** in a number's info panel makes a flight straight to it.

- The path between views is van Wijk and Nuij's "smooth and efficient zooming and
  panning": constant perceived speed, zooming out a little if that makes a pan
  shorter. Time is eased in and out.
- Every frame is computed live. Tiles are computed ahead along the path. When the
  computer can't keep up, playback slows down smoothly (and holds if it must) rather
  than showing holes. *Standard* quality computes 1× tiles even on high-density
  screens (4× less work than *Sharp*). High degrees are slow.
- Space pauses. A click, scroll or key takes over.

Zooming crossfades continuously between the two nearest tile levels, and new tiles
fade in. Each level's dots, glow and fine dust are drawn for its own scale, so
switching levels abruptly would make the brightness jump.

### Recording flights

`window.viewer` is a small scripting hook for recorders.

- `viewer.loaded` is true once the current view is fully drawn.
- `viewer.play({capture: true})` plays the flight in the link frame-locked. The
  recorder must replace `performance.now` with a clock it advances one frame at a
  time.
- The page sets `window.__pixeldif.gl = true` and marks each frame as drawn
  (`window.__pixeldif.drawn`) only once every tile it needs is on screen. Until then
  the recorder should wait, so every captured frame is complete.
- `viewer.probe()` returns the current `{zoom, x, y, t}` for labelling frames.

## What is drawn

Every algebraic number α is drawn once, from its minimal polynomial
p(x) = a_d x^d + … + a_0 (irreducible over ℤ, coefficients with no common factor,
a_d > 0).

- **Colour** is the leading coefficient a_d (red = 1, i.e. the algebraic integers;
  then green, blue and yellow for 2, 3 and 4, violet for 5 and up), or the degree.
- **Size** shrinks with the length L = |a_0| + … + |a_d|: fewer terms and smaller
  coefficients make bigger dots.

The size falls off like L^(−(d+1)/2). That is the Dirichlet exponent for approximating
a point of the plane by algebraic numbers of degree d, so the density of dots is the
same at every scale on average. The real line and the unit circle get their own
exponents, L^(−(d+1)) and L^(−(d/2+1)), because algebraic numbers pile up along them.
With these laws zooming never runs out of detail, and the structure you see at depth
is real:

- **Holes** around every low-height algebraic number. For example |p(i)| ≥ 1 for
  every integer polynomial with p(i) ≠ 0, so no root of a length-L polynomial lies
  within about 1/(4L) of i. Only the circles through i where |p(i)| = 1 come close,
  and they are the arcs around i in Brooks' picture.
- **Repulsion from the real axis.** Non-real roots near it come in close conjugate
  pairs.
- **The unit circle.** Roots of palindromic polynomials crowd onto it, while other
  quartics avoid a band around it.

## How it works

Each 256×256 tile is computed from scratch in a web worker (`js/core.js`):

1. Per degree, split the lengths into tiers by how far their glow reaches.
2. For each tier, find every integer polynomial with a root in the tile, plus a margin.
   The condition "p(z₀) is small" is linear in the coefficients, so these are lattice
   points in a thin ellipsoid. Deep zooms LLL-reduce the lattice and run a
   Schnorr–Euchner enumeration. Shallow views walk the L1 ball directly, whichever is
   cheaper by estimate. Near the real axis the search uses p(x₀) and p′(x₀) together,
   which skips the flood of polynomials that only have a real root nearby.
3. Near a low-degree number α₀, the multiples m(x)·q(x) of its minimal polynomial would
   fill the ellipsoid. LLL puts that sublattice first, and the enumeration detects it
   (an exact common factor of the first basis vectors) and skips it.
4. Roots come from the Aberth–Ehrlich method. Irreducibility is checked exactly:
   integral factors over conjugation-closed sets of roots, confirmed by exact division
   in BigInt.
5. Dots are splatted into a floating-point buffer and tone-mapped
   (1 − e^(−light)), so bright dots burn through to white like in the original.

The enumeration is checked against brute force (every polynomial up to the length
bound) on tiles at several zoom levels, including tiles that contain i, 1 and ½:

```bash
node tests/brute-force.mjs
```

The info panel (`js/algebra.js`) shows:

- the minimal polynomial, monic over ℚ and primitive over ℤ;
- the ideal I_α = {f ∈ ℤ[x] : f(α) = 0} = (p), and ℤ[x]/I_α ≅ ℤ[α];
- the maximal ideals (ℓ, g(x)) containing I_α, from factoring p mod small primes and
  primes dividing the discriminant;
- the exact discriminant, signature, Mahler measure, house and conjugates;
- tags for units, roots of unity, Pisot and Salem numbers.

## Limits

- Zoom goes to about 4·10⁹×, where double-precision arithmetic runs out.
- Degrees 6–7 make deep zooms noticeably slower (the search is in 7–8 dimensions).

## Running locally

Module workers need a web server rather than `file://`:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploying to GitHub Pages

Push the repository to GitHub, then in **Settings → Pages** choose "Deploy from a
branch", select the default branch and the root folder. The `.nojekyll` file keeps
Pages from running Jekyll over the files.

## Inspiration

This viewer exists because of [Stephen J. Brooks](http://www.stephenbrooks.org/)'
beautiful pictures of the algebraic numbers in the complex plane. They are the
illustrations in Wikipedia's article on
[algebraic numbers](https://en.wikipedia.org/wiki/Algebraic_number):

- [Algebraic numbers coloured by degree](https://commons.wikimedia.org/wiki/File:Algebraicszoom.png)
- [Algebraic numbers coloured by leading coefficient](https://commons.wikimedia.org/wiki/File:Leadingcoeff.png)

The colour schemes (red, green, blue and yellow for 1–4), the glowing dots, the
"bigger dot = simpler polynomial" idea and the default framing all come from those
images. This project reimplements the idea from scratch so it can be zoomed without
limit and explored interactively. It doesn't include his images, which are licensed
CC BY 3.0 by him.

## Credits and licence

- Code: MIT licence, see [LICENSE](LICENSE).
- Formulas are typeset with [KaTeX](https://katex.org) (MIT), loaded from a CDN.
  Without it the panel falls back to plain TeX source.
