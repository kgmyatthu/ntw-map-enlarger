import { it, expect } from "vitest";
import { parseTreeList, buildTreeList } from "../lib/treeList";
import { parseDeployment, serializeDeployment } from "../lib/deployment";
import { readDDS } from "../lib/dds";
import { buildTreeListBuf, defaultTreeListBuf, makeDDS, DEPLOY_XML, makeMapZip } from "./fixtures";
import { loadZipStore, enlargeStore } from "../lib/store";

it("tree_list fixture round-trips byte-identically (LRDZ + RIKI)", () => {
  for (const magic of ["LRDZ", "RIKI"] as const) {
    const buf = buildTreeListBuf([
      { name: "pine", trees: [{ x: 100.5, z: -50 }, { x: 0, z: 0 }], trailing: [0, 0] },
      { name: "oaktree", trees: [{ x: -80, z: 60 }] },
    ], magic);
    const p = parseTreeList(buf.buffer);
    expect(p.magic).toBe(magic);
    expect(p.species.map(s => s.name)).toEqual(["pine", "oaktree"]);
    expect(p.species[0].trees).toHaveLength(2);
    expect(p.species[0].trees[0].x).toBeCloseTo(100.5);
    expect(buildTreeList(p)).toEqual(buf);
  }
});

it("size fields update when trees are added", () => {
  const buf = defaultTreeListBuf();
  const p = parseTreeList(buf.buffer);
  p.species[0].trees.push({ x: 1, z: 2, extra: p.species[0].trees[0].extra, isNew: true });
  const out = buildTreeList(p);
  expect(out.length).toBe(buf.length + p.stride);
  expect(new DataView(out.buffer).getUint32(0, true)).toBe(out.length);
});

it("deployment fixture parses 3 zones / 2 blocks and round-trips", () => {
  const dep = parseDeployment(DEPLOY_XML);
  expect(dep.zones).toHaveLength(3);
  expect(dep.nBlocks).toBe(2);
  expect(dep.zones.map(z => z.block)).toEqual([0, 0, 1]);
  expect(dep.zones.map(z => z.alliance)).toEqual([0, 1, 0]);
  expect(serializeDeployment(dep)).toBe(DEPLOY_XML);
});

it("dds fixture reads back dimensions and pixels", () => {
  const hm = readDDS(makeDDS(4, 3, 8, i => i).buffer);
  expect([hm.w, hm.h]).toEqual([4, 3]);
  expect(hm.px[5]).toBeCloseTo(5 / 255);
});

it("map zip loads and enlarges", async () => {
  const f = await makeMapZip();
  const { store, defPath } = await loadZipStore(f);
  expect(defPath).toBe("mymap/definition.xml");
  const r = enlargeStore(store, defPath, 2, 400);
  expect(r.extent).toBe(2048);
  expect(r.nTrees).toBe(3);
  expect(r.nZones).toBe(3);
  expect(r.origScale).toBe("0.600000");
  expect(new TextDecoder().decode(r.out.get("mymap/definition.xml"))).toContain("base_terrain_width='2048.000000'");
});
