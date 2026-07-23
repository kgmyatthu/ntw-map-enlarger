import type { HeightMap } from "../types";

// ---------- 3D terrain view: software-rasterised heightfield ----------
// ponytail: no WebGL/three.js — quads are scanline-filled into one reusable
// ImageData (packed uint32 colours, single putImageData per frame), which beats
// the canvas path API by an order of magnitude at this scene size.
// Little-endian pixel packing (0xAABBGGRR), like every platform browsers run on.

export interface Cam3 { yaw: number; pitch: number; zoom: number; cx?: number; cz?: number }   // cx/cz: world look-at target

export interface Terrain {
  G: number;
  /** (G+1)² vertex heights, 0..1 across the map's own min..max range, row 0 = +Z */
  hs: Float32Array;
  /** G² per-cell packed bare-ground colours (slope-shaded, contour-banded) — the colour-layer-off look */
  fill: Uint32Array;
  /** TS×TS full-res colour-map texture with the cell shading baked in; null = no colour image */
  tex: Uint32Array | null;
  TS: number;
}

const BANDS = 12;   // ponytail: contour bands across the height range; the knob for line density
// Fixed height projection: apparent relief responds to the height scale ONLY.
// Multiplying by cos(pitch) instead would squash the profile while tilting.
const HK = 0.55;
const BG = 0xff0f1612;         // #12160f — the viewer's canvas background
const TRUNK_COL = 0xff1c2a2e;  // #2e2a1c
/** "#rrggbb" -> packed 0xAABBGGRR */
const packCss = (s: string) => {
  const n = parseInt(s.slice(1), 16);
  return (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
};

/** Build the render-ready grid from the heightmap + an S×S RGBA colour-map sample.
 * Grid resolution follows the heightmap (up to 256 cells); vertices sample bilinearly. */
export function buildTerrain(hm: HeightMap, colour: Uint8ClampedArray | null, S: number,
  G = Math.min(512, 1 << (32 - Math.clz32(Math.max(2, hm.w - 1) - 1)))): Terrain {   // next pow2 of heightmap res, capped: the LOD stride must divide it
  const V = G + 1, hs = new Float32Array(V * V);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < hm.px.length; i++) { const v = hm.px[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const rg = mx - mn || 1;   // flat map renders flat, not NaN
  // ponytail: bilinear, not box-filtered — if huge heightmaps still shimmer, mip them down first
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) {
    const fy = i / G * (hm.h - 1), fx = j / G * (hm.w - 1);
    const y0 = fy | 0, x0 = fx | 0, y1 = Math.min(hm.h - 1, y0 + 1), x1 = Math.min(hm.w - 1, x0 + 1);
    const ty = fy - y0, tx = fx - x0;
    hs[i * V + j] = ((hm.px[y0 * hm.w + x0] * (1 - tx) + hm.px[y0 * hm.w + x1] * tx) * (1 - ty)
      + (hm.px[y1 * hm.w + x0] * (1 - tx) + hm.px[y1 * hm.w + x1] * tx) * ty - mn) / rg;
  }
  const bnd = (h: number) => Math.min(BANDS - 1, (h * BANDS) | 0);
  // per-cell brightness: NW-light slope shading × contour-band darkening (f64: exact ×0.9 etc.)
  const kArr = new Float64Array(G * G);
  const fill = new Uint32Array(G * G);
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
    const h00 = hs[i * V + j], h11 = hs[(i + 1) * V + j + 1];
    let k = Math.min(1.25, Math.max(0.55, 0.9 + (h00 - h11) * 18));   // NW light over the SE diagonal
    // contour line wherever the cell crosses an elevation band boundary
    if (bnd(h00) !== bnd(h11) || bnd(hs[i * V + j + 1]) !== bnd(hs[(i + 1) * V + j])) k *= 0.62;
    kArr[i * G + j] = k;
    // bare-ground cell colour (per-channel clamp: k>1 would wrap bytes into the neighbour channel)
    fill[i * G + j] = (0xff000000 | (Math.min(255, (84 * k) | 0) << 16) | (Math.min(255, (108 * k) | 0) << 8) | Math.min(255, (96 * k) | 0)) >>> 0;
  }
  // bake the cell shading into the full-res texture once, so per-frame cost stays a plain texel fetch
  let tex: Uint32Array | null = null;
  if (colour) {
    tex = new Uint32Array(S * S);
    const GoS = G / S;
    for (let ty = 0; ty < S; ty++) {
      const krow = Math.min(G - 1, (ty * GoS) | 0) * G, row = ty * S;
      for (let tx = 0; tx < S; tx++) {
        const k = kArr[krow + Math.min(G - 1, (tx * GoS) | 0)], o = (row + tx) * 4;
        tex[row + tx] = (0xff000000 | (Math.min(255, (colour[o + 2] * k) | 0) << 16)
          | (Math.min(255, (colour[o + 1] * k) | 0) << 8) | Math.min(255, (colour[o] * k) | 0)) >>> 0;
      }
    }
  }
  return { G, hs, fill, tex, TS: S };
}

/** Screen xy per vertex (2 floats each). Same conventions as the 2D view: +x right, +z down at yaw 0.
 * Pass `out` to reuse a buffer (the render loop does); omitted = fresh array. */
export function projectVerts(G: number, hs: Float32Array, cam: Cam3, W: number, H: number, mapSize: number, relief: number, out?: Float32Array): Float32Array {
  const V = G + 1, n = V * V * 2;
  if (!out || out.length !== n) out = new Float32Array(n);
  const sc = Math.min(W, H) / (mapSize * 1.45) * cam.zoom;
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw), sp = Math.sin(cam.pitch);
  const ccx = cam.cx ?? 0, ccz = cam.cz ?? 0;
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) {
    const x = (j / G - 0.5) * mapSize - ccx, z = (0.5 - i / G) * mapSize - ccz, y = hs[i * V + j] * relief;
    // mirrored like the 2D view (+Z up at yaw 0): reflection, not a rotation
    const rx = x * cy + z * sy, rz = x * sy - z * cy;
    const o = (i * V + j) * 2;
    out[o] = W / 2 + rx * sc;
    out[o + 1] = H / 2 + (rz * sp - y * HK) * sc;
  }
  return out;
}

// Building categories by name family: one source of truth for colour coding (2D + 3D)
// and visual dims — the .building_list stores NO size, dims are viewport guesses.
// ponytail: coarse families; add rows here when a model class reads wrong
export const BLDG_CATS: { re: RegExp; name: string; col: string; hw: number; hd: number; h: number }[] = [
  { re: /wall|fence|hedge|gate/i, name: "wall/fence", col: "#c9c2a6", hw: 6, hd: 0.6, h: 2.2 },
  { re: /church|cathedral|monument|tower/i, name: "landmark", col: "#d783c7", hw: 11, hd: 5.5, h: 15 },
  { re: /barn|farm|mill|warehouse|manor/i, name: "farm/barn", col: "#e0954a", hw: 9, hd: 5, h: 8 },
  { re: /prop|crate|barrel|hay|wagon|cart|log|rock|grave|bench|sign|well|trough/i, name: "prop", col: "#9aa0a8", hw: 1.5, hd: 1.5, h: 1.6 },
  { re: /./, name: "house", col: "#e8d06a", hw: 6.5, hd: 4.5, h: 6 },   // huts / generic buildings
];

/** Memoised category index for a model name (last table row matches everything). */
const catMemo = new Map<string, number>();
export function bldgCat(name: string): number {
  let c = catMemo.get(name);
  if (c === undefined) {
    c = BLDG_CATS.findIndex(k => k.re.test(name));
    catMemo.set(name, c);
  }
  return c;
}

/** Buildings bucketed per fine cell: entries [x, z, catIdx, angleRad, halfW, halfD, height, far]. */
export function bucketBuildings(lists: { records: { name: string; x: number; z: number; rot: number }[]; far?: boolean }[], mapSize: number, G: number): Map<number, number[][]> {
  const m = new Map<number, number[][]>();
  for (const bl of lists) {
    for (const r of bl.records) {
      if (Math.abs(r.x) > mapSize / 2 || Math.abs(r.z) > mapSize / 2) continue;
      const j = Math.min(G - 1, Math.max(0, ((r.x / mapSize + 0.5) * G) | 0));
      const i = Math.min(G - 1, Math.max(0, ((0.5 - r.z / mapSize) * G) | 0));
      const c = bldgCat(r.name), k = BLDG_CATS[c];
      const b = m.get(i * G + j), e = [r.x, r.z, c, r.rot / 65536 * 6.283, k.hw, k.hd, k.h, bl.far ? 1 : 0];
      b ? b.push(e) : m.set(i * G + j, [e]);
    }
  }
  return m;
}

/** Per-channel brightness on a packed colour, clamped. */
const shade = (c: number, k: number) => {
  const r = Math.min(255, ((c & 0xff) * k) | 0), g = Math.min(255, (((c >> 8) & 0xff) * k) | 0), b = Math.min(255, (((c >> 16) & 0xff) * k) | 0);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
};
const CAT32 = BLDG_CATS.map(c => packCss(c.col));

/** Trees bucketed by cell index so they paint (and occlude) with their cell. Entries [x, z, speciesIdx]. */
export function bucketTrees(species: { trees: { x: number; z: number }[] }[], mapSize: number, G: number): Map<number, number[][]> {
  const m = new Map<number, number[][]>();
  const total = species.reduce((a, s) => a + s.trees.length, 0);
  const step = Math.max(1, Math.ceil(total / 20000));   // ponytail: 20k billboards max, like the thumbnails
  species.forEach((s, si) => {
    for (let k = 0; k < s.trees.length; k += step) {
      const t = s.trees[k];
      if (Math.abs(t.x) > mapSize / 2 || Math.abs(t.z) > mapSize / 2) continue;   // immersion trees beyond the terrain
      const j = Math.min(G - 1, Math.max(0, ((t.x / mapSize + 0.5) * G) | 0));
      const i = Math.min(G - 1, Math.max(0, ((0.5 - t.z / mapSize) * G) | 0));
      const b = m.get(i * G + j), e = [t.x, t.z, si];
      b ? b.push(e) : m.set(i * G + j, [e]);
    }
  });
  return m;
}

/** Scanline-fill a triangle. Round+inclusive edges overdraw shared borders by
 * one pixel, which the back-to-front paint order turns into seamless joins. */
function fillTri(buf: Uint32Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, col: number): void {
  let t;
  if (y1 < y0) { t = y0; y0 = y1; y1 = t; t = x0; x0 = x1; x1 = t; }
  if (y2 < y0) { t = y0; y0 = y2; y2 = t; t = x0; x0 = x2; x2 = t; }
  if (y2 < y1) { t = y1; y1 = y2; y2 = t; t = x1; x1 = x2; x2 = t; }
  const ys = Math.max(0, Math.ceil(y0)), ye = Math.min(H - 1, Math.floor(y2));
  for (let y = ys; y <= ye; y++) {
    const xa = x0 + (x2 - x0) * ((y - y0) / (y2 - y0 || 1));
    const xb = y < y1
      ? x0 + (x1 - x0) * ((y - y0) / (y1 - y0 || 1))
      : x1 + (x2 - x1) * ((y - y1) / (y2 - y1 || 1));
    const xs = Math.max(0, Math.round(xa < xb ? xa : xb));
    const xe = Math.min(W - 1, Math.round(xa < xb ? xb : xa));
    const row = y * W;
    for (let x = xs; x <= xe; x++) buf[row + x] = col;
  }
}

/** Scanline-fill a triangle with affine texture mapping (nearest texel), same edge rule as fillTri. */
function texTri(buf: Uint32Array, W: number, H: number, tex: Uint32Array, TS: number,
  x0: number, y0: number, u0: number, v0: number,
  x1: number, y1: number, u1: number, v1: number,
  x2: number, y2: number, u2: number, v2: number): void {
  let t;
  if (y1 < y0) { t = y0; y0 = y1; y1 = t; t = x0; x0 = x1; x1 = t; t = u0; u0 = u1; u1 = t; t = v0; v0 = v1; v1 = t; }
  if (y2 < y0) { t = y0; y0 = y2; y2 = t; t = x0; x0 = x2; x2 = t; t = u0; u0 = u2; u2 = t; t = v0; v0 = v2; v2 = t; }
  if (y2 < y1) { t = y1; y1 = y2; y2 = t; t = x1; x1 = x2; x2 = t; t = u1; u1 = u2; u2 = t; t = v1; v1 = v2; v2 = t; }
  const ys = Math.max(0, Math.ceil(y0)), ye = Math.min(H - 1, Math.floor(y2));
  const TSm1 = TS - 1;
  for (let y = ys; y <= ye; y++) {
    const ta = (y - y0) / (y2 - y0 || 1);
    let xa = x0 + (x2 - x0) * ta, ua = u0 + (u2 - u0) * ta, va = v0 + (v2 - v0) * ta;
    let xb, ub, vb;
    if (y < y1) { const tb = (y - y0) / (y1 - y0 || 1); xb = x0 + (x1 - x0) * tb; ub = u0 + (u1 - u0) * tb; vb = v0 + (v1 - v0) * tb; }
    else { const tb = (y - y1) / (y2 - y1 || 1); xb = x1 + (x2 - x1) * tb; ub = u1 + (u2 - u1) * tb; vb = v1 + (v2 - v1) * tb; }
    if (xa > xb) { t = xa; xa = xb; xb = t; t = ua; ua = ub; ub = t; t = va; va = vb; vb = t; }
    const xs = Math.max(0, Math.round(xa)), xe = Math.min(W - 1, Math.round(xb));
    if (xe < xs) continue;
    const du = (ub - ua) / (xb - xa || 1), dv = (vb - va) / (xb - xa || 1);
    let u = ua + (xs - xa) * du, v = va + (xs - xa) * dv;
    const row = y * W;
    for (let x = xs; x <= xe; x++) {
      const ui = u < 0 ? 0 : u > TSm1 ? TSm1 : u | 0;
      const vi = v < 0 ? 0 : v > TSm1 ? TSm1 : v | 0;
      buf[row + x] = tex[vi * TS + ui];
      u += du; v += dv;
    }
  }
}

function fillRect(buf: Uint32Array, W: number, H: number, x: number, y: number, w: number, h: number, col: number): void {
  if (x + w <= 0 || y + h <= 0 || x >= W || y >= H) return;   // fully offscreen — the min-1px floor below would smear it onto the edge
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.max(x0 + 1, Math.round(x + w))), y1 = Math.min(H, Math.max(y0 + 1, Math.round(y + h)));
  for (let yy = y0; yy < y1; yy++) { const row = yy * W; for (let xx = x0; xx < x1; xx++) buf[row + xx] = col; }
}

// reusable frame + projection buffers (one 3D canvas per app)
let fw = 0, fh = 0, frame: ImageData | null = null, fbuf = new Uint32Array(0);
let pvBuf: Float32Array | undefined;

/** Rasterise the whole scene back-to-front and blit it in one putImageData. */
export function render3d(
  ctx: CanvasRenderingContext2D, W: number, H: number, t: Terrain, cam: Cam3,
  mapSize: number, relief: number, cellTrees: Map<number, number[][]> | null, spColors: string[],
  colourOn = true, cellBldgs: Map<number, number[][]> | null = null,
): void {
  if (W < 1 || H < 1) return;   // collapsed viewer pane: createImageData(0, …) throws
  const FG = t.G, V = FG + 1, hs = t.hs;
  const pvN = V * V * 2;
  if (!pvBuf || pvBuf.length !== pvN) pvBuf = new Float32Array(pvN);
  const pv = pvBuf;
  if (!frame || fw !== W || fh !== H) {
    frame = ctx.createImageData(W, H);
    fbuf = new Uint32Array(frame.data.buffer);
    fw = W; fh = H;
  }
  fbuf.fill(BG);
  const sc = Math.min(W, H) / (mapSize * 1.45) * cam.zoom;
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw), sp = Math.sin(cam.pitch);
  const trunk = Math.max(1.5, 14 * sc * HK);        // ~14 m trees, same fixed height projection as terrain
  const head = Math.max(2, Math.min(10, 6 * sc));   // canopy grows as you zoom in
  const tw = Math.max(1, head / 3);
  const sp32 = spColors.map(packCss);
  const margin = 20 + trunk;   // slack: tree billboards can poke past their cell
  const tex = colourOn ? t.tex : null;
  const TS = t.TS, TSoG = TS / FG;
  const ccx = cam.cx ?? 0, ccz = cam.cz ?? 0;
  // LOD stride: never rasterise cells under ~3.5 screen px (FG is a power of 2, so s divides it)
  let s = 1;
  while (s < 16 && (mapSize / FG) * sc * s < 3.5) s *= 2;
  const G = Math.max(1, (FG / s) | 0);
  // visible cell window: un-project the (padded) screen corners to a world AABB —
  // zoomed in, this skips the huge offscreen part of the grid entirely
  const lift = relief * HK * sc, spSafe = Math.max(0.05, sp);
  let wx0 = Infinity, wx1 = -Infinity, wz0 = Infinity, wz1 = -Infinity;
  for (const sx of [-margin, W + margin]) for (const sy2 of [-margin, H + margin + lift]) {
    const rx = (sx - W / 2) / sc, rz = (sy2 - H / 2) / (sc * spSafe);
    const x = rx * cy + rz * sy + ccx, z = rx * sy - rz * cy + ccz;   // the mirror reflection is its own inverse
    if (x < wx0) wx0 = x; if (x > wx1) wx1 = x;
    if (z < wz0) wz0 = z; if (z > wz1) wz1 = z;
  }
  const j0 = Math.max(0, Math.floor((wx0 / mapSize + 0.5) * G) - 1), j1 = Math.min(G - 1, Math.ceil((wx1 / mapSize + 0.5) * G));
  const i0 = Math.max(0, Math.floor((0.5 - wz1 / mapSize) * G) - 1), i1 = Math.min(G - 1, Math.ceil((0.5 - wz0 / mapSize) * G));
  if (i0 > i1 || j0 > j1) { ctx.putImageData(frame, 0, 0); return; }
  // project ONLY the window's stride vertices — zoomed in, that's a tiny fraction of the grid
  for (let i = i0; i <= i1 + 1; i++) {
    const fi = Math.min(FG, i * s);
    const z = (0.5 - fi / FG) * mapSize - ccz, rowOff = fi * V;
    for (let j = j0; j <= j1 + 1; j++) {
      const fj = Math.min(FG, j * s);
      const x = (fj / FG - 0.5) * mapSize - ccx, y = hs[rowOff + fj] * relief;
      const rx = x * cy + z * sy, rz = x * sy - z * cy;
      const o = (rowOff + fj) * 2;
      pv[o] = W / 2 + rx * sc;
      pv[o + 1] = H / 2 + (rz * sp - y * HK) * sc;
    }
  }
  // back-to-front with no sorting: sweep rows/columns in the yaw quadrant's far-to-near
  // direction — valid painter order for an axonometric regular heightfield grid.
  // Depth key = x*sy - z*cy (mirrored camera): z falls with i, so cy>=0 means far = small i.
  const iA = cy >= 0 ? i0 : i1, iB = cy >= 0 ? i1 : i0, di = cy >= 0 ? 1 : -1;
  const jA = sy >= 0 ? j0 : j1, jB = sy >= 0 ? j1 : j0, dj = sy >= 0 ? 1 : -1;
  for (let i = iA; ; i += di) {
    for (let j = jA; ; j += dj) {
      const fi0 = i * s, fj0 = j * s;
      const a = (fi0 * V + fj0) * 2, b = (fi0 * V + fj0 + s) * 2, c = ((fi0 + s) * V + fj0) * 2, d = ((fi0 + s) * V + fj0 + s) * 2;
      // per-cell reject for the window's rounded edges
      const off = (pv[a] < -margin && pv[b] < -margin && pv[c] < -margin && pv[d] < -margin)
        || (pv[a] > W + margin && pv[b] > W + margin && pv[c] > W + margin && pv[d] > W + margin)
        || (pv[a + 1] < -margin && pv[b + 1] < -margin && pv[c + 1] < -margin && pv[d + 1] < -margin)
        || (pv[a + 1] > H + margin && pv[b + 1] > H + margin && pv[c + 1] > H + margin && pv[d + 1] > H + margin);
      if (!off) {
        if (tex) {
          const ua = fj0 * TSoG, va = fi0 * TSoG, ub = (fj0 + s) * TSoG, vb = (fi0 + s) * TSoG;
          texTri(fbuf, W, H, tex, TS, pv[a], pv[a + 1], ua, va, pv[b], pv[b + 1], ub, va, pv[d], pv[d + 1], ub, vb);
          texTri(fbuf, W, H, tex, TS, pv[a], pv[a + 1], ua, va, pv[d], pv[d + 1], ub, vb, pv[c], pv[c + 1], ua, vb);
        } else {
          const col = t.fill[fi0 * FG + fj0];
          fillTri(fbuf, W, H, pv[a], pv[a + 1], pv[b], pv[b + 1], pv[d], pv[d + 1], col);
          fillTri(fbuf, W, H, pv[a], pv[a + 1], pv[d], pv[d + 1], pv[c], pv[c + 1], col);
        }
        if (cellBldgs) for (let fi = fi0; fi < fi0 + s; fi++) for (let fj = fj0; fj < fj0 + s; fj++) {
          const bbs = cellBldgs.get(fi * FG + fj);
          if (bbs) for (const [bx2, bz2, ci2, ang, hw2, hd2, bhm, farF] of bbs) {
            const y = hs[fi * V + fj] * relief;
            const base = farF ? shade(CAT32[ci2], 0.62) : CAT32[ci2];   // category hue, far lists dimmed
            if (Math.max(hw2, hd2) * 2 * sc < 7) {
              // LOD: too small on screen for shape — one flat slab
              const rx = (bx2 - ccx) * cy + (bz2 - ccz) * sy, rz = (bx2 - ccx) * sy - (bz2 - ccz) * cy;
              const px2 = W / 2 + rx * sc, py2 = H / 2 + (rz * sp - y * HK) * sc;
              const w2 = Math.max(2, hw2 * 2 * sc), h2 = Math.max(1.5, bhm * sc * HK);
              fillRect(fbuf, W, H, px2 - w2 / 2, py2 - h2, w2, h2, base);
              continue;
            }
            // extruded block: rotated footprint, 4 shaded side faces far-to-near, then the top
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const gx: number[] = [], gy: number[] = [], ty: number[] = [], rzs: number[] = [];
            for (const [dx, dz] of [[-hw2, -hd2], [hw2, -hd2], [hw2, hd2], [-hw2, hd2]]) {
              const wxc = bx2 + dx * ca - dz * sa - ccx, wzc = bz2 + dx * sa + dz * ca - ccz;
              const rx = wxc * cy + wzc * sy, rz = wxc * sy - wzc * cy;
              gx.push(W / 2 + rx * sc);
              gy.push(H / 2 + (rz * sp - y * HK) * sc);
              ty.push(H / 2 + (rz * sp - (y + bhm) * HK) * sc);
              rzs.push(rz);
            }
            const faces = [0, 1, 2, 3].sort((f1, f2) =>
              (rzs[f1] + rzs[(f1 + 1) % 4]) - (rzs[f2] + rzs[(f2 + 1) % 4]));
            for (const f of faces) {
              const g2 = (f + 1) % 4;
              // screen-space face direction vs a fixed NW-ish light
              const k = 0.6 + 0.32 * Math.abs(Math.sin(Math.atan2(gy[g2] - gy[f], gx[g2] - gx[f]) + 0.8));
              const col = shade(base, k);
              fillTri(fbuf, W, H, gx[f], gy[f], gx[g2], gy[g2], gx[g2], ty[g2], col);
              fillTri(fbuf, W, H, gx[f], gy[f], gx[g2], ty[g2], gx[f], ty[f], col);
            }
            const top = shade(base, 1.08);
            fillTri(fbuf, W, H, gx[0], ty[0], gx[1], ty[1], gx[2], ty[2], top);
            fillTri(fbuf, W, H, gx[0], ty[0], gx[2], ty[2], gx[3], ty[3], top);
          }
        }
        if (cellTrees) for (let fi = fi0; fi < fi0 + s; fi++) for (let fj = fj0; fj < fj0 + s; fj++) {
          const bts = cellTrees.get(fi * FG + fj);
          if (bts) for (const [tx, tz, si] of bts) {
            // bilinear ground height at the tree's exact spot (fine grid, not the LOD cell)
            const fx = Math.min(1, Math.max(0, (tx / mapSize + 0.5) * FG - fj));
            const fz = Math.min(1, Math.max(0, (0.5 - tz / mapSize) * FG - fi));
            const y = (hs[fi * V + fj] * (1 - fx) * (1 - fz) + hs[fi * V + fj + 1] * fx * (1 - fz)
              + hs[(fi + 1) * V + fj] * (1 - fx) * fz + hs[(fi + 1) * V + fj + 1] * fx * fz) * relief;
            const rx = (tx - ccx) * cy + (tz - ccz) * sy, rz = (tx - ccx) * sy - (tz - ccz) * cy;
            const bx = W / 2 + rx * sc, by = H / 2 + (rz * sp - y * HK) * sc;
            fillRect(fbuf, W, H, bx - tw / 2, by - trunk, tw, trunk, TRUNK_COL);
            fillRect(fbuf, W, H, bx - head / 2, by - trunk - head * 0.7, head, head, sp32[si % sp32.length]);
          }
        }
      }
      if (j === jB) break;
    }
    if (i === iB) break;
  }
  ctx.putImageData(frame, 0, 0);
}
