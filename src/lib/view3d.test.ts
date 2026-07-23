import { describe, it, expect } from "vitest";
import { buildTerrain, projectVerts, bucketTrees, bucketBuildings, render3d } from "./view3d";

const hm = (w: number, h: number, vals: number[]) => ({ w, h, px: new Float32Array(vals) });

// ---------- buildTerrain ----------

describe("buildTerrain", () => {
  it("normalises vertex heights to the map's own min..max", () => {
    // 2×2 heightmap, G=1: the 4 vertices sample the 4 corners
    const t = buildTerrain(hm(2, 2, [0.2, 0.6, 0.4, 0.2]), null, 4, 1);
    expect(t.G).toBe(1);
    expect(t.hs[0]).toBeCloseTo(0, 6);
    expect(t.hs[1]).toBeCloseTo(1, 6);
    expect(t.hs[2]).toBeCloseTo(0.5, 6);
    expect(t.hs[3]).toBeCloseTo(0, 6);
  });

  it("bilinear sampling: grid vertices between pixels interpolate; default G follows heightmap res", () => {
    const t = buildTerrain(hm(2, 2, [0, 1, 1, 0]), null, 2, 2);
    expect(t.hs[4]).toBeCloseTo(0.5, 6);   // centre vertex of the 3×3 grid = mean of all 4 pixels
    expect(buildTerrain({ w: 513, h: 513, px: new Float32Array(513 * 513) }, null, 2).G).toBe(512);
    expect(buildTerrain(hm(2, 2, [0, 1, 1, 0]), null, 2).G).toBe(2);   // floor of 2
  });

  it("flat heightmap: all-zero heights, opaque packed colours, no NaN; no colour image -> no texture", () => {
    const t = buildTerrain(hm(2, 2, [0.5, 0.5, 0.5, 0.5]), null, 4, 1);
    expect([...t.hs]).toEqual([0, 0, 0, 0]);
    expect(t.fill).toBeInstanceOf(Uint32Array);
    expect(t.fill[0] >>> 24).toBe(0xff);   // opaque alpha
    expect(t.tex).toBeNull();
  });

  const red = (c: number) => c & 0xff;   // packed 0xAABBGGRR

  it("contour-band crossings darken the cell (texture bake)", () => {
    const white = new Uint8ClampedArray(2 * 2 * 4).fill(255);
    const flat = buildTerrain(hm(2, 2, [0.5, 0.5, 0.5, 0.5]), white, 2, 1);
    const ramp = buildTerrain(hm(2, 2, [0, 1, 0, 1]), white, 2, 1);
    expect(red(flat.tex![0])).toBe(229);   // 255 × 0.9 shading, no contour
    expect(red(ramp.tex![0])).toBeLessThan(red(flat.tex![0]));
  });

  it("texture bake clamps lit bright channels instead of wrapping them into the neighbour byte", () => {
    // cell (0,0): all four corners in the top contour band, h00-h11 ≈ 0.031 -> k clamps to 1.25
    const t = buildTerrain(hm(3, 3, [0.98, 0.95, 0, 0.96, 0.95, 0, 0, 0, 0]),
      new Uint8ClampedArray(2 * 2 * 4).fill(255), 2, 2);
    expect(t.tex![0] & 0xff).toBe(255);           // white * 1.25 stays white…
    expect((t.tex![0] >> 8) & 0xff).toBe(255);    // …not near-black rgb(62,63,63)
    expect((t.tex![0] >> 16) & 0xff).toBe(255);
  });

  it("bakes the colour image into the texture with per-cell shading (row 0 = +Z)", () => {
    // 2×2 colour: top-left red, others green
    const c = new Uint8ClampedArray(2 * 2 * 4);
    c[0] = 200; c[5] = 200; c[9] = 200; c[13] = 200;
    const t = buildTerrain(hm(2, 2, [0.5, 0.5, 0.5, 0.5]), c, 2, 2);
    expect(t.TS).toBe(2);
    expect(red(t.tex![0])).toBe(180);   // texel (0,0): red 200 × 0.9 flat shading
    expect(red(t.tex![1])).toBe(0);     // texel (1,0): green pixel
  });
});

// ---------- projectVerts ----------

describe("projectVerts", () => {
  it("top-down pitch matches the mirrored 2D convention: +x right, +z UP", () => {
    const pv = projectVerts(1, new Float32Array(4), { yaw: 0, pitch: Math.PI / 2, zoom: 1 }, 200, 200, 100, 50);
    expect(pv[0]).toBeLessThan(100);      // v(0,0) = world (-50, +50): left…
    expect(pv[1]).toBeLessThan(100);      // …and up, like the game renders it
    expect(pv[6]).toBeGreaterThan(100);   // v(1,1) = world (+50, -50): right…
    expect(pv[7]).toBeGreaterThan(100);   // …and down
  });

  it("height lifts vertices up the screen by the same amount at every pitch (profile never squashes while tilting)", () => {
    const lift = 60 * 0.55 * (200 / 145);   // relief * HK * sc
    for (const pitch of [0.3, 0.8, 1.4]) {
      const cam = { yaw: 0, pitch, zoom: 1 };
      const a = projectVerts(1, new Float32Array(4), cam, 200, 200, 100, 60);
      const b = projectVerts(1, new Float32Array([1, 0, 0, 0]), cam, 200, 200, 100, 60);
      expect(a[1] - b[1]).toBeCloseTo(lift, 4);
      expect(b[0]).toBe(a[0]);   // x untouched by height
    }
  });

  it("camera target pan shifts the whole projection opposite the target move", () => {
    const still = projectVerts(1, new Float32Array(4), { yaw: 0, pitch: Math.PI / 2, zoom: 1 }, 200, 200, 100, 0);
    const panned = projectVerts(1, new Float32Array(4), { yaw: 0, pitch: Math.PI / 2, zoom: 1, cx: 10, cz: -5 }, 200, 200, 100, 0);
    const sc = 200 / 145;
    expect(panned[0]).toBeCloseTo(still[0] - 10 * sc, 4);
    expect(panned[1]).toBeCloseTo(still[1] - 5 * sc, 4);   // -z pan, mirrored y
  });

  it("yaw π/2: +z swings right, +x swings down (mirrored camera)", () => {
    const pv = projectVerts(1, new Float32Array(4), { yaw: Math.PI / 2, pitch: Math.PI / 2, zoom: 1 }, 200, 200, 100, 0);
    // v(0,1) = world (+50, +50) → rx = z = +50 (right), rz = x = +50 (down)
    expect(pv[2]).toBeGreaterThan(100);
    expect(pv[3]).toBeGreaterThan(100);
  });
});

// ---------- bucketTrees ----------

describe("bucketTrees", () => {
  it("buckets by cell (row 0 = +Z) and drops immersion trees beyond the terrain", () => {
    const m = bucketTrees([{ trees: [{ x: -49, z: 49 }, { x: 49, z: -49 }, { x: 500, z: 0 }] }], 100, 2);
    expect([...m.keys()].sort()).toEqual([0, 3]);
    expect(m.get(0)![0]).toEqual([-49, 49, 0]);
    expect(m.get(3)![0]).toEqual([49, -49, 0]);
  });

  it("subsamples to at most 20k billboards, including non-multiple totals", () => {
    const count = (n: number) => {
      const m = bucketTrees([{ trees: Array.from({ length: n }, () => ({ x: 0, z: 0 })) }], 100, 2);
      return [...m.values()].reduce((a, b) => a + b.length, 0);
    };
    expect(count(60000)).toBe(20000);
    expect(count(25000)).toBeLessThanOrEqual(20000);   // 20001..39999 used to keep every tree
  });
});

// ---------- render3d ----------

describe("render3d", () => {
  const makeCtx = () => {
    const out: { frame: ImageData | null } = { frame: null };
    const ctx = {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (im: ImageData) => { out.frame = im; },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, out };
  };
  const CANOPY = (0xff000000 | (0x7e << 16) | (0xc9 << 8) | 0x7e) >>> 0;   // packed #7ec97e

  it("rasterises terrain + tree billboards into a single putImageData frame", () => {
    const { ctx, out } = makeCtx();
    const t = buildTerrain(hm(2, 2, [0, 0.5, 0.5, 1]), null, 2, 2);
    const buckets = bucketTrees([{ trees: [{ x: 0, z: 0 }] }], 100, 2);
    render3d(ctx, 100, 100, t, { yaw: 0.5, pitch: 1, zoom: 1 }, 100, 50, buckets, ["#7ec97e"]);
    const px = new Uint32Array(out.frame!.data.buffer);
    const bg = px[0];   // top-left corner stays background
    expect(px.some(p => p !== bg)).toBe(true);       // terrain rasterised
    expect(px.includes(CANOPY)).toBe(true);          // the tree's canopy landed
    expect(t.fill.some(c => px.includes(c))).toBe(true);   // terrain colours present verbatim
  });

  it("billboards fully off the left edge leave no phantom strip in column 0", () => {
    const { ctx, out } = makeCtx();
    const t = buildTerrain(hm(2, 2, [0.5, 0.5, 0.5, 0.5]), null, 2, 2);
    // zoom 4: the tree at x=-40 projects its whole billboard left of the screen,
    // but its cell straddles the edge and survives the cull
    const buckets = bucketTrees([{ trees: [{ x: -40, z: 0 }] }], 100, 2);
    render3d(ctx, 100, 100, t, { yaw: 0, pitch: Math.PI / 2, zoom: 4 }, 100, 0, buckets, ["#7ec97e"]);
    const px = new Uint32Array(out.frame!.data.buffer);
    for (let y = 0; y < 100; y++) expect(px[y * 100]).not.toBe(CANOPY);
  });

  it("zero-size canvas: returns without touching createImageData", () => {
    const ctx = { createImageData: () => { throw new Error("IndexSizeError"); }, putImageData: () => {} } as unknown as CanvasRenderingContext2D;
    const t = buildTerrain(hm(2, 2, [0, 0.5, 0.5, 1]), null, 2, 2);
    expect(() => render3d(ctx, 0, 300, t, { yaw: 0, pitch: 1, zoom: 1 }, 100, 50, null, ["#7ec97e"])).not.toThrow();
  });

  it("full-res texture drapes per-pixel; colourOn=false falls back to bare-ground cells", () => {
    const { ctx, out } = makeCtx();
    // flat map; 2×2 texture: row 0 (world +Z) blue, row 1 yellow
    const c = new Uint8ClampedArray(2 * 2 * 4);
    c[2] = 255; c[6] = 255;                     // blue texels
    c[8] = 255; c[9] = 255; c[12] = 255; c[13] = 255;   // yellow texels
    const t = buildTerrain(hm(2, 2, [0.5, 0.5, 0.5, 0.5]), c, 2, 2);
    const cam = { yaw: 0, pitch: Math.PI / 2, zoom: 1 };
    render3d(ctx, 100, 100, t, cam, 100, 0, null, []);
    const px = new Uint32Array(out.frame!.data.buffer);
    const BLUE = (0xff000000 | (229 << 16)) >>> 0;          // 255 × 0.9 shading
    const YELLOW = (0xff000000 | (229 << 8) | 229) >>> 0;
    expect(px[25 * 100 + 50]).toBe(BLUE);     // +Z renders at the screen TOP (mirrored, like the game)
    expect(px[75 * 100 + 50]).toBe(YELLOW);
    // colour layer off: bare-ground cell fill, no texture colours anywhere
    render3d(ctx, 100, 100, t, cam, 100, 0, null, [], false);
    const px2 = new Uint32Array(out.frame!.data.buffer);
    expect(px2.includes(BLUE)).toBe(false);
    expect(px2[75 * 100 + 50]).toBe(t.fill[0]);
  });

  it("tiny buildings rasterise as category-colour slabs; absent when null", () => {
    const { ctx, out } = makeCtx();
    const t = buildTerrain(hm(2, 2, [0.5, 0.5, 0.5, 0.5]), null, 2, 2);
    // mapSize 800 -> sc ≈ 0.086 -> hut footprint ~1px: the LOD slab path
    const bldgs = bucketBuildings([{ records: [{ name: "east_euro_hut01", x: 0, z: 0, rot: 0 }] }], 800, 2);
    const cam = { yaw: 0.5, pitch: 1, zoom: 1 };
    render3d(ctx, 100, 100, t, cam, 800, 50, null, [], true, bldgs);
    const HOUSE = (0xff000000 | (0x6a << 16) | (0xd0 << 8) | 0xe8) >>> 0;   // packed #e8d06a
    expect(new Uint32Array(out.frame!.data.buffer).includes(HOUSE)).toBe(true);
    render3d(ctx, 100, 100, t, cam, 800, 50, null, [], true, null);
    expect(new Uint32Array(out.frame!.data.buffer).includes(HOUSE)).toBe(false);
  });

  it("large buildings extrude as blocks: shaded sides + brightened top in the category hue", () => {
    const { ctx, out } = makeCtx();
    const t = buildTerrain(hm(2, 2, [0.5, 0.5, 0.5, 0.5]), null, 2, 2);
    // mapSize 100 -> sc ≈ 0.69 -> church footprint ~15px: the block path
    const bldgs = bucketBuildings([{ records: [{ name: "romanic_church", x: 0, z: 0, rot: 8192 }] }], 100, 2);
    render3d(ctx, 100, 100, t, { yaw: 0.5, pitch: 1, zoom: 1 }, 100, 50, null, [], true, bldgs);
    const px = new Uint32Array(out.frame!.data.buffer);
    // landmark #d783c7 roof at 1.08×
    const TOP = (0xff000000 | (Math.min(255, (0xc7 * 1.08) | 0) << 16) | (Math.min(255, (0x83 * 1.08) | 0) << 8) | Math.min(255, (0xd7 * 1.08) | 0)) >>> 0;
    expect(px.includes(TOP)).toBe(true);   // the roof face
  });

  it("bucketBuildings classifies name families into visual dims", () => {
    const b = bucketBuildings([{ records: [
      { name: "nsc_stone_field_wall_01", x: -25, z: 25, rot: 0 },
      { name: "romanic_church", x: 25, z: 25, rot: 16384 },
      { name: "west_euro_hut03", x: -25, z: -25, rot: 0 },
    ] }], 100, 2);
    const all = [...b.values()].flat();
    const wall = all.find(e => e[4] === 6)!, church = all.find(e => e[4] === 11)!, hut = all.find(e => e[4] === 6.5)!;
    expect(wall[5]).toBe(0.6);                    // thin polygon
    expect(church[6]).toBe(15);                   // tall block
    expect(church[3]).toBeCloseTo(Math.PI / 2, 2);   // 16384/65536 of a turn
    expect(hut[6]).toBe(6);
  });

  it("no tree buckets -> no canopy pixels; frame buffer is reused across frames", () => {
    const { ctx, out } = makeCtx();
    const t = buildTerrain(hm(2, 2, [0, 0.5, 0.5, 1]), null, 2, 2);
    render3d(ctx, 100, 100, t, { yaw: 0.5, pitch: 1, zoom: 1 }, 100, 50, null, ["#7ec97e"]);
    const first = out.frame;
    expect(new Uint32Array(first!.data.buffer).includes(CANOPY)).toBe(false);
    render3d(ctx, 100, 100, t, { yaw: 0.9, pitch: 1, zoom: 1 }, 100, 50, null, ["#7ec97e"]);
    expect(out.frame).toBe(first);   // same ImageData object, no per-frame allocation
  });
});
