import { describe, it, expect } from "vitest";
import { readDDS, readTGA } from "./dds";
import { makeDDS } from "../test/fixtures";

/** Minimal TGA builder: 18-byte header + optional BGR palette + raw bytes. */
function makeTGA(w: number, h: number, type: number, bits: 8 | 24 | 32, topDown: boolean, body: number[], pal?: number[][], palBits = 24): Uint8Array {
  const hd = new Uint8Array(18);
  hd[1] = pal ? 1 : 0;
  hd[2] = type;
  if (pal) { hd[5] = pal.length & 0xff; hd[6] = pal.length >> 8; hd[7] = palBits; }
  hd[12] = w & 0xff; hd[13] = w >> 8;
  hd[14] = h & 0xff; hd[15] = h >> 8;
  hd[16] = bits;
  hd[17] = topDown ? 0x20 : 0;
  const palBytes = pal ? pal.flat() : [];
  const out = new Uint8Array(18 + palBytes.length + body.length);
  out.set(hd); out.set(palBytes, 18); out.set(body, 18 + palBytes.length);
  return out;
}

describe("readTGA", () => {
  it("uncompressed 8-bit grey, bottom-up: flips rows so row 0 = top", () => {
    // rows in file: bottom [10, 200], top [30, 40]
    const t = readTGA(makeTGA(2, 2, 3, 8, false, [10, 200, 30, 40]));
    expect(t.w).toBe(2);
    expect(t.h).toBe(2);
    expect([t.data[0], t.data[4], t.data[8], t.data[12]]).toEqual([30, 40, 10, 200]);
    expect(t.data[3]).toBe(255);   // opaque alpha
  });

  it("uncompressed 24-bit top-down: BGR becomes RGB", () => {
    const t = readTGA(makeTGA(1, 1, 2, 24, true, [1, 2, 3]));   // B=1 G=2 R=3
    expect([t.data[0], t.data[1], t.data[2], t.data[3]]).toEqual([3, 2, 1, 255]);
  });

  it("RLE (type 10): run and raw packets decode to the right pixels", () => {
    // run of 2 × BGR(0,0,200), then raw packet of 1 × BGR(0,0,10)
    const t = readTGA(makeTGA(3, 1, 10, 24, true, [0x81, 0, 0, 200, 0x00, 0, 0, 10]));
    expect([t.data[0], t.data[4], t.data[8]]).toEqual([200, 200, 10]);
  });

  it("colour-mapped type 1 (NTW ground_type_map): BGR palette lookup, bottom-up flip", () => {
    // palette: 0 = BGR(10,20,30) -> RGB(30,20,10), 1 = black, 2 = BGR(0,255,0) -> green
    // rows in file: bottom [1, 2], top [0, 0]
    const t = readTGA(makeTGA(2, 2, 1, 8, false, [1, 2, 0, 0], [[10, 20, 30], [0, 0, 0], [0, 255, 0]]));
    expect([t.data[0], t.data[1], t.data[2], t.data[3]]).toEqual([30, 20, 10, 255]);   // top-left = index 0
    expect([t.data[8], t.data[9], t.data[10]]).toEqual([0, 0, 0]);                     // bottom-left = index 1
    expect([t.data[12], t.data[13], t.data[14]]).toEqual([0, 255, 0]);                 // bottom-right = index 2
  });

  it("RLE colour-mapped type 9: run packet of indices decodes via palette", () => {
    const t = readTGA(makeTGA(3, 1, 9, 8, true, [0x81, 1, 0x00, 0], [[0, 0, 200], [0, 0, 10]]));
    expect([t.data[0], t.data[4], t.data[8]]).toEqual([10, 10, 200]);   // 2x index 1, then index 0
  });

  it("throws on unsupported palette entry size", () => {
    expect(() => readTGA(makeTGA(1, 1, 1, 8, true, [0], [[0, 0]], 16))).toThrow("unsupported tga");
  });

  it("throws on unknown image type", () => {
    expect(() => readTGA(makeTGA(1, 1, 7, 8, true, [0]))).toThrow("unsupported tga");
  });
});

describe("readDDS", () => {
  it("reads width/height from header on a non-square image (h at 12, w at 16)", () => {
    const dds = makeDDS(5, 3, 8);
    const hm = readDDS(dds.buffer);
    expect(hm.w).toBe(5);
    expect(hm.h).toBe(3);
    expect(hm.px.length).toBe(15);
  });

  it("8-bit: normalises v/255", () => {
    const vals = [0, 1, 128, 255, 37, 200];
    const dds = makeDDS(3, 2, 8, i => vals[i]);
    const hm = readDDS(dds.buffer);
    expect(hm.px.length).toBe(6);
    for (let i = 0; i < vals.length; i++) {
      expect(hm.px[i]).toBeCloseTo(vals[i] / 255, 6);
    }
  });

  it("16-bit: normalises v/65535 including values > 255", () => {
    const vals = [0, 300, 65535, 1000, 40000, 65534];
    const dds = makeDDS(2, 3, 16, i => vals[i]);
    const hm = readDDS(dds.buffer);
    expect(hm.w).toBe(2);
    expect(hm.h).toBe(3);
    expect(hm.px.length).toBe(6);
    for (let i = 0; i < vals.length; i++) {
      expect(hm.px[i]).toBeCloseTo(vals[i] / 65535, 6);
    }
    // explicit > 255 check: not truncated to a byte
    expect(hm.px[4]).toBeCloseTo(40000 / 65535, 6);
    expect(hm.px[4]).toBeGreaterThan(255 / 65535);
  });

  it("24-bit: reads first byte of each 3-byte pixel, v/255", () => {
    const vals = [10, 20, 250, 0, 255, 99, 1, 128];
    const dds = makeDDS(4, 2, 24, i => vals[i]);
    const hm = readDDS(dds.buffer);
    expect(hm.w).toBe(4);
    expect(hm.h).toBe(2);
    expect(hm.px.length).toBe(8);
    for (let i = 0; i < vals.length; i++) {
      expect(hm.px[i]).toBeCloseTo(vals[i] / 255, 6);
    }
  });

  it("24-bit: ignores the other two bytes of each pixel", () => {
    const dds = makeDDS(2, 2, 24, () => 0);
    // fill the 2nd and 3rd byte of every pixel with garbage
    for (let i = 0; i < 4; i++) {
      dds[128 + i * 3 + 1] = 0xff;
      dds[128 + i * 3 + 2] = 0xee;
    }
    const hm = readDDS(dds.buffer);
    for (let i = 0; i < 4; i++) expect(hm.px[i]).toBe(0);
  });

  it("32-bit: reads first byte of each 4-byte pixel, v/255", () => {
    const vals = [5, 250, 0, 255, 77, 200];
    const dds = makeDDS(3, 2, 32, i => vals[i]);
    const hm = readDDS(dds.buffer);
    expect(hm.px.length).toBe(6);
    for (let i = 0; i < vals.length; i++) {
      expect(hm.px[i]).toBeCloseTo(vals[i] / 255, 6);
    }
  });

  it("32-bit: ignores the other three bytes of each pixel", () => {
    const dds = makeDDS(2, 2, 32, () => 1);
    for (let i = 0; i < 4; i++) {
      dds[128 + i * 4 + 1] = 0xaa;
      dds[128 + i * 4 + 2] = 0xbb;
      dds[128 + i * 4 + 3] = 0xcc;
    }
    const hm = readDDS(dds.buffer);
    for (let i = 0; i < 4; i++) expect(hm.px[i]).toBeCloseTo(1 / 255, 6);
  });

  it("unknown bits value falls through to the 4-byte-stride branch", () => {
    // build a 32-bit layout then overwrite the bits field with 64
    const vals = [9, 90, 180, 255];
    const dds = makeDDS(2, 2, 32, i => vals[i]);
    new DataView(dds.buffer).setUint32(88, 64, true);
    const hm = readDDS(dds.buffer);
    expect(hm.w).toBe(2);
    expect(hm.h).toBe(2);
    for (let i = 0; i < vals.length; i++) {
      expect(hm.px[i]).toBeCloseTo(vals[i] / 255, 6);
    }
  });

  it("non-square 16-bit image: w and h not swapped, all pixels read", () => {
    // w=1, h=4: a w/h swap would change indexing/length semantics
    const dds = makeDDS(1, 4, 16, i => (i + 1) * 256);
    const hm = readDDS(dds.buffer);
    expect(hm.w).toBe(1);
    expect(hm.h).toBe(4);
    expect(hm.px.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(hm.px[i]).toBeCloseTo(((i + 1) * 256) / 65535, 6);
    }
  });

  it("non-square 24-bit image (w > h) reads exactly w*h pixels", () => {
    const dds = makeDDS(6, 2, 24, i => i * 10);
    const hm = readDDS(dds.buffer);
    expect(hm.w).toBe(6);
    expect(hm.h).toBe(2);
    expect(hm.px.length).toBe(12);
    expect(hm.px[11]).toBeCloseTo(110 / 255, 6);
  });

  it("1x1 image works for every bit depth", () => {
    for (const bits of [8, 16, 24, 32] as const) {
      const denom = bits === 16 ? 65535 : 255;
      const hm = readDDS(makeDDS(1, 1, bits, () => 42).buffer);
      expect(hm.w).toBe(1);
      expect(hm.h).toBe(1);
      expect(hm.px.length).toBe(1);
      expect(hm.px[0]).toBeCloseTo(42 / denom, 6);
    }
  });

  it("returns a Float32Array", () => {
    const hm = readDDS(makeDDS(2, 2, 8).buffer);
    expect(hm.px).toBeInstanceOf(Float32Array);
  });
});
