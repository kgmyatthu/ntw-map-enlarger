import type { Species, Zone, UndoAction, TreeList, Deployment, FillAlgo, RemovedTree, View, HeightMap, BuildingList } from "../types";

// ---------- world/screen transforms ----------
// screen y = -world z: the game renders +Z upward, so the viewer mirrors it too
// (display-only — no file data is ever flipped)
export const w2s = (v: View, x: number, z: number, cw: number, ch: number): [number, number] =>
  [cw / 2 + (x - v.cx) * v.zoom, ch / 2 - (z - v.cz) * v.zoom];
export const s2w = (v: View, sx: number, sz: number, cw: number, ch: number): [number, number] =>
  [(sx - cw / 2) / v.zoom + v.cx, (ch / 2 - sz) / v.zoom + v.cz];

// ---------- tree edits (mutate species in place; caller records undo) ----------
/** Append trees at pts to species[si], cloning extras from existing records. Null = no prototype anywhere. */
export function addTrees(species: Species[], si: number, pts: [number, number][]): number | null {
  const s = species[si];
  const src = s.trees.length ? s.trees : species.find(x => x.trees.length)?.trees;
  if (!src) return null;
  const added = pts.map((p, i) => ({ x: Math.round(p[0] * 10) / 10, z: Math.round(p[1] * 10) / 10, extra: src[i % src.length].extra, isNew: true }));
  s.trees.push(...added);
  return added.length;
}

export function eraseTrees(species: Species[], wx: number, wz: number, r: number): RemovedTree[] {
  const removed: RemovedTree[] = [];
  species.forEach((s, si) => {
    for (let i = s.trees.length - 1; i >= 0; i--) {
      const t = s.trees[i], dx = t.x - wx, dz = t.z - wz;
      if (dx * dx + dz * dz <= r * r) { removed.push({ kind: "tree", si, i, t }); s.trees.splice(i, 1); }
    }
  });
  return removed;
}

/** Random points inside the brush disc, clamped to the map (minus a 10 m margin). */
export function stampPoints(wx: number, wz: number, brushR: number, density: number, mapSize: number, rng: () => number = Math.random): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; k < density; k++) {
    const a = rng() * 6.283, r = Math.sqrt(rng()) * brushR;
    const x = wx + Math.cos(a) * r, z = wz + Math.sin(a) * r;
    if (Math.abs(x) < mapSize / 2 - 10 && Math.abs(z) < mapSize / 2 - 10) pts.push([x, z]);
  }
  return pts;
}

// ---------- zone hit test (respects rotation) ----------
export function zoneAt(zones: Zone[], block: number, wx: number, wz: number): number | null {
  let hit: number | null = null;
  zones.forEach((z, zi) => {
    if (z.block !== block) return;
    const dx = wx - z.x, dz = wz - z.y;
    const rx = dx * Math.cos(-z.o) - dz * Math.sin(-z.o);
    const rz = dx * Math.sin(-z.o) + dz * Math.cos(-z.o);
    if (Math.abs(rx) <= z.w / 2 && Math.abs(rz) <= z.h / 2) hit = zi;
  });
  return hit;
}

// ---------- undo ----------
export function applyUndo(a: UndoAction, trees: TreeList | null, deploy: Deployment | null, blds: BuildingList[] | null = null): void {
  // non-null trees/deploy/blds: undo entries are only pushed while that state exists
  if (a.type === "fill") a.addedPer.forEach((n, si) => n && trees!.species[si].trees.splice(-n, n));
  else if (a.type === "zone-move") { const z = deploy!.zones[a.zi]; z.x = a.x; z.y = a.y; z.w = a.w; z.h = a.h; z.o = a.o; if (a.x0 !== undefined) z.x0 = a.x0; if (a.y0 !== undefined) z.y0 = a.y0; deploy!.changed = true; }
  else if (a.type === "tree-add") trees!.species[a.si].trees.splice(-a.n, a.n);
  else if (a.type === "bldg-move") { const bd = blds![a.li].records[a.ri]; bd.x = a.x; bd.z = a.z; }
  else [...a.removed].reverse().forEach(r => trees!.species[r.si].trees.splice(r.i, 0, r.t));
}

// ---------- tree auto-fill ----------
/** Weight fn over sampled colour-map pixels: greener ground → higher fill probability. */
export function makeColourWeight(d: Uint8ClampedArray, S: number, mapSize: number) {
  return (wx: number, wz: number) => {
    const u = wx / mapSize + 0.5, v = 1 - (wz / mapSize + 0.5);   // row 0 = +Z
    const px = Math.min(S - 1, Math.max(0, (u * S) | 0)), py = Math.min(S - 1, Math.max(0, (v * S) | 0));
    const i = (py * S + px) * 4, r = d[i], g = d[i + 1], b = d[i + 2], m = (r + g + b) / 3;
    return Math.max(0, (g - m) - 0.3 * m + 18) / 60;
  };
}

/** Local depression sampler: how far (heightmap value units) a point sits below
 * the mean of its ~60 m neighbourhood. Rivers and streams are carved LOCAL minima,
 * so this finds them in highlands too — no global water level involved (row 0 = +Z). */
export function makeDepressionSampler(hm: HeightMap, mapSize: number) {
  const { w, h, px } = hm;
  // ponytail: 150 m half-window — must exceed the widest river's half-width or its
  // middle reads as flat; widen further if broad waterways still catch trees
  const r = Math.max(2, Math.min(128, Math.round(150 * w / mapSize)));
  // separable box mean via running sums, edge-clamped
  const tmp = new Float32Array(w * h), mean = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += px[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += px[row + Math.min(w - 1, x + r + 1)] - px[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      mean[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return (wx: number, wz: number) => {
    const u = wx / mapSize + 0.5, v = 1 - (wz / mapSize + 0.5);
    const X = Math.min(w - 1, Math.max(0, (u * w) | 0)), Y = Math.min(h - 1, Math.max(0, (v * h) | 0));
    return mean[Y * w + X] - px[Y * w + X];   // > 0: below the local surroundings
  };
}

/** No-plant mask around buildings: true within r metres of any placed record. */
export function makeBuildingMask(pts: { x: number; z: number }[], r = 20) {
  // ponytail: 20 m keeps yards/lanes clear; grid hash, same trick as fillSpecies spacing
  const m = new Map<string, { x: number; z: number }[]>();
  const gc = (v: number) => (v / r) | 0;
  for (const p of pts) {
    const k = gc(p.x) + ":" + gc(p.z);
    const b = m.get(k);
    b ? b.push(p) : m.set(k, [p]);
  }
  return (wx: number, wz: number) => {
    for (let i = gc(wx) - 1; i <= gc(wx) + 1; i++) for (let j = gc(wz) - 1; j <= gc(wz) + 1; j++)
      for (const p of m.get(i + ":" + j) ?? [])
        if ((p.x - wx) * (p.x - wx) + (p.z - wz) * (p.z - wz) <= r * r) return true;
    return false;
  };
}

/** Carve depth (heightmap units, ≈4 8-bit levels) that masks carved stream beds even under green paint. */
export const DEP_BARE = 0.015;

/** No-plant mask from ground_type_map_0 + local heightmap depressions.
 * Same shape as the road rule that works: decided by ink alone. Trees plant
 * ONLY on greenish ground types — every other ink (black roads, water in any
 * palette, rock, sand, mud) is no-plant, deterministically. The depression
 * check only ADDS masking: carved stream beds painted over with green. */
export function makeRoadMask(d: Uint8ClampedArray, w: number, h: number, mapSize: number,
  depFn: ((wx: number, wz: number) => number) | null = null) {
  // ponytail: survey of 656 vanilla+mod maps — plantable ground types are green-dominant
  // with G >= 68; the greenish net below is the knob if a real map's forest ink misses
  return (wx: number, wz: number) => {
    const u = wx / mapSize + 0.5, v = 1 - (wz / mapSize + 0.5);   // row 0 = +Z
    const px = Math.min(w - 1, Math.max(0, (u * w) | 0)), py = Math.min(h - 1, Math.max(0, (v * h) | 0));
    const i = (py * w + px) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    const greenish = g > 45 && g >= r - 6 && g >= b + 4;   // green-dominant; neutral grey does NOT count
    if (!greenish) return true;
    return !!depFn && depFn(wx, wz) > DEP_BARE;
  };
}

/** Add up to target trees using the given algorithm; mutates species, returns per-species counts. */
export function fillSpecies(
  species: Species[], target: number, mapSize: number, algo: FillAlgo,
  weightFn: ((wx: number, wz: number) => number) | null,
  rng: () => number = Math.random,
  roadFn: ((wx: number, wz: number) => boolean) | null = null,
): { addedPer: number[]; added: number } {
  const counts = species.map(s => s.trees.length);
  const total = counts.reduce((a, b) => a + b, 0);
  const half = mapSize / 2 - 60;
  // immersion trees planted beyond the terrain are kept as-is, but they never
  // seed the fill: only forests inside the (enlarged) terrain grow
  const all = species.flatMap(s => s.trees.map(tr => [tr.x, tr.z]))
    .filter(([x, z]) => Math.abs(x) <= mapSize / 2 && Math.abs(z) <= mapSize / 2);
  // spatial hash for 'spaced'
  const cell = Math.max(8, Math.sqrt((mapSize * mapSize) / Math.max(1, total + target)) * 0.7);
  const hash = new Map<string, boolean>();
  const hkey = (x: number, z: number) => ((x / cell) | 0) + ":" + ((z / cell) | 0);
  if (algo === "spaced") for (const [x, z] of all) hash.set(hkey(x, z), true);
  // ponytail: reject fill points closer than MIN_D to any tree — NTW's 2d tree
  // sprites visibly stack below this; the knob if forests look too tidy/messy
  const MIN_D = 8;
  const grid = new Map<string, number[][]>();
  const gc = (v: number) => Math.floor(v / MIN_D);
  const gput = (x: number, z: number) => {
    const k = gc(x) + ":" + gc(z);
    const b = grid.get(k);
    b ? b.push([x, z]) : grid.set(k, [[x, z]]);
  };
  const gnear = (x: number, z: number) => {
    for (let i = gc(x) - 1; i <= gc(x) + 1; i++) for (let j = gc(z) - 1; j <= gc(z) + 1; j++)
      for (const [px, pz] of grid.get(i + ":" + j) ?? [])
        if ((px - x) * (px - x) + (pz - z) * (pz - z) < MIN_D * MIN_D) return true;
    return false;
  };
  for (const [x, z] of all) gput(x, z);
  const addedPer = species.map(() => 0);
  let added = 0, tries = 0;
  if (algo === "cluster" && !all.length) return { addedPer, added };   // nothing inside to grow from
  while (added < target && tries < target * 40) {
    tries++;
    let wx: number, wz: number;
    if (algo === "cluster") {
      const [bx, bz] = all[(rng() * all.length) | 0];
      const a = rng() * 6.283, r = Math.abs((rng() + rng() + rng()) / 1.5 - 1) * 90;
      wx = bx + Math.cos(a) * r; wz = bz + Math.sin(a) * r;
    } else {
      wx = (rng() * 2 - 1) * half; wz = (rng() * 2 - 1) * half;
    }
    if (Math.abs(wx) > half || Math.abs(wz) > half) continue;
    if (algo === "colour" && weightFn && rng() > weightFn(wx, wz)) continue;
    if (algo === "spaced" && hash.has(hkey(wx, wz))) continue;
    if (roadFn && roadFn(wx, wz)) continue;
    if (gnear(wx, wz)) continue;
    let r = rng() * total, si = 0;
    for (; si < counts.length; si++) { r -= counts[si]; if (r <= 0) break; }
    si = Math.min(si, counts.length - 1);
    const s = species[si];
    if (!s.trees.length) continue;
    const proto = s.trees[(rng() * s.trees.length) | 0];
    const nt = { x: Math.round(wx * 10) / 10, z: Math.round(wz * 10) / 10, extra: proto.extra, isNew: true };
    s.trees.push(nt);
    gput(wx, wz);
    if (algo === "spaced") hash.set(hkey(wx, wz), true);
    if (algo === "cluster") all.push([wx, wz]);
    addedPer[si]++; added++;
  }
  return { addedPer, added };
}
