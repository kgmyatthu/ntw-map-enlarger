import { describe, it, expect } from "vitest";
import { parseTreeList, buildTreeList, discoverSizeFields } from "./treeList";
import { buildTreeListBuf, defaultTreeListBuf } from "../test/fixtures";

// Fixture layout: 8-byte prefix (u32le size + 4 pad) + 4-byte magic + 40 pad = 52-byte header.
const HDR = 52;

describe("parseTreeList / buildTreeList round-trips", () => {
  it("LRDZ (stride 14) parses fields and rebuilds byte-identically", () => {
    const buf = buildTreeListBuf([
      { name: "pine", trees: [{ x: 100.5, z: -50 }, { x: 0, z: 0 }] },
      { name: "oaktree", trees: [{ x: -80.25, z: 60 }] },
    ]);
    const p = parseTreeList(buf.buffer);
    expect(p.magic).toBe("LRDZ");
    expect(p.stride).toBe(14);
    expect(p.species.map(s => s.name)).toEqual(["pine", "oaktree"]);
    expect(p.header).toEqual(buf.slice(0, HDR));
    expect(p.species[0].trees.map(t => [t.x, t.z])).toEqual([[100.5, -50], [0, 0]]);
    expect(p.species[1].trees.map(t => [t.x, t.z])).toEqual([[-80.25, 60]]);
    // default extra fill is 0xAA, 4 bytes for LRDZ
    expect(p.species[0].trees[0].extra).toEqual(new Uint8Array(4).fill(0xaa));
    expect(p.species.every(s => s.trees.every(t => t.isNew === false))).toBe(true);
    // nameBytes keep the 0x0e-prefixed UTF-16LE block verbatim
    expect(Array.from(p.species[0].nameBytes)).toEqual(
      [0x0e, 4, 0, 0x70, 0, 0x69, 0, 0x6e, 0, 0x65, 0]);
    expect(p.origBytes).toEqual(buf);
    expect(buildTreeList(p)).toEqual(buf);
  });

  it("RIKI (stride 16) parses 6-byte extras and rebuilds byte-identically", () => {
    const buf = buildTreeListBuf([
      { name: "birch", trees: [{ x: 1.5, z: -2.5, extra: [1, 2, 3, 4, 5, 6] }] },
      { name: "spruce", trees: [{ x: 3, z: 4 }, { x: -5, z: 6.5 }] },
    ], "RIKI");
    const p = parseTreeList(buf.buffer);
    expect(p.magic).toBe("RIKI");
    expect(p.stride).toBe(16);
    expect(p.species.map(s => s.name)).toEqual(["birch", "spruce"]);
    expect(Array.from(p.species[0].trees[0].extra)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.species[1].trees[1].extra).toEqual(new Uint8Array(6).fill(0xaa));
    expect(p.species[1].trees.map(t => [t.x, t.z])).toEqual([[3, 4], [-5, 6.5]]);
    expect(buildTreeList(p)).toEqual(buf);
  });

  it("preserves custom extra bytes and trailing bytes for both magics", () => {
    for (const magic of ["LRDZ", "RIKI"] as const) {
      const extraLen = magic === "RIKI" ? 6 : 4;
      const extra = Array.from({ length: extraLen }, (_, i) => i + 1);
      const buf = buildTreeListBuf([
        { name: "pine", trees: [{ x: 1, z: 2, extra }], trailing: [7, 7, 7] },
        { name: "oaktree", trees: [{ x: 3, z: 4 }], trailing: [9, 8, 7, 6, 5] },
      ], magic);
      const p = parseTreeList(buf.buffer);
      expect(Array.from(p.species[0].trees[0].extra)).toEqual(extra);
      // mid-buffer trailing (between species) and end-of-buffer trailing
      expect(Array.from(p.species[0].trailing)).toEqual([7, 7, 7]);
      expect(Array.from(p.species[1].trailing)).toEqual([9, 8, 7, 6, 5]);
      expect(buildTreeList(p)).toEqual(buf);
    }
  });

  it("species with zero trees round-trip (count field = 8)", () => {
    const buf = buildTreeListBuf([
      { name: "aspen", trees: [] },
      { name: "pine", trees: [] },
    ]);
    const p = parseTreeList(buf.buffer);
    expect(p.species.map(s => s.name)).toEqual(["aspen", "pine"]);
    expect(p.species[0].trees).toHaveLength(0);
    expect(p.species[1].trees).toHaveLength(0);
    expect(p.species[0].trailing).toHaveLength(0);
    expect(buildTreeList(p)).toEqual(buf);
  });

  it("accepts boundary name lengths 4 and 200 and boundary chars 32/126", () => {
    const long = "x".repeat(200);
    const buf = buildTreeListBuf([
      { name: "abcd", trees: [{ x: 9, z: -9 }] },   // ln = 4 (lower bound)
      { name: "a b~", trees: [{ x: 1, z: 1 }] },    // space (32) and '~' (126) are valid
      { name: long, trees: [{ x: 9, z: -9 }] },     // ln = 200 (upper bound)
    ]);
    const p = parseTreeList(buf.buffer);
    expect(p.species.map(s => s.name)).toEqual(["abcd", "a b~", long]);
    expect(buildTreeList(p)).toEqual(buf);
  });
});

describe("species scanner rejection", () => {
  // Each byte string is written over the fixture's 40-byte header padding, so the
  // buffer contains an 0x0e that must NOT be taken as a species start.
  const falseStarts: [string, number[]][] = [
    ["name char < 32", [0x0e, 4, 0, 0x1f, 0, 0x61, 0, 0x61, 0, 0x61, 0]],
    ["name char >= 127 (DEL)", [0x0e, 4, 0, 0x7f, 0, 0x61, 0, 0x61, 0, 0x61, 0]],
    ["non-zero UTF-16 high byte", [0x0e, 4, 0, 0x61, 1, 0x62, 0, 0x63, 0, 0x64, 0]],
    ["length 3 (< 4)", [0x0e, 3, 0, 0x61, 0, 0x62, 0, 0x63, 0]],
    ["length 201 (> 200)", [0x0e, 201, 0, 0x61, 0, 0x62, 0, 0x63, 0, 0x64, 0]],
  ];

  it.each(falseStarts)("does not start a species on %s", (_label, bytes) => {
    const buf = defaultTreeListBuf();
    buf.set(bytes, 14); // inside the header pad, before the first real species at 52
    const p = parseTreeList(buf.buffer);
    expect(p.species.map(s => s.name)).toEqual(["pine", "oaktree"]);
    // the rejected bytes stay in the header and survive a rebuild byte-exactly
    expect(p.header).toHaveLength(HDR);
    expect(Array.from(p.header.slice(14, 14 + bytes.length))).toEqual(bytes);
    expect(buildTreeList(p)).toEqual(buf);
  });

  it("rejects an 0x0e whose name would overrun the buffer", () => {
    const g = new Uint8Array(20).fill(0x2e); // '.' — printable but never 0x0e
    g.set([0x0e, 4, 0, 0x61, 0, 0x62, 0], 13); // ln=4 needs 8 name bytes, only 4 remain
    expect(() => parseTreeList(g.buffer)).toThrow("no species blocks");
  });

  it("throws 'no species blocks' on garbage input", () => {
    expect(() => parseTreeList(new Uint8Array(64).fill(0xff).buffer)).toThrow("no species blocks");
    expect(() => parseTreeList(new Uint8Array(64).buffer)).toThrow("no species blocks");
    // every byte is 0x0e, but each implied length 0x0e0e exceeds 200
    expect(() => parseTreeList(new Uint8Array(64).fill(0x0e).buffer)).toThrow("no species blocks");
    expect(() => parseTreeList(new Uint8Array(0).buffer)).toThrow("no species blocks");
  });
});

describe("mutation then rebuild", () => {
  it.each(["LRDZ", "RIKI"] as const)("adding a tree updates size and count fields (%s)", magic => {
    const stride = magic === "RIKI" ? 16 : 14;
    const buf = buildTreeListBuf([
      { name: "pine", trees: [{ x: 100, z: -50 }, { x: 20, z: 30 }] },
      { name: "oaktree", trees: [{ x: -80, z: 60 }] },
    ], magic);
    const p = parseTreeList(buf.buffer);
    p.species[0].trees.push({ x: 12.5, z: -7.25, extra: new Uint8Array(stride - 10).fill(5), isNew: true });
    const out = buildTreeList(p);
    expect(out.length).toBe(buf.length + stride);
    const dv = new DataView(out.buffer);
    expect(dv.getUint32(0, true)).toBe(out.length); // u32 size field at offset 0
    const countOff = p.header.length + p.species[0].nameBytes.length;
    expect(dv.getUint32(countOff, true)).toBe(3 * 256 + 8); // per-species count
    const rp = parseTreeList(out.buffer);
    expect(rp.species[0].trees).toHaveLength(3);
    expect(rp.species[0].trees[2].x).toBe(12.5);
    expect(rp.species[0].trees[2].z).toBe(-7.25);
    expect(Array.from(rp.species[0].trees[2].extra)).toEqual(Array(stride - 10).fill(5));
    expect(rp.species[1].trees).toHaveLength(1); // untouched species intact
  });

  it("removing trees shrinks the buffer and updates both count fields", () => {
    const buf = defaultTreeListBuf(); // pine ×2 trees, oaktree ×1
    const p = parseTreeList(buf.buffer);
    p.species[0].trees.pop();     // pine 2 -> 1
    p.species[1].trees.length = 0; // oaktree 1 -> 0
    const out = buildTreeList(p);
    expect(out.length).toBe(buf.length - 2 * 14);
    const dv = new DataView(out.buffer);
    expect(dv.getUint32(0, true)).toBe(out.length);
    const count0Off = p.header.length + p.species[0].nameBytes.length;
    expect(dv.getUint32(count0Off, true)).toBe(1 * 256 + 8);
    const count1Off = count0Off + 4 + 1 * 14 + p.species[0].trailing.length + p.species[1].nameBytes.length;
    expect(dv.getUint32(count1Off, true)).toBe(0 * 256 + 8);
    const rp = parseTreeList(out.buffer);
    expect(rp.species[0].trees.map(t => [t.x, t.z])).toEqual([[100, -50]]);
    expect(rp.species[1].trees).toHaveLength(0);
  });

  it("rewrites a footer size field discovered in trailing bytes", () => {
    // trailing bytes of the last species encode the total length as u32le -> a footer size field
    const buf = buildTreeListBuf([
      { name: "pine", trees: [{ x: 100, z: -50 }], trailing: [85, 0, 0, 0] },
    ]);
    expect(buf.length).toBe(85);
    expect(discoverSizeFields(buf)).toEqual({ hdr: [[0, 0]], ftr: [[4, 0]] });
    const p = parseTreeList(buf.buffer);
    expect(Array.from(p.species[0].trailing)).toEqual([85, 0, 0, 0]);
    expect(buildTreeList(p)).toEqual(buf); // unchanged round-trip stays byte-identical
    p.species[0].trees.push({ x: 5, z: 6, extra: new Uint8Array(4).fill(0xbb), isNew: true });
    const out = buildTreeList(p);
    expect(out.length).toBe(99);
    const dv = new DataView(out.buffer);
    expect(dv.getUint32(0, true)).toBe(99);  // header field rewritten
    expect(dv.getUint32(95, true)).toBe(99); // footer field rewritten at new end - 4
  });
});

describe("discoverSizeFields", () => {
  it("finds header fields where length - value is in [0, 64]", () => {
    const d = new Uint8Array(100);
    const dv = new DataView(d.buffer);
    dv.setUint32(0, 100, true); // k = 0
    dv.setUint32(4, 90, true);  // k = 10
    dv.setUint32(8, 36, true);  // k = 64, boundary accepted
    dv.setUint32(12, 35, true); // k = 65, rejected
    dv.setUint32(16, 101, true); // L - v = -1, rejected
    const r = discoverSizeFields(d);
    expect(r.hdr).toEqual([[0, 0], [4, 10], [8, 64]]);
    expect(r.ftr).toEqual([]); // trailing zeros give L - 0 = 100 > 64
  });

  it("finds footer fields near the end, keyed by distance from the end", () => {
    const d = new Uint8Array(100);
    const dv = new DataView(d.buffer);
    dv.setUint32(88, 68, true);  // k = 32, feo = 12
    dv.setUint32(96, 100, true); // k = 0,  feo = 4
    const r = discoverSizeFields(d);
    expect(r.ftr).toEqual([[12, 32], [4, 0]]);
    expect(r.hdr).toEqual([]); // leading zeros never match
  });

  it("ignores non-matching values and tolerates tiny buffers", () => {
    expect(discoverSizeFields(new Uint8Array(100).fill(0xff))).toEqual({ hdr: [], ftr: [] });
    expect(discoverSizeFields(new Uint8Array(0))).toEqual({ hdr: [], ftr: [] });
    expect(discoverSizeFields(new Uint8Array(3))).toEqual({ hdr: [], ftr: [] });
    // a 4-byte buffer whose one u32 equals its length matches as both header and footer
    const tiny = new Uint8Array(4);
    new DataView(tiny.buffer).setUint32(0, 4, true);
    expect(discoverSizeFields(tiny)).toEqual({ hdr: [[0, 0]], ftr: [[4, 0]] });
  });
});
