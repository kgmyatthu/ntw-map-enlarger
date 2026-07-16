import { describe, it, expect } from "vitest";
import { readDDS } from "./dds";
import { makeDDS } from "../test/fixtures";

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
