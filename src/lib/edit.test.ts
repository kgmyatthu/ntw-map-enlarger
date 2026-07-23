import { describe, it, expect } from "vitest";
import {
  w2s, s2w, addTrees, eraseTrees, stampPoints, zoneAt, applyUndo,
  makeColourWeight, makeRoadMask, makeDepressionSampler, makeBuildingMask, fillSpecies,
} from "./edit";
import type { Species, Tree, Zone, TreeList, Deployment, View } from "../types";

// ---------- helpers ----------

/** Deterministic LCG in [0,1). */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** rng that replays a fixed sequence, cycling. */
const seq = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

const tree = (x: number, z: number, tag = 0xaa): Tree =>
  ({ x, z, extra: new Uint8Array([tag, tag, tag, tag]), isNew: false });

const sp = (name: string, trees: Tree[]): Species =>
  ({ name, nameBytes: new Uint8Array(), trees, trailing: new Uint8Array() });

const treeList = (species: Species[]): TreeList =>
  ({ header: new Uint8Array(), species, stride: 14, magic: "LRDZ", origBytes: new Uint8Array() });

const zone = (x: number, y: number, w: number, h: number, o = 0, block = 0): Zone =>
  ({ x, y, w, h, o, block, alliance: 0, seg: "" });

const deployment = (zones: Zone[]): Deployment =>
  ({ segs: [], zones, nBlocks: 2, changed: false });

// ---------- w2s / s2w ----------

describe("w2s / s2w", () => {
  it("maps world centre to screen centre; +z goes UP the screen (game orientation)", () => {
    const v: View = { zoom: 2, cx: 10, cz: 20 };
    expect(w2s(v, 10, 20, 400, 300)).toEqual([200, 150]);
    // +5 world x -> +5*zoom right; +5 world z -> 5*zoom UP (mirrored like the game)
    expect(w2s(v, 15, 25, 400, 300)).toEqual([210, 140]);
    // s2w respects zoom/centre too
    expect(s2w(v, 210, 140, 400, 300)).toEqual([15, 25]);
    expect(s2w(v, 200, 150, 400, 300)).toEqual([10, 20]);
  });

  it("are inverses of each other in both directions", () => {
    const v: View = { zoom: 2.5, cx: 37, cz: -12 };
    const cw = 800, ch = 600;
    for (const [x, z] of [[0, 0], [123.4, -56.7], [-500, 999]] as [number, number][]) {
      const [sx, sz] = w2s(v, x, z, cw, ch);
      const [wx, wz] = s2w(v, sx, sz, cw, ch);
      expect(wx).toBeCloseTo(x, 9);
      expect(wz).toBeCloseTo(z, 9);
    }
    for (const [sx, sz] of [[0, 0], [400, 300], [799.5, 13]] as [number, number][]) {
      const [wx, wz] = s2w(v, sx, sz, cw, ch);
      const [bx, bz] = w2s(v, wx, wz, cw, ch);
      expect(bx).toBeCloseTo(sx, 9);
      expect(bz).toBeCloseTo(sz, 9);
    }
  });
});

// ---------- addTrees ----------

describe("addTrees", () => {
  it("rounds coords to 0.1, marks isNew, returns count", () => {
    const species = [sp("pine", [tree(0, 0, 1)])];
    const n = addTrees(species, 0, [[1.234, -5.678], [0.05, 0.04]]);
    expect(n).toBe(2);
    expect(species[0].trees).toHaveLength(3);
    const [a, b] = species[0].trees.slice(1);
    expect(a.x).toBe(1.2);
    expect(a.z).toBe(-5.7);
    expect(b.x).toBe(0.1);   // 0.05 rounds up
    expect(b.z).toBe(0);
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
  });

  it("clones extra bytes cyclically from the species' own prototypes", () => {
    const p0 = tree(0, 0, 1), p1 = tree(5, 5, 2);
    const species = [sp("pine", [p0, p1])];
    addTrees(species, 0, [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    const added = species[0].trees.slice(2);
    expect(added.map(t => t.extra)).toEqual([p0.extra, p1.extra, p0.extra, p1.extra, p0.extra]);
    // same instances, not copies
    expect(added[0].extra).toBe(p0.extra);
    expect(added[1].extra).toBe(p1.extra);
  });

  it("falls back to another species' trees when the target species is empty", () => {
    const donor = tree(9, 9, 7);
    const species = [sp("empty1", []), sp("oaktree", [donor])];
    const n = addTrees(species, 0, [[1, 2], [3, 4]]);
    expect(n).toBe(2);
    expect(species[0].trees).toHaveLength(2);
    expect(species[0].trees[0].extra).toBe(donor.extra);
    expect(species[0].trees[1].extra).toBe(donor.extra);
    // donor species untouched
    expect(species[1].trees).toHaveLength(1);
  });

  it("returns null and mutates nothing when no species has trees", () => {
    const species = [sp("empty1", []), sp("empty2", [])];
    expect(addTrees(species, 0, [[1, 2]])).toBeNull();
    expect(species[0].trees).toHaveLength(0);
    expect(species[1].trees).toHaveLength(0);
  });
});

// ---------- eraseTrees ----------

describe("eraseTrees", () => {
  it("removes only trees within radius (boundary distance == r inclusive), across species", () => {
    const onBoundary = tree(3, 4);            // dist 5 == r  -> removed
    const justOutside = tree(0, 5.05);        // dist 5.05    -> kept
    const inside = tree(1, 1);                // removed
    const s1in = tree(-3, -4);                // dist 5       -> removed
    const s1out = tree(10, 10);               // kept
    const species = [sp("pine", [onBoundary, justOutside, inside]), sp("oaktree", [s1in, s1out])];
    const removed = eraseTrees(species, 0, 0, 5);

    expect(species[0].trees).toEqual([justOutside]);
    expect(species[1].trees).toEqual([s1out]);
    // per species, iteration runs from the tail down
    expect(removed).toEqual([
      { kind: "tree", si: 0, i: 2, t: inside },
      { kind: "tree", si: 0, i: 0, t: onBoundary },
      { kind: "tree", si: 1, i: 0, t: s1in },
    ]);
  });

  it("returned entries let applyUndo restore the exact original arrays", () => {
    const species = [
      sp("pine", [tree(3, 4, 1), tree(0, 9, 2), tree(1, 1, 3), tree(-2, 2, 4)]),
      sp("oaktree", [tree(0, 0, 5), tree(50, 50, 6)]),
    ];
    const snapshot = species.map(s => [...s.trees]);
    const tl = treeList(species);
    const removed = eraseTrees(species, 0, 0, 5);
    expect(removed.length).toBeGreaterThan(0);
    applyUndo({ type: "erase", removed }, tl, null);
    species.forEach((s, si) => {
      expect(s.trees).toHaveLength(snapshot[si].length);
      s.trees.forEach((t, i) => expect(t).toBe(snapshot[si][i]));   // identical objects, original order
    });
  });
});

// ---------- stampPoints ----------

describe("stampPoints", () => {
  it("returns points all within brushR of the centre", () => {
    const pts = stampPoints(0, 0, 50, 100, 1000, lcg(1));
    expect(pts).toHaveLength(100);   // nothing near the edge -> nothing filtered
    for (const [x, z] of pts) expect(Math.hypot(x, z)).toBeLessThanOrEqual(50 + 1e-9);
  });

  it("filters points outside mapSize/2 - 10", () => {
    // limit is |coord| < 90; brush overhangs it
    const pts = stampPoints(85, 0, 20, 200, 200, lcg(2));
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.length).toBeLessThan(200);   // some fell beyond the margin and were dropped
    for (const [x, z] of pts) {
      expect(Math.abs(x)).toBeLessThan(90);
      expect(Math.abs(z)).toBeLessThan(90);
    }
  });

  it("is deterministic with a seeded rng", () => {
    const a = stampPoints(10, -10, 30, 50, 500, lcg(42));
    const b = stampPoints(10, -10, 30, 50, 500, lcg(42));
    expect(a).toEqual(b);
  });
});

// ---------- zoneAt ----------

describe("zoneAt", () => {
  it("only considers zones in the requested block", () => {
    const zones = [zone(0, 0, 100, 100, 0, 0), zone(0, 0, 100, 100, 0, 1)];
    expect(zoneAt(zones, 0, 0, 0)).toBe(0);
    expect(zoneAt(zones, 1, 0, 0)).toBe(1);
    expect(zoneAt([zones[0]], 1, 0, 0)).toBeNull();
  });

  it("hit test respects rotation (o = PI/2 swaps the axes)", () => {
    // 100 x 20 zone rotated 90deg: long axis now runs along world z
    const zones = [zone(0, 0, 100, 20, Math.PI / 2, 0)];
    expect(zoneAt(zones, 0, 0, 40)).toBe(0);      // along rotated long axis
    expect(zoneAt(zones, 0, 0, -49)).toBe(0);
    expect(zoneAt(zones, 0, 9, 0)).toBe(0);       // within rotated half-height
    expect(zoneAt(zones, 0, 40, 0)).toBeNull();   // would hit if unrotated
    expect(zoneAt(zones, 0, 0, 51)).toBeNull();   // past rotated half-width
    expect(zoneAt(zones, 0, 11, 0)).toBeNull();   // past rotated half-height
  });

  it("returns null on a clean miss", () => {
    expect(zoneAt([zone(100, 100, 10, 10)], 0, 0, 0)).toBeNull();
    expect(zoneAt([], 0, 0, 0)).toBeNull();
  });

  it("last zone wins when zones overlap", () => {
    const zones = [zone(0, 0, 100, 100), zone(10, 10, 100, 100)];
    expect(zoneAt(zones, 0, 10, 10)).toBe(1);     // inside both -> later index
    expect(zoneAt(zones, 0, -45, -45)).toBe(0);   // only inside the first
  });
});

// ---------- applyUndo ----------

describe("applyUndo", () => {
  it("fill: splices each species' tail by addedPer, skipping zero entries", () => {
    const species = [
      sp("pine", [tree(1, 1, 1), tree(2, 2, 2), tree(3, 3, 3), tree(4, 4, 4)]),
      sp("oaktree", [tree(5, 5, 5), tree(6, 6, 6), tree(7, 7, 7)]),
      sp("firtree", [tree(8, 8, 8), tree(9, 9, 9)]),
    ];
    const keep = species.map(s => [...s.trees]);
    applyUndo({ type: "fill", addedPer: [2, 0, 1] }, treeList(species), null);
    expect(species[0].trees).toEqual(keep[0].slice(0, 2));
    expect(species[1].trees).toEqual(keep[1]);   // n = 0 -> untouched
    expect(species[2].trees).toEqual(keep[2].slice(0, 1));
  });

  it("zone-move: restores x/y/w/h/o and both bases, and sets deploy.changed", () => {
    const dep = deployment([zone(0, 0, 10, 10), { ...zone(99, 88, 10, 10), x0: 66, y0: 77 }]);
    applyUndo({ type: "zone-move", zi: 1, x: 5, y: 6, w: 11, h: 12, o: 0.25, x0: 4, y0: 7 }, null, dep);
    expect(dep.zones[1].x).toBe(5);
    expect(dep.zones[1].y).toBe(6);
    expect(dep.zones[1].w).toBe(11);
    expect(dep.zones[1].h).toBe(12);
    expect(dep.zones[1].o).toBe(0.25);
    expect(dep.zones[1].x0).toBe(4);
    expect(dep.zones[1].y0).toBe(7);
    expect(dep.changed).toBe(true);
    // untouched sibling
    expect(dep.zones[0].x).toBe(0);
  });

  it("zone-move: leaves bases alone when the action carries them as undefined", () => {
    const dep = deployment([{ ...zone(1, 2, 10, 10), x0: 41, y0: 42 }]);
    applyUndo({ type: "zone-move", zi: 0, x: -3, y: -4, w: 10, h: 10, o: 0, x0: undefined, y0: undefined }, null, dep);
    expect(dep.zones[0].x).toBe(-3);
    expect(dep.zones[0].y).toBe(-4);
    expect(dep.zones[0].x0).toBe(41);
    expect(dep.zones[0].y0).toBe(42);
    expect(dep.changed).toBe(true);
  });

  it("tree-add: splices the last n trees off the species", () => {
    const species = [sp("pine", [tree(1, 1), tree(2, 2), tree(3, 3), tree(4, 4), tree(5, 5)])];
    const keep = [...species[0].trees];
    applyUndo({ type: "tree-add", si: 0, n: 2 }, treeList(species), null);
    expect(species[0].trees).toEqual(keep.slice(0, 3));
  });

  it("erase: reinserts in reverse order so indices land where they were", () => {
    const A = tree(1, 1, 1), B = tree(2, 2, 2), C = tree(3, 3, 3), D = tree(4, 4, 4);
    const species = [sp("pine", [A, C])];   // B (i=1) and D (i=3) were erased, tail-first
    applyUndo({
      type: "erase",
      removed: [{ kind: "tree", si: 0, i: 3, t: D }, { kind: "tree", si: 0, i: 1, t: B }],
    }, treeList(species), null);
    expect(species[0].trees).toEqual([A, B, C, D]);
  });
});

// ---------- makeColourWeight ----------

describe("makeColourWeight", () => {
  const S = 4, mapSize = 100;
  const makeData = () => new Uint8ClampedArray(S * S * 4);
  const setPx = (d: Uint8ClampedArray, px: number, py: number, r: number, g: number, b: number) => {
    const i = (py * S + px) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  };

  it("green pixel yields a higher weight than grey", () => {
    const d = makeData();
    setPx(d, 2, 2, 0, 255, 0);      // world (0,0) -> u=v=0.5 -> pixel (2,2)
    setPx(d, 1, 1, 128, 128, 128);  // world (-20,20) -> pixel (1,1)
    const wf = makeColourWeight(d, S, mapSize);
    const green = wf(0, 0);
    const grey = wf(-20, 20);
    // pure green: m=85 -> (170 - 25.5 + 18)/60
    expect(green).toBeCloseTo(162.5 / 60, 6);
    expect(grey).toBe(0);           // (0 - 38.4 + 18) < 0 -> clamped
    expect(green).toBeGreaterThan(grey);
  });

  it("clamps pixel indices at and beyond the map edges", () => {
    const d = makeData();
    setPx(d, 3, 0, 0, 255, 0);      // far +x, far +z corner (row 0 = +Z)
    setPx(d, 0, 3, 0, 60, 0);       // far -x, far -z corner
    setPx(d, 3, 3, 30, 90, 30);     // +x edge, -z edge
    const wf = makeColourWeight(d, S, mapSize);
    // way beyond the edges: indices clamp to the corner pixels
    expect(wf(1000, 1000)).toBeCloseTo(162.5 / 60, 6);
    expect(wf(-1000, -1000)).toBeCloseTo(52 / 60, 6);   // m=20 -> (40 - 6 + 18)/60
    // exactly at the edge (u = 1, v = 1) clamps to index S-1
    expect(wf(mapSize / 2, -mapSize / 2)).toBeCloseTo(43 / 60, 6);   // m=50 -> (40 - 15 + 18)/60
  });

  it("matches the formula max(0, (g - m) - 0.3m + 18) / 60", () => {
    const d = makeData();
    setPx(d, 2, 2, 10, 100, 40);    // m = 50
    const wf = makeColourWeight(d, S, mapSize);
    expect(wf(0, 0)).toBeCloseTo(Math.max(0, (100 - 50) - 0.3 * 50 + 18) / 60, 9);
    expect(wf(0, 0)).toBeCloseTo(53 / 60, 9);
  });
});

// ---------- makeRoadMask ----------

describe("makeRoadMask", () => {
  it("no-plant = dark R+G (black road, blue water); grass greens stay plantable", () => {
    const S = 4, mapSize = 1000;
    const d = new Uint8ClampedArray(S * S * 4);
    for (let i = 0; i < S * S; i++) d[i * 4 + 1] = 255;   // all grass (0,255,0)
    d[1] = 0;                                             // pixel (0,0) black road (top-left = -x, +z)
    d[3 * 4 + 1] = 0; d[3 * 4 + 2] = 255;                 // pixel (3,0) blue water (+x, +z)
    d[(3 * S) * 4 + 1] = 68;                              // pixel (0,3) darkest real grass (0,68,0) (-x, -z)
    const road = makeRoadMask(d, S, S, mapSize);
    expect(road(-499, 499)).toBe(true);    // road
    expect(road(499, 499)).toBe(true);     // water
    expect(road(0, 0)).toBe(false);        // grass
    expect(road(-499, -499)).toBe(false);  // dark grass variant, still plantable
  });

  it("plants ONLY on greenish ground types — every other ink is no-plant, like the road rule", () => {
    const one = (r: number, g: number, b: number) => makeRoadMask(new Uint8ClampedArray([r, g, b, 255]), 1, 1, 100)(0, 0);
    expect(one(60, 120, 50)).toBe(false);    // grass
    expect(one(40, 80, 30)).toBe(false);     // dark forest floor
    expect(one(100, 110, 40)).toBe(false);   // olive field
    expect(one(0, 0, 0)).toBe(true);         // road ink
    expect(one(40, 80, 140)).toBe(true);     // blue water
    expect(one(40, 110, 120)).toBe(true);    // teal water
    expect(one(150, 100, 60)).toBe(true);    // muddy water / bare dirt
    expect(one(140, 60, 150)).toBe(true);    // violet water
    expect(one(120, 120, 120)).toBe(true);   // neutral grey: not greenish, no trees
  });

  it("carved stream beds mask even under green paint (depression bonus)", () => {
    const grass = new Uint8ClampedArray([60, 120, 50, 255]);
    expect(makeRoadMask(grass, 1, 1, 100, () => 0.05)(0, 0)).toBe(true);    // carved
    expect(makeRoadMask(grass, 1, 1, 100, () => 0)(0, 0)).toBe(false);      // level green
    expect(makeRoadMask(grass, 1, 1, 100)(0, 0)).toBe(false);               // no sampler
  });
});

// ---------- makeBuildingMask ----------

describe("makeBuildingMask", () => {
  it("masks within 20 m of a building, including hash cells straddling the origin", () => {
    const bm = makeBuildingMask([{ x: 0, z: 0 }, { x: 500, z: -300 }]);
    expect(bm(5, 5)).toBe(true);
    expect(bm(-14, 14)).toBe(true);     // 19.8 m away, across the 0-straddling cells
    expect(bm(0, 25)).toBe(false);      // 25 m: outside the clearing
    expect(bm(505, -310)).toBe(true);
    expect(bm(450, -300)).toBe(false);
  });
});

// ---------- makeDepressionSampler ----------

describe("makeDepressionSampler", () => {
  const flat = (v: number) => new Float32Array(64).fill(v);
  it("carved channel positive, flat ground zero, a ridge negative — all local, no global level", () => {
    const carved = flat(0.5); for (let y = 0; y < 8; y++) carved[y * 8 + 2] = 0.4;
    const ridged = flat(0.5); for (let y = 0; y < 8; y++) ridged[y * 8 + 2] = 0.6;
    const dc = makeDepressionSampler({ w: 8, h: 8, px: carved }, 600);   // r=2 -> 5×5 window
    const dr = makeDepressionSampler({ w: 8, h: 8, px: ridged }, 600);
    expect(dc(-112.5, -37.5)).toBeCloseTo(0.08, 3);    // bed sits 0.08 below its window mean
    expect(dc(112.5, -37.5)).toBeCloseTo(0, 6);        // flat field far from the channel
    expect(dr(-112.5, -37.5)).toBeCloseTo(-0.08, 3);   // ridge sits above its surroundings
  });
});

// ---------- fillSpecies ----------

describe("fillSpecies", () => {
  const mapSize = 1000, half = mapSize / 2 - 60;   // 440

  it("cluster: seeds only from trees inside the terrain (immersion trees beyond it are ignored)", () => {
    const outside = Array.from({ length: 50 }, (_, i) => tree(3000 + i, 3000, 9));
    const species = [sp("pine", [tree(0, 0, 1), ...outside])];
    const res = fillSpecies(species, 20, mapSize, "cluster", null, lcg(3));
    expect(res.added).toBe(20);   // every try seeds from the lone inside tree, none wasted outside
    for (const t of species[0].trees.filter(t => t.isNew)) {
      expect(Math.abs(t.x)).toBeLessThanOrEqual(half + 0.05);
      expect(Math.abs(t.z)).toBeLessThanOrEqual(half + 0.05);
    }
  });

  it("cluster: adds nothing (and does not crash) when every tree is outside the terrain", () => {
    const species = [sp("pine", [tree(3000, 3000, 1), tree(-2000, 500, 2)])];
    const res = fillSpecies(species, 10, mapSize, "cluster", null, lcg(5));
    expect(res.added).toBe(0);
    expect(species[0].trees).toHaveLength(2);
  });

  it("uniform: stays in bounds, addedPer sums to added <= target, coords rounded", () => {
    const species = [
      sp("pine", [tree(0, 0, 1), tree(10, 10, 2)]),
      sp("oaktree", [tree(-5, -5, 3)]),
    ];
    const before = species.map(s => s.trees.length);
    const target = 30;
    const res = fillSpecies(species, target, mapSize, "uniform", null, lcg(42));
    expect(res.added).toBeLessThanOrEqual(target);
    expect(res.added).toBe(target);   // uniform never rejects in-bounds samples
    expect(res.addedPer.reduce((a, b) => a + b, 0)).toBe(res.added);
    species.forEach((s, si) => {
      expect(s.trees).toHaveLength(before[si] + res.addedPer[si]);
      for (const t of s.trees.slice(before[si])) {
        expect(t.isNew).toBe(true);
        expect(Math.abs(t.x)).toBeLessThanOrEqual(half + 0.05);
        expect(Math.abs(t.z)).toBeLessThanOrEqual(half + 0.05);
        expect(Math.abs(t.x * 10 - Math.round(t.x * 10))).toBeLessThan(1e-6);
        expect(Math.abs(t.z * 10 - Math.round(t.z * 10))).toBeLessThan(1e-6);
      }
    });
  });

  it("cluster: every new tree lands near an existing point, bounds still enforced", () => {
    const species = [
      sp("pine", [tree(0, 0, 1), tree(400, 400, 2)]),   // second seed near the 440 bound
      sp("oaktree", [tree(-350, 0, 3)]),
    ];
    const res = fillSpecies(species, 40, mapSize, "cluster", null, lcg(7));
    expect(res.added).toBeGreaterThan(0);
    expect(res.added).toBeLessThanOrEqual(40);
    expect(res.addedPer.reduce((a, b) => a + b, 0)).toBe(res.added);
    const flat = species.flatMap(s => s.trees);
    const pts = flat.map(t => [t.x, t.z] as const);
    flat.forEach((t, k) => {
      expect(Math.abs(t.x)).toBeLessThanOrEqual(half + 0.05);
      expect(Math.abs(t.z)).toBeLessThanOrEqual(half + 0.05);
      if (!t.isNew) return;
      // max cluster radius is 90; allow slack for 0.1-rounding of child and parent
      const near = pts.some((p, j) => j !== k && Math.hypot(p[0] - t.x, p[1] - t.z) <= 90.2);
      expect(near).toBe(true);
    });
  });

  it("spaced: never places two trees in one hash cell", () => {
    const species = [sp("pine", [tree(-400, -400, 1), tree(0, 0, 2), tree(400, 400, 3)])];
    const target = 40, total = 3;
    const res = fillSpecies(species, target, mapSize, "spaced", null, lcg(11));
    expect(res.added).toBeGreaterThan(0);
    // reproduce the production hash exactly
    const cell = Math.max(8, Math.sqrt((mapSize * mapSize) / Math.max(1, total + target)) * 0.7);
    const keys = species[0].trees.map(t => ((t.x / cell) | 0) + ":" + ((t.z / cell) | 0));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("colour with weightFn () => 0 adds nothing via the try-limit exit", () => {
    const species = [sp("pine", [tree(0, 0, 1)])];
    const res = fillSpecies(species, 10, mapSize, "colour", () => 0, lcg(3));
    expect(res.added).toBe(0);
    expect(res.addedPer).toEqual([0]);
    expect(species[0].trees).toHaveLength(1);   // untouched
  });

  it("colour with weightFn () => 1 fills the target", () => {
    const species = [sp("pine", [tree(0, 0, 1)])];
    const res = fillSpecies(species, 10, mapSize, "colour", () => 1, lcg(3));
    expect(res.added).toBe(10);
    expect(res.addedPer).toEqual([10]);
    expect(species[0].trees).toHaveLength(11);
  });

  it("colour with a null weightFn behaves like uniform (fills the target)", () => {
    const species = [sp("pine", [tree(0, 0, 1)])];
    const res = fillSpecies(species, 5, mapSize, "colour", null, lcg(5));
    expect(res.added).toBe(5);
  });

  it("never places a fill point where roadFn says road", () => {
    const species = [sp("pine", [tree(-100, 0, 1)])];
    const res = fillSpecies(species, 15, mapSize, "uniform", null, lcg(3), (wx) => wx > 0);
    expect(res.added).toBeGreaterThan(0);
    for (const t of species[0].trees.filter(t => t.isNew)) expect(t.x).toBeLessThanOrEqual(0);
  });

  it("keeps every fill point at least 8 m from existing and placed trees", () => {
    const species = [sp("pine", [tree(0, 0, 1), tree(50, 50, 2)])];
    const res = fillSpecies(species, 30, mapSize, "cluster", null, lcg(9));
    expect(res.added).toBeGreaterThan(0);
    const pts = species[0].trees.map(t => [t.x, t.z]);
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
      if (!species[0].trees[a].isNew && !species[0].trees[b].isNew) continue;   // originals may pre-overlap
      // 0.2 slack: coords are rounded to 0.1 m after the spacing check
      expect(Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1])).toBeGreaterThanOrEqual(8 - 0.2);
    }
  });

  it("never adds to an empty species: selection hitting it is skipped", () => {
    const donor = tree(0, 0, 9);
    const species = [sp("empty1", []), sp("fulltree", [donor])];
    // per attempt (uniform): rng -> wx, rng -> wz, [min-dist check, no rng], species pick, proto.
    // Attempt 1 at (352,352): species pick 0 selects empty si=0 -> continue.
    // Attempt 2 at (176,176): pick 0.5 -> si=1 -> places.
    const rng = seq([0.9, 0.9, 0 /* picks empty si=0 */, 0.7, 0.7, 0.5, 0.5 /* picks si=1 */]);
    const res = fillSpecies(species, 1, mapSize, "uniform", null, rng);
    expect(res.added).toBe(1);
    expect(res.addedPer).toEqual([0, 1]);
    expect(species[0].trees).toHaveLength(0);
    expect(species[1].trees).toHaveLength(2);
    expect(species[1].trees[1].extra).toBe(donor.extra);
    expect(species[1].trees[1].isNew).toBe(true);
  });
});
