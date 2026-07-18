import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { findFile, loadZipStore, enlargeStore, syncStore, exportEntries } from "./store";
import { parseTreeList, buildTreeList } from "./treeList";
import { parseDeployment, serializeDeployment } from "./deployment";
import type { FileStore, LoadedDeployment, LoadedTreeList } from "../types";
import { DEF_XML, HEIGHT_XML, DEPLOY_XML, defaultTreeListBuf, makeDDS, makeMapZip } from "../test/fixtures";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeStore(entries: Record<string, string | Uint8Array>): FileStore {
  const m: FileStore = new Map();
  for (const [k, v] of Object.entries(entries))
    m.set(k, (typeof v === "string" ? enc.encode(v) : v) as Uint8Array<ArrayBuffer>);
  return m;
}

const text = (store: FileStore, p: string) => dec.decode(store.get(p));

function loadedTrees(path: string, buf: Uint8Array<ArrayBuffer> = defaultTreeListBuf()): LoadedTreeList {
  return { ...parseTreeList(buf.buffer), path };
}

function loadedDeploy(path: string, changed: boolean, xml: string = DEPLOY_XML): LoadedDeployment {
  const d: LoadedDeployment = { ...parseDeployment(xml), path };
  d.changed = changed;
  return d;
}

// ---------------------------------------------------------------- findFile

describe("findFile", () => {
  it("returns the exact root+name match", () => {
    const store = makeStore({ "mymap/definition.xml": DEF_XML, "mymap/other.bin": "x" });
    const hit = findFile(store, "mymap/", "definition.xml");
    expect(hit).not.toBeNull();
    expect(hit!.p).toBe("mymap/definition.xml");
    expect(dec.decode(hit!.v)).toBe(DEF_XML);
  });

  it("matches a '/name' suffix at another depth when root+name is absent", () => {
    const store = makeStore({ "other/deep/nested/grid.fx": "shader" });
    const hit = findFile(store, "mymap/", "grid.fx");
    expect(hit!.p).toBe("other/deep/nested/grid.fx");
    expect(dec.decode(hit!.v)).toBe("shader");
  });

  it("matches a bare top-level name", () => {
    const store = makeStore({ "grid.fx": "top" });
    const hit = findFile(store, "mymap/", "grid.fx");
    expect(hit!.p).toBe("grid.fx");
    expect(dec.decode(hit!.v)).toBe("top");
  });

  it("also matches root '' + name (top-level with empty root)", () => {
    const store = makeStore({ "definition.xml": DEF_XML });
    expect(findFile(store, "", "definition.xml")!.p).toBe("definition.xml");
  });

  it("returns null on a miss, including a non-boundary suffix like 'agrid.fx'", () => {
    const store = makeStore({ "mymap/agrid.fx": "no", "mymap/other.xml": "no" });
    expect(findFile(store, "mymap/", "grid.fx")).toBeNull();
    expect(findFile(store, "mymap/", "nope.xml")).toBeNull();
  });
});

// ------------------------------------------------------------ loadZipStore

describe("loadZipStore", () => {
  it("unpacks a nested-folder zip, skipping directory entries", async () => {
    const zip = new JSZip();
    const folder = zip.folder("mymap")!;
    folder.file("definition.xml", DEF_XML);
    folder.file("data.bin", new Uint8Array([1, 2, 3]));
    const buf = await zip.generateAsync({ type: "arraybuffer" });
    // sanity: the archive really contains a directory entry to skip
    expect(Object.keys((await JSZip.loadAsync(buf)).files)).toContain("mymap/");

    const { store, defPath } = await loadZipStore(buf);
    expect(defPath).toBe("mymap/definition.xml");
    expect(store.size).toBe(2);
    expect(store.has("mymap/")).toBe(false);
    expect(text(store, "mymap/definition.xml")).toBe(DEF_XML);
    expect(Array.from(store.get("mymap/data.bin")!)).toEqual([1, 2, 3]);
  });

  it("unpacks a top-level zip (definition.xml at the archive root)", async () => {
    const zip = new JSZip();
    zip.file("definition.xml", DEF_XML);
    zip.file("readme.txt", "hi");
    const { store, defPath } = await loadZipStore(await zip.generateAsync({ type: "arraybuffer" }));
    expect(defPath).toBe("definition.xml");
    expect(store.size).toBe(2);
    expect(text(store, "readme.txt")).toBe("hi");
  });

  it("throws 'no definition.xml' when the archive has no anchor file either", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "hi");
    zip.file("mymap/height_map_0.dds", makeDDS(4, 4, 8));
    await expect(loadZipStore(await zip.generateAsync({ type: "arraybuffer" })))
      .rejects.toThrow("no definition.xml");
  });

  it("no definition.xml: anchors a virtual defPath on height settings", async () => {
    const zip = new JSZip();
    zip.file("mymap/height_map_0_settings.xml", HEIGHT_XML);
    const { store, defPath } = await loadZipStore(await zip.generateAsync({ type: "arraybuffer" }));
    expect(defPath).toBe("mymap/definition.xml");
    expect(store.has(defPath)).toBe(false);
  });

  it("loads the makeMapZip File fixture with no directory keys in the store", async () => {
    const { store, defPath } = await loadZipStore(await makeMapZip());
    expect(defPath).toBe("mymap/definition.xml");
    for (const p of store.keys()) expect(p.endsWith("/")).toBe(false);
    expect(store.has("mymap/bmd.tree_list")).toBe(true);
    expect(store.has("mymap/deployment_areas.xml")).toBe(true);
    expect(store.has("mymap/colour_map_0.png")).toBe(true);
  });
});

// ------------------------------------------------------------ enlargeStore

describe("enlargeStore at factor 2 (full map)", () => {
  const png = enc.encode("\x89PNG") as Uint8Array<ArrayBuffer>;
  const dds = makeDDS(4, 4, 8);
  const store = makeStore({
    "mymap/definition.xml": DEF_XML,
    "mymap/height_map_0_settings.xml": HEIGHT_XML,
    "mymap/deployment_areas.xml": DEPLOY_XML,
    "mymap/bmd.tree_list": defaultTreeListBuf(),
    "mymap/height_map_0.dds": dds,
  });
  store.set("mymap/colour_map_0.png", png);
  const r = enlargeStore(store, "mymap/definition.xml", 2, 100);

  it("returns root and extent = round(base_terrain_width * factor)", () => {
    expect(r.root).toBe("mymap/");
    expect(r.extent).toBe(2048);
  });

  it("scales definition base_terrain_width/height with 6-decimal formatting", () => {
    const def = text(r.out, "mymap/definition.xml");
    expect(def).toContain("base_terrain_width='2048.000000'");
    expect(def).toContain("base_terrain_height='2048.000000'");
  });

  it("scales height settings world_width/world_height and captures origScale + scaleNote", () => {
    const h = text(r.out, "mymap/height_map_0_settings.xml");
    expect(h).toContain("world_width='2048.000000'");
    expect(h).toContain("world_height='2048.000000'");
    expect(h).toContain("scale='0.600000'"); // scale attribute itself untouched
    expect(r.origScale).toBe("0.600000");
    expect(r.scaleNote).toBe("scale 0.600000");
  });

  it("pushes each (block, alliance) zone group outward along its centroid ray, records bases", () => {
    expect(r.nZones).toBe(3);
    expect(r.depPath).toBe("mymap/deployment_areas.xml");
    expect(r.dep!.path).toBe("mymap/deployment_areas.xml");
    // block-0 groups bind on y (849 bound: t≈502); block-1 group binds at t≈539
    expect(r.shift).toBe(539);
    // x offsets quantise toward the base (never past the exact edge limit):
    // A/B shift exactly 224.5 (ray 1:2), C floors 170.472 -> 170.4
    expect(r.dep!.zones.map(z => [z.x0, z.y0, z.x, z.y])).toEqual([
      [-200, -400, -424.5, -849],
      [200, 400, 424.5, 849],
      [-100, -300, -270.4, -811.4],
    ]);
  });

  it("serializes the shifted deployment into the output store", () => {
    const d = text(r.out, "mymap/deployment_areas.xml");
    expect(d).toContain('y="-849"');
    expect(d).toContain('y="849"');
    expect(d).toContain('y="-811.4"');
    expect(d).toContain('x="-424.5"'); // x moves too: the push is a 2D vector
    expect(d).toBe(serializeDeployment(r.dep!));
  });

  it("scales tree coords by factor, counts trees, returns treePts", () => {
    expect(r.nTrees).toBe(3);
    expect(r.treePts).toEqual([[200, -100], [40, 60], [-160, 120]]);
    const rebuilt = parseTreeList(r.out.get("mymap/bmd.tree_list")!.buffer);
    expect(rebuilt.species.map(s => s.trees.map(t => [t.x, t.z]))).toEqual([
      [[200, -100], [40, 60]],
      [[-160, 120]],
    ]);
  });

  it("captures colour_map_0.png as colourBytes AND passes it through", () => {
    expect(r.colourBytes).toBe(png);
    expect(r.out.get("mymap/colour_map_0.png")).toBe(png);
  });

  it("passes unrelated files through byte-identical", () => {
    expect(r.out.get("mymap/height_map_0.dds")).toBe(dds);
  });

  it("keeps the full file set", () => {
    expect([...r.out.keys()].sort()).toEqual([...store.keys()].sort());
  });
});

describe("enlargeStore at factor 1.5", () => {
  const store = makeStore({
    "m/definition.xml": DEF_XML,
    "m/height_map_0_settings.xml": HEIGHT_XML,
    "m/bmd.tree_list": defaultTreeListBuf(),
  });
  const r = enlargeStore(store, "m/definition.xml", 1.5, 50);

  it("scales definition and extent by 1.5", () => {
    expect(r.extent).toBe(1536);
    const def = text(r.out, "m/definition.xml");
    expect(def).toContain("base_terrain_width='1536.000000'");
    expect(def).toContain("base_terrain_height='1536.000000'");
    expect(text(r.out, "m/height_map_0_settings.xml")).toContain("world_width='1536.000000'");
  });

  it("scales tree coords by 1.5", () => {
    expect(r.treePts).toEqual([[150, -75], [30, 45], [-120, 90]]);
    expect(r.nTrees).toBe(3);
  });

  it("defaults deployment/colour results when those files are absent", () => {
    expect(r.nZones).toBe(0);
    expect(r.shift).toBe(0);
    expect(r.dep).toBeNull();
    expect(r.depPath).toBeNull();
    expect(r.colourBytes).toBeNull();
  });
});

describe("enlargeStore scale-note capture rules", () => {
  it("ignores scale in height_map_1_settings.xml (still scales the file)", () => {
    const store = makeStore({
      "m/definition.xml": DEF_XML,
      "m/height_map_1_settings.xml": HEIGHT_XML,
    });
    const r = enlargeStore(store, "m/definition.xml", 2, 100);
    expect(r.origScale).toBeNull();
    expect(r.scaleNote).toBe("");
    const h = text(r.out, "m/height_map_1_settings.xml");
    expect(h).toContain("world_width='2048.000000'");
    expect(h).toContain("world_height='2048.000000'");
  });

  it("leaves origScale null when height_map_0_settings.xml has no scale attribute", () => {
    const noScale = `<height_map world_width='512.000000' world_height='512.000000'/>`;
    const store = makeStore({
      "m/definition.xml": DEF_XML,
      "m/height_map_0_settings.xml": noScale,
    });
    const r = enlargeStore(store, "m/definition.xml", 2, 100);
    expect(r.origScale).toBeNull();
    expect(r.scaleNote).toBe("");
    const h = text(r.out, "m/height_map_0_settings.xml");
    expect(h).toContain("world_width='1024.000000'");
    expect(h).toContain("world_height='1024.000000'");
  });
});

describe("enlargeStore edge cases", () => {
  it("passes a bmd.tree_list of 40 bytes through unparsed", () => {
    const tiny = new Uint8Array(40) as Uint8Array<ArrayBuffer>;
    const store = makeStore({ "m/definition.xml": DEF_XML });
    store.set("m/bmd.tree_list", tiny);
    const r = enlargeStore(store, "m/definition.xml", 2, 100);
    expect(r.nTrees).toBe(0);
    expect(r.treePts).toBeNull();
    expect(r.out.get("m/bmd.tree_list")).toBe(tiny);
  });

  it.each(["png", "jpg", "JPG", "jpeg"])("captures colour_map_0.%s as colourBytes", ext => {
    const img = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>;
    const store = makeStore({ "m/definition.xml": DEF_XML });
    store.set(`m/colour_map_0.${ext}`, img);
    const r = enlargeStore(store, "m/definition.xml", 2, 100);
    expect(r.colourBytes).toBe(img);
    expect(r.out.get(`m/colour_map_0.${ext}`)).toBe(img);
  });

  it("shifts a near-centre zone at y=0 up the +y axis, to headroom from the edge", () => {
    const deploy = `<deployment>
<BATTLE_DEPLOYMENT_AREAS>
<ALLIANCE id='0'>
<deployment_area><region x="10" y="0"/><width metres="100"/><height metres="50"/><orientation radians="0"/></deployment_area>
</ALLIANCE>
</BATTLE_DEPLOYMENT_AREAS>
</deployment>`;
    const store = makeStore({ "m/definition.xml": DEF_XML, "m/deployment_areas.xml": deploy });
    const r = enlargeStore(store, "m/definition.xml", 2, 250);
    expect(r.nZones).toBe(1);
    // hy = 25 (h=50, o=0): shift = 1024 - 250 - 0 - 25 = 749
    expect(r.shift).toBe(749);
    expect(r.dep!.zones[0].y0).toBe(0);
    expect(r.dep!.zones[0].y).toBe(749);
    expect(text(r.out, "m/deployment_areas.xml")).toContain('y="749"');
  });

  it("works with root '' (top-level definition.xml)", () => {
    const img = new Uint8Array([9]) as Uint8Array<ArrayBuffer>;
    const store = makeStore({
      "definition.xml": DEF_XML,
      "height_map_0_settings.xml": HEIGHT_XML,
    });
    store.set("colour_map_0.jpg", img);
    const r = enlargeStore(store, "definition.xml", 2, 100);
    expect(r.root).toBe("");
    expect(r.extent).toBe(2048);
    expect(text(r.out, "definition.xml")).toContain("base_terrain_width='2048.000000'");
    expect(text(r.out, "height_map_0_settings.xml")).toContain("world_width='2048.000000'");
    expect(r.origScale).toBe("0.600000");
    expect(r.colourBytes).toBe(img);
  });

  it("no definition.xml: skips the def rewrite, still scales the rest", () => {
    const store = makeStore({
      "m/height_map_0_settings.xml": HEIGHT_XML,
      "m/deployment_areas.xml": DEPLOY_XML,
      "m/bmd.tree_list": defaultTreeListBuf(),
    });
    const r = enlargeStore(store, "m/definition.xml", 2, 100);
    expect(r.extent).toBe(2048);   // from world_width, not the 2048 default (1024 * 2)
    expect(r.out.has("m/definition.xml")).toBe(false);
    expect(text(r.out, "m/height_map_0_settings.xml")).toContain("world_width='2048.000000'");
    expect(r.nZones).toBe(3);
    expect(r.nTrees).toBe(3);
  });
});

// --------------------------------------------------------------- syncStore

describe("syncStore", () => {
  it("encodes xml record entries into the store (overwrite and add)", () => {
    const other = new Uint8Array([7]) as Uint8Array<ArrayBuffer>;
    const store = makeStore({ "m/a.xml": "<old/>" });
    store.set("m/other.bin", other);
    syncStore(store, { "m/a.xml": "<new/>", "m/b.xml": "<added/>" }, null, null);
    expect(text(store, "m/a.xml")).toBe("<new/>");
    expect(text(store, "m/b.xml")).toBe("<added/>");
    expect(store.get("m/other.bin")).toBe(other); // untouched
    expect(store.size).toBe(3);
  });

  it("rebuilds the tree list at its path", () => {
    const store = makeStore({ "m/bmd.tree_list": defaultTreeListBuf() });
    const trees = loadedTrees("m/bmd.tree_list");
    trees.species[0].trees[0].x = 999;
    syncStore(store, {}, trees, null);
    expect(store.get("m/bmd.tree_list")).toEqual(buildTreeList(trees));
    expect(parseTreeList(store.get("m/bmd.tree_list")!.buffer).species[0].trees[0].x).toBe(999);
  });

  it("does NOT write deployment when changed === false", () => {
    const orig = enc.encode(DEPLOY_XML) as Uint8Array<ArrayBuffer>;
    const store: FileStore = new Map([["m/deployment_areas.xml", orig]]);
    syncStore(store, {}, null, loadedDeploy("m/deployment_areas.xml", false));
    expect(store.get("m/deployment_areas.xml")).toBe(orig);
  });

  it("writes serialized deployment when changed === true", () => {
    const store = makeStore({ "m/deployment_areas.xml": DEPLOY_XML });
    const dep = loadedDeploy("m/deployment_areas.xml", true);
    dep.zones[0].y = -999;
    syncStore(store, {}, null, dep);
    const out = text(store, "m/deployment_areas.xml");
    expect(out).toBe(serializeDeployment(dep));
    expect(out).toContain('y="-999"');
  });
});

// ------------------------------------------------------------ exportEntries

describe("exportEntries", () => {
  it("xml override wins over raw bytes (including an empty-string override)", () => {
    const files = makeStore({ "m/definition.xml": DEF_XML, "m/notes.xml": "<n/>" });
    const entries = exportEntries(files, { "m/definition.xml": "<override/>", "m/notes.xml": "" }, null, null);
    const map = new Map(entries);
    expect(dec.decode(map.get("m/definition.xml"))).toBe("<override/>");
    expect(map.get("m/notes.xml")!.length).toBe(0);
  });

  it("rebuilds the trees path via buildTreeList", () => {
    const files = makeStore({ "m/bmd.tree_list": defaultTreeListBuf(), "m/definition.xml": DEF_XML });
    const trees = loadedTrees("m/bmd.tree_list");
    trees.species[1].trees[0].z = -777;
    const entries = exportEntries(files, {}, trees, null);
    const map = new Map(entries);
    expect(map.get("m/bmd.tree_list")).toEqual(buildTreeList(trees));
    expect(parseTreeList(map.get("m/bmd.tree_list")!.buffer).species[1].trees[0].z).toBe(-777);
  });

  it("xml override on the trees path beats the tree rebuild", () => {
    const files = makeStore({ "m/bmd.tree_list": defaultTreeListBuf() });
    const trees = loadedTrees("m/bmd.tree_list");
    const entries = exportEntries(files, { "m/bmd.tree_list": "raw" }, trees, null);
    expect(dec.decode(entries[0][1])).toBe("raw");
  });

  it("rewrites the deploy path only when changed === true", () => {
    const orig = enc.encode(DEPLOY_XML) as Uint8Array<ArrayBuffer>;
    const files: FileStore = new Map([["m/deployment_areas.xml", orig]]);

    const unchanged = exportEntries(files, {}, null, loadedDeploy("m/deployment_areas.xml", false));
    expect(unchanged[0][1]).toBe(orig); // passthrough, same reference

    const dep = loadedDeploy("m/deployment_areas.xml", true);
    dep.zones[1].y = 42;
    const changed = exportEntries(files, {}, null, dep);
    expect(dec.decode(changed[0][1])).toBe(serializeDeployment(dep));
    expect(dec.decode(changed[0][1])).toContain('y="42"');
  });

  it("passes everything else through as the original bytes, preserving order", () => {
    const a = new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
    const b = new Uint8Array([2, 3]) as Uint8Array<ArrayBuffer>;
    const files: FileStore = new Map([["m/a.bin", a], ["m/b.dds", b]]);
    const entries = exportEntries(files, {}, null, null);
    expect(entries.map(e => e[0])).toEqual(["m/a.bin", "m/b.dds"]);
    expect(entries[0][1]).toBe(a);
    expect(entries[1][1]).toBe(b);
  });
});
