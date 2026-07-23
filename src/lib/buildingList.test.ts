import { describe, it, expect } from "vitest";
import { parseBuildingList, buildBuildingList } from "./buildingList";
import { buildBuildingListBuf } from "../test/fixtures";

// Codec independently verified byte-identical against 243 real preset files
// (426,850 records). These tests pin the same behaviour on synthetic fixtures.

const RECS = [
  { name: "small_barn_v1", x: 100.5, z: -50, rot: 4096 },
  // RIKI-style record with the trailing 0x0A f32 some files carry
  { name: "west_euro_hut03", x: -972.5, z: -864, rot: 0, extra: [0x0a, 0, 0, 0, 0] },
];

describe("building_list codec", () => {
  it("parses fields and round-trips byte-identically (both record variants)", () => {
    const buf = buildBuildingListBuf(RECS);
    const t = parseBuildingList(buf.buffer);
    expect(t.records.map(r => r.name)).toEqual(["small_barn_v1", "west_euro_hut03"]);
    expect(t.records[0].x).toBe(100.5);
    expect(t.records[0].z).toBe(-50);
    expect(t.records[0].rot).toBe(4096);
    expect(t.records[0].extra.length).toBe(0);
    expect([...t.records[1].extra]).toEqual([0x0a, 0, 0, 0, 0]);
    expect([...buildBuildingList(t)]).toEqual([...buf]);
  });

  it("RIKI-tagged header round-trips too", () => {
    const buf = buildBuildingListBuf(RECS, "RIKI");
    expect([...buildBuildingList(parseBuildingList(buf.buffer))]).toEqual([...buf]);
  });

  it("moving a building rebuilds consistent offsets and survives reparse", () => {
    const t = parseBuildingList(buildBuildingListBuf(RECS).buffer);
    t.records[0].x = 999.9; t.records[0].z = -1.5;
    const re = parseBuildingList(buildBuildingList(t).buffer);
    expect(re.records[0].x).toBeCloseTo(999.9, 4);
    expect(re.records[0].z).toBeCloseTo(-1.5, 6);
    expect(re.records[1].name).toBe("west_euro_hut03");
    expect([...re.records[1].extra]).toEqual([0x0a, 0, 0, 0, 0]);
  });

  it("renaming (record resize) keeps every downstream offset consistent", () => {
    const t = parseBuildingList(buildBuildingListBuf(RECS).buffer);
    t.records[0].name = "much_longer_building_model_name_v2";
    const re = parseBuildingList(buildBuildingList(t).buffer);
    expect(re.records[0].name).toBe("much_longer_building_model_name_v2");
    expect(re.records[1].x).toBe(-972.5);
  });

  it("rejects CSV/junk files under the extension", () => {
    expect(() => parseBuildingList(new TextEncoder().encode("﻿barn,1,2,0\n").buffer)).toThrow();
    expect(() => parseBuildingList(new Uint8Array(10).buffer)).toThrow();
  });

  it("rejects a corrupt name length that would overrun the record frame (no silent garbage)", () => {
    const buf = buildBuildingListBuf([{ name: "barn_v1", x: 1, z: 2 }]);
    new DataView(buf.buffer).setUint16(0x24 + 4 + 1, 200, true);   // inflate nlen far past the frame
    expect(() => parseBuildingList(buf.buffer)).toThrow(/overrun/);
  });
});
