import { describe, it, expect } from "vitest";
import { parseRigidModel } from "./rigidModel";
import { buildRigidModelBuf } from "../test/fixtures";

// Layout independently verified byte-exact against 2908 real corpus files;
// these tests pin the same reading on synthetic fixtures.

const TRI: [number, number, number][] = [[-1, 0, -1], [1, 0, -1], [0, 5, 0]];

describe("rigid_model codec", () => {
  it("parses positions and indices from a single submesh", () => {
    const m = parseRigidModel(buildRigidModelBuf([{ verts: TRI, idx: [0, 1, 2] }]).buffer);
    expect([...m.verts]).toEqual([-1, 0, -1, 1, 0, -1, 0, 5, 0]);
    expect([...m.idx]).toEqual([0, 1, 2]);
  });

  it("merges submeshes with offset indices", () => {
    const m = parseRigidModel(buildRigidModelBuf([
      { verts: TRI, idx: [0, 1, 2] },
      { verts: [[2, 0, 2], [3, 0, 2], [2, 4, 2]], idx: [0, 1, 2] },
    ]).buffer);
    expect(m.verts.length).toBe(18);
    expect([...m.idx]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(m.verts[9]).toBe(2);   // second submesh appended
  });

  it("rejects the unknown variant with non-empty extra name slots (block fallback)", () => {
    expect(() => parseRigidModel(buildRigidModelBuf([{ verts: TRI, idx: [0, 1, 2] }], undefined, ["x", "", ""]).buffer))
      .toThrow(/unknown variant/);
  });

  it("rejects corruption: bad magic, truncation, index out of range", () => {
    const good = buildRigidModelBuf([{ verts: TRI, idx: [0, 1, 2] }]);
    const badMagic = good.slice(); badMagic[4] = 0x77;
    expect(() => parseRigidModel(badMagic.buffer)).toThrow(/magic/);
    expect(() => parseRigidModel(good.slice(0, good.length - 4).buffer)).toThrow();
    const badIdx = buildRigidModelBuf([{ verts: TRI, idx: [0, 1, 7] }]);
    expect(() => parseRigidModel(badIdx.buffer)).toThrow(/index/);
  });
});
