import { useState, useRef, useEffect, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import JSZip from "jszip";
import type {
  LoadedTreeList, LoadedDeployment, LoadedBuildingList, FileStore, Bundle, UndoAction, Tool, FillAlgo,
  LayerState, Entity, View, DragState, Styles, HeightMap,
} from "./types";
import { parseTreeList, buildTreeList } from "./lib/treeList";
import { parseBuildingList } from "./lib/buildingList";
import { readDDS, readTGA } from "./lib/dds";
import { parseDeployment, serializeDeployment, autoShiftZones, zonesOverlap, zoneInBounds } from "./lib/deployment";
import { setScale, shiftBias, baseTerrainWidth, worldWidth, patchGridFx } from "./lib/xml";
import { w2s, s2w, addTrees, eraseTrees, stampPoints, zoneAt, applyUndo, makeColourWeight, makeRoadMask, makeDepressionSampler, makeBuildingMask, DEP_BARE, fillSpecies } from "./lib/edit";
import { findFile, loadZipStore, enlargeStore, syncStore, exportEntries } from "./lib/store";
import { buildTerrain, bucketTrees, bucketBuildings, bldgCat, BLDG_CATS, render3d } from "./lib/view3d";
import { parseRigidModel } from "./lib/rigidModel";
import type { RigidMesh } from "./lib/rigidModel";
import type { Terrain } from "./lib/view3d";
import { heightToCanvas, sampleImage, makeThumb, download, saveZip, saveZipInDir, pickExportDir, SP_COLORS } from "./lib/canvas";

// =====================================================================
// NTW CUSTOM MAP ENLARGER
// Import a map folder zip -> view colour map + heightmap (both stretched,
// matching grid.fx-fixed engine) -> 2x enlarge (XML LOD chain, optional scale)
// -> edit trees & buildings -> export zip.
// Binary codecs (src/lib) ported from byte-identical-verified Python (43
// tree lists, 83 building lists round-tripped).
// =====================================================================

const FILL_INTENSITY = 0.5;   // ponytail: auto-fill adds this fraction of full original density; tune here
// liberal: matches ground_type_map_0 / groud_type_map0 spellings, any extension casing
const GT_RE = /groun?d_?type_?map_?\d*\.(tga|jpg|jpeg|png)$/i;
const ROT_KNOB = 22;   // px from the zone's top edge to the rotate knob

export default function MapEnlarger() {
  const [files, setFiles] = useState<FileStore | null>(null);
  const [mapName, setMapName] = useState("");
  const [colourImg, setColourImg] = useState<HTMLImageElement | null>(null);
  const [alphaImg, setAlphaImg] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);
  const [hmCanvas, setHmCanvas] = useState<HTMLCanvasElement | null>(null);
  const [hmData, setHmData] = useState<HeightMap | null>(null);
  const [mode3d, setMode3d] = useState(false);
  const [trees, setTrees] = useState<LoadedTreeList | null>(null);
  const [blds, setBlds] = useState<LoadedBuildingList[]>([]);
  const [deploy, setDeploy] = useState<LoadedDeployment | null>(null);
  const [blockIdx, setBlockIdx] = useState(0);
  const [selZone, setSelZone] = useState<number | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [baseSize, setBaseSize] = useState(2048);
  const [scaleOpt, setScaleOpt] = useState("");
  const [factor, setFactor] = useState<1.5 | 2>(2);
  const [appliedF, setAppliedF] = useState(1);
  const [shaderMsg, setShaderMsg] = useState<string | null>(null);
  const [headroom, setHeadroom] = useState(200);  // metres kept clear between zones and map edge
  const [batchLog, setBatchLog] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [curBundle, setCurBundle] = useState<number | null>(null);
  const [fillAlgo, setFillAlgo] = useState<FillAlgo>("cluster");
  const [fillN, setFillN] = useState("");
  const [layer, setLayer] = useState<LayerState>({ colour: true, alpha: false, height: true, trees: true, bldg: true, deploy: true });
  const [tool, setTool] = useState<Tool>("pan");
  const [entity, setEntity] = useState<Entity>({ kind: "tree", idx: 0 });
  const [brushR, setBrushR] = useState(60);
  const [density, setDensity] = useState(6);
  const [status, setStatus] = useState("Import a map folder zip to begin.");
  const [, tick] = useState(0);
  const rr = () => tick(t => t + 1);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const srcFiles = useRef<File[]>([]);   // original zips, kept so the factor can be switched after import
  const thumbTimer = useRef<number | undefined>(undefined);
  const view = useRef<View>({ zoom: 0.16, cx: 0, cz: 0 });
  const loadGen = useRef(0);   // bumped per loadStore; async image onloads from older maps bail out
  const cam3 = useRef({ yaw: 0.65, pitch: 1.0, zoom: 1, cx: 0, cz: 0 });
  const t3 = useRef<Terrain | null>(null);
  const buckets3 = useRef<Map<number, number[][]> | null>(null);
  const bucketsB = useRef<Map<number, number[][]> | null>(null);   // buildings, bucketed like trees
  const bldgMeshes = useRef<{ list: RigidMesh[]; byName: Map<string, number> }>({ list: [], byName: new Map() });
  const [meshCount, setMeshCount] = useState(0);
  const raf3 = useRef(0);   // pending rAF id: 3D input coalesces redraws to display refresh
  const drag = useRef<DragState | null>(null);
  const cursor = useRef<[number, number] | null>(null);
  const undoRef = useRef<UndoAction[]>([]);
  const xmlRef = useRef<Record<string, string>>({});

  const mapSize = enlarged ? Math.round(baseSize * appliedF) : baseSize;
  const imgExtent = baseSize;

  const loadStore = (store: FileStore, root: string, displayName: string, processedFactor: number, depOverride: LoadedDeployment | null) => {
    const gen = ++loadGen.current;
    const get = (n: string) => findFile(store, root, n);

    const def = get("definition.xml");
    const hs0 = get("height_map_0_settings.xml");
    // no definition.xml: width from height settings (factor-scaled in processed bundles, same as the def would be)
    const raw = Math.round(def ? baseTerrainWidth(new TextDecoder().decode(def.v))
      : worldWidth(hs0 ? new TextDecoder().decode(hs0.v) : ""));
    const bs = processedFactor ? Math.round(raw / processedFactor) : raw;
    setBaseSize(bs);
    setMapName(displayName);
    xmlRef.current = def ? { [def.p]: new TextDecoder().decode(def.v) } : {};
    for (let i = 0; i < 4; i++) {
      const s = get(`height_map_${i}_settings.xml`);
      if (s) xmlRef.current[s.p] = new TextDecoder().decode(s.v);
    }

    let ci: { p: string; v: Uint8Array<ArrayBuffer> } | null = null;
    for (const n of ["colour_map_0.JPG", "colour_map_0.jpg", "colour_map_0.png"]) { ci = get(n); if (ci) break; }
    if (ci) {
      // clear synchronously: a bundle switch in 3D must not bake the OLD map's
      // colours over the new heightmap while the new image decodes (and the
      // expensive texture bake then runs once, not twice)
      setColourImg(null);
      const im = new Image();
      im.onload = () => { if (loadGen.current !== gen) return; setColourImg(im); rr(); };
      im.src = URL.createObjectURL(new Blob([ci.v]));
    } else setColourImg(null);

    let gtNote = " · no ground_type_map";
    const aKey = [...store.keys()].find(p => GT_RE.test(p));
    if (aKey && /\.tga$/i.test(aKey)) {
      try {
        const t = readTGA(store.get(aKey)!);
        const cv = document.createElement("canvas"); cv.width = t.w; cv.height = t.h;
        const c = cv.getContext("2d")!; // fresh canvas: 2d context is always available
        const im = c.createImageData(t.w, t.h);
        im.data.set(t.data);
        c.putImageData(im, 0, 0);
        setAlphaImg(cv);
        gtNote = ` · ground-type ${t.w}×${t.h} ✓`;
      } catch (e) { gtNote = ` · ground-type FAILED: ${(e as Error).message}`; setAlphaImg(null); }
    } else if (aKey) {
      const im = new Image();
      im.onload = () => { setAlphaImg(im); rr(); };
      im.src = URL.createObjectURL(new Blob([store.get(aKey)!]));
      gtNote = " · ground-type ✓";
    } else setAlphaImg(null);

    let hm = get("height_map_0.dds");
    if (hm) {
      try {
        const hd = readDDS(hm.v.buffer.slice(hm.v.byteOffset, hm.v.byteOffset + hm.v.byteLength));
        setHmCanvas(heightToCanvas(hd)); setHmData(hd);
      } catch { setHmCanvas(null); setHmData(null); }   // compressed/truncated dds: skip the height layer
    } else {
      hm = get("height_map_0.png");
      setHmData(null);
      if (hm) {
        const im = new Image();
        im.onload = () => {
          if (loadGen.current !== gen) return;   // a newer map was loaded while this decoded
          const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
          const cx = cv.getContext("2d")!; // fresh canvas: 2d context is always available
          cx.filter = "grayscale(1)"; cx.drawImage(im, 0, 0);
          const d = cx.getImageData(0, 0, cv.width, cv.height).data;
          const px = new Float32Array(cv.width * cv.height);
          for (let i = 0; i < px.length; i++) px[i] = d[i * 4] / 255;
          setHmCanvas(cv); setHmData({ w: cv.width, h: cv.height, px }); rr();
        };
        im.src = URL.createObjectURL(new Blob([hm.v]));
      } else setHmCanvas(null);
    }

    const tl = get("bmd.tree_list");
    setTrees(tl && tl.v.length > 40 ? { ...parseTreeList(tl.v.buffer.slice(tl.v.byteOffset, tl.v.byteOffset + tl.v.byteLength)), path: tl.p } : null);
    const bl: LoadedBuildingList[] = [];
    for (const [p, v] of store) {
      if (!/\.building_list$/i.test(p) || (root && !p.startsWith(root))) continue;   // this map's lists only
      try { bl.push({ ...parseBuildingList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)), path: p }); }
      catch { /* CSV/foreign files under this extension stay untouched passthrough */ }
    }
    setBlds(bl);
    const dpf = get("deployment_areas.xml");
    if (depOverride) setDeploy(depOverride);
    else if (dpf) {
      try { setDeploy({ ...parseDeployment(new TextDecoder().decode(dpf.v)), path: dpf.p }); }
      catch (e) { console.warn("deploy:", e); setDeploy(null); }
    } else setDeploy(null);
    setBlockIdx(0); setSelZone(null);

    cam3.current.cx = 0; cam3.current.cz = 0;   // a panned-away target on the next map would show empty ground
    setFiles(store);
    setEnlarged(!!processedFactor);
    setAppliedF(processedFactor || 1);
    undoRef.current = [];
    setStatus(`Loaded ${store.size} files, base terrain ${bs} m. ${tl ? "trees ✓" : "no trees"}${dpf ? ", deployment ✓" : ""}.${bl.length ? ` · ${bl.reduce((a, b) => a + b.records.length, 0)} buildings ✓` : ""}${gtNote}`);
  };

  const applyScale = (v: string) => {
    setScaleOpt(v);
    if (!files) return;
    const b = curBundle !== null ? bundles[curBundle] : null;
    const val = v.trim();
    const target = val && !isNaN(parseFloat(val)) ? val
      : (!val && b && b.origScale ? b.origScale : null);   // blank -> restore original
    if (target === null) return;
    let n = 0;
    for (const p of Object.keys(xmlRef.current)) {
      if (p.endsWith("definition.xml")) continue;
      xmlRef.current[p] = setScale(xmlRef.current[p], target);
      n++;
    }
    if (b) b.scaleSet = val || null;
    if (n) setStatus(val
      ? `Height scale=${val} set on THIS map's ${n} LOD files (per-map; blank restores ${b && b.origScale ? b.origScale : "original"}).`
      : `Height scale restored to original (${target}) on this map.`);
  };

  const addTreesAt = (pts: [number, number][]) => {
    if (!trees || entity.kind !== "tree") return;
    const n = addTrees(trees.species, entity.idx, pts);
    if (n === null) return;
    undoRef.current.push({ type: "tree-add", si: entity.idx, n });
    rr();
  };
  const eraseAt = (wx: number, wz: number) => {
    if (!trees) return;
    const removed = eraseTrees(trees.species, wx, wz, brushR);
    if (removed.length) { undoRef.current.push({ type: "erase", removed }); rr(); }
  };
  const undo = () => {
    const a = undoRef.current.pop();
    if (!a) return;
    applyUndo(a, trees, deploy, blds);
    if (a.type === "fill") refreshCurThumb();
    rr();
  };

  // import NTW rigid models (a rigidmodels zip, per-model zips, or loose files):
  // per building, keep the highest lod number = the lowest-poly intact mesh.
  // Key comes from the FILENAME (…_pieceNN_destruct01_lodNN.rigid_model), so
  // folder layout inside the zip doesn't matter.
  const MODEL_RE = /(?:^|\/)([^/]+?)_piece\d+[^/]*_destruct01_lod(\d+)\.rigid_model$/i;
  const importModels = async (fl: File[]) => {
    setStatus(`Loading building models from ${fl.length} file(s)…`);
    const best = new Map<string, { lod: number; bytes: Uint8Array }>();
    const offer = (key: string, lod: number, bytes: Uint8Array) => {
      const cur = best.get(key);
      if (!cur || lod > cur.lod) best.set(key, { lod, bytes });
    };
    try {
      for (const f of fl) {
        if (/\.zip$/i.test(f.name)) {
          const zip = await JSZip.loadAsync(f);
          for (const p of Object.keys(zip.files)) {
            const m = MODEL_RE.exec(p);
            if (m && !zip.files[p].dir) offer(m[1].toLowerCase(), +m[2], new Uint8Array(await zip.files[p].async("arraybuffer")));
          }
        } else if (/\.rigid_model$/i.test(f.name)) {
          const m = MODEL_RE.exec(f.name);
          if (m) offer(m[1].toLowerCase(), +m[2], new Uint8Array(await f.arrayBuffer()));
        }
      }
    } catch (e) {
      setStatus(`Building models import FAILED: ${(e as Error).message}. Very large archives (the full 1.4 GB rigidmodels.zip) can exceed browser memory — import a zip of just the *_lod05.rigid_model files, or multi-select the per-model zips instead.`);
      return;
    }
    const list: RigidMesh[] = [];
    const byName = new Map<string, number>();
    let failed = 0;
    for (const [k, v] of best) {
      try {
        const mesh = parseRigidModel(v.bytes.buffer.slice(v.bytes.byteOffset, v.bytes.byteOffset + v.bytes.byteLength));
        byName.set(k, list.length);
        list.push(mesh);
      } catch { failed++; }   // unknown variants keep the block preview
    }
    bldgMeshes.current = { list, byName };
    setMeshCount(list.length);
    setStatus(`Building models: ${list.length} meshes loaded${failed ? ` (${failed} unsupported → block preview)` : ""}. The 3D view uses them once buildings are big enough on screen.`);
  };

  const onGridFx = async (file: File) => {
    const r = patchGridFx(await file.text(), factor);
    if (r.txt !== null) download(new Blob([r.txt], { type: "text/plain" }), "grid.fx");
    setShaderMsg(r.msg);
  };

  // ---- tree auto-fill (per current map, on demand, undoable) ----
  const colourWeightFn = () => {
    if (!colourImg) return null;
    const S = 512;
    return makeColourWeight(sampleImage(colourImg, S), S, mapSize);
  };

  // roads live in the paletted ground_type_map image (black pixels) — never plant on them.
  // Water = below the map's own water plane (raw height×scale + bias < 0), plus the
  // colour heuristics: blue-dominant ground-type pixels on low ground.
  // Returns the reason alongside so failures surface in the UI instead of vanishing.
  // roads + water live in the ground_type_map: dark ink = roads/rivers, bluish ink = water —
  // cross-checked against LOCAL heightmap depressions (carved beds), not any global level.
  // Placed buildings mask a 20 m clearing too. Returns the reason alongside so failures
  // surface in the UI instead of vanishing.
  const roadFromStore = async (st: FileStore, extent: number): Promise<{ road: ((wx: number, wz: number) => boolean) | null; note: string }> => {
    let depFn: ((wx: number, wz: number) => number) | null = null;
    const hk = [...st.keys()].find(p => /(^|\/)height_map_0\.dds$/i.test(p));
    if (hk) {
      const v = st.get(hk)!;
      try { depFn = makeDepressionSampler(readDDS(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)), extent); }
      catch { /* bad dds: depth checks stay off, road ink still masks */ }
    }
    const bpts: { x: number; z: number }[] = [];
    for (const [p, v] of st) {
      if (!/\.building_list$/i.test(p)) continue;
      try { bpts.push(...parseBuildingList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)).records); }
      catch { /* foreign file: no mask from it */ }
    }
    const bm = bpts.length ? makeBuildingMask(bpts) : null;
    // every returned mask also refuses the clearing around buildings
    const plus = (f: ((wx: number, wz: number) => boolean) | null) =>
      f && bm ? (wx: number, wz: number) => f(wx, wz) || bm(wx, wz) : f ?? bm;
    const df = depFn, wNote = (df ? "+local-depth" : "") + (bm ? "+bldg" : "");
    const key = [...st.keys()].find(p => GT_RE.test(p));
    if (!key) return df
      ? { road: plus((wx, wz) => df(wx, wz) > DEP_BARE), note: `depression mask ✓ (no ground_type_map)${bm ? "+bldg" : ""}` }
      : { road: plus(null), note: bm ? "building mask ✓ (no ground_type_map)" : "no ground_type_map" };
    if (/\.tga$/i.test(key)) {
      try {
        const t = readTGA(st.get(key)!);
        return { road: plus(makeRoadMask(t.data, t.w, t.h, extent, df)), note: `road+water ✓ ${t.w}×${t.h}${wNote}` };
      } catch (e) { return { road: plus(df && ((wx, wz) => df(wx, wz) > DEP_BARE)), note: `road mask FAILED: ${(e as Error).message}` }; }
    }
    const img = await new Promise<HTMLImageElement | null>(res => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => res(null);
      im.src = URL.createObjectURL(new Blob([st.get(key)!]));
    });
    if (!img) return { road: plus(df && ((wx, wz) => df(wx, wz) > DEP_BARE)), note: "road mask FAILED: image decode" };
    const S = img.width || 1024;   // native resolution: the road image's own pixels, no resample
    return { road: plus(makeRoadMask(sampleImage(img, S), S, S, extent, df)), note: `road+water ✓ ${S}×${S}${wNote}` };
  };

  const fillTrees = async () => {
    if (!trees) return;
    const total = trees.species.reduce((a, s) => a + s.trees.length, 0);
    if (!total) { setStatus("No existing trees to base fill on."); return; }
    const suggested = Math.round(total * (appliedF * appliedF - 1) * FILL_INTENSITY);
    const target = Math.min(parseInt(fillN) > 0 ? parseInt(fillN) : Math.max(suggested, 0), 45000 - total);
    if (target <= 0) { setStatus("Nothing to add (target 0)."); return; }
    const { road } = files ? await roadFromStore(files, mapSize) : { road: null };
    const { addedPer, added } = fillSpecies(trees.species, target, mapSize, fillAlgo, fillAlgo === "colour" ? colourWeightFn() : null, Math.random, road);
    undoRef.current.push({ type: "fill", addedPer });
    refreshCurThumb();
    setStatus(`Added ${added} trees (${fillAlgo}${added < target ? ", hit sampling limit" : ""}); undo removes them.`);
    rr();
  };

  const refreshCurThumb = async () => {
    if (curBundle === null || !bundles[curBundle] || !trees) return;
    const b = bundles[curBundle];
    const pts = trees.species.flatMap((s, si) => s.trees.map(tr => [tr.x, tr.z, si]));
    b.thumb = await makeThumb(b.colourBytes, pts, b.dep ? b.dep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance, z.o]) : null, b.extent);
    setBundles(bundles.slice());
  };

  // write the currently-viewed map's live edits back into its bundle
  const syncCurrent = () => {
    if (curBundle === null || !bundles[curBundle] || !files) return;
    syncStore(bundles[curBundle].store, xmlRef.current, trees, deploy, blds);
  };

  const bulkExport = async () => {
    if (!bundles.length) return;
    syncCurrent();
    const CHUNK = 20;   // ponytail: maps per zip; bounds blob memory for 250-map batches
    const parts = Math.ceil(bundles.length / CHUNK);
    // one folder dialog up front: later parts have no user gesture left to open
    // a save dialog with, so per-part pickers would die after the first zip
    const dir = await pickExportDir();
    if (dir === false) { setStatus("Bulk export cancelled."); return; }
    const used = new Set<string>();
    for (let pi = 0; pi < parts; pi++) {
      const slice = bundles.slice(pi * CHUNK, (pi + 1) * CHUNK);
      const outZip = new JSZip();
      for (const b of slice) {
        let root = b.root || b.name + "/";
        let base = root;
        for (let k = 2; used.has(root); k++) root = base.replace(/\/$/, "") + "_" + k + "/";
        used.add(root);
        for (const [p, v] of b.store) {
          const rel = b.root ? p.slice(b.root.length) : p;
          outZip.file(root + rel, v);
        }
      }
      let lastP = -1;
      const name = parts > 1
        ? `batch_enlarged_x${bundles[0].factor}_part${pi + 1}of${parts}.zip`
        : `batch_enlarged_x${bundles[0].factor}.zip`;
      const progress = (pct: number) => {
        const p = Math.floor(pct);
        if (p !== lastP) { lastP = p; setStatus(`Bulk export zip ${pi + 1}/${parts}: ${p}%`); }
      };
      try {
        if (dir) await saveZipInDir(dir, outZip, name, progress);
        else if (!await saveZip(outZip, name, progress)) { setStatus(`Bulk export cancelled at zip ${pi + 1}/${parts}.`); return; }
      } catch (e) {
        setStatus(`Export failed writing ${name}: ${(e as Error).message} — is the target drive full?`);
        return;
      }
      slice.forEach(b => { b.exported = true; });
      setBundles(bundles.slice());
    }
    setStatus(`Bulk export: ${bundles.length} maps in ${parts === 1 ? "one zip" : parts + " zips"} (includes any per-map edits).`);
  };

  const applyHeadroom = async (n: number) => {
    setHeadroom(n);
    if (!bundles.length || isNaN(n)) return;
    syncCurrent();                                   // keep any tree brushing
    const enc = new TextEncoder();
    for (const b of bundles) {
      if (!b.dep) continue;
      // non-null depPath: dep implies depPath
      autoShiftZones(b.dep.zones, b.extent, n);
      b.store.set(b.depPath!, enc.encode(serializeDeployment(b.dep)));
      b.exported = false;
    }
    if (curBundle !== null && bundles[curBundle]) {
      const b = bundles[curBundle];
      loadStore(b.store, b.root, b.name + " [" + (curBundle + 1) + "/" + bundles.length + "]", b.factor, b.dep);
      setScaleOpt(b.scaleSet || "");
    }
    setBundles(bundles.slice());
    setStatus(`Deployment headroom ${n} m: zones pushed back per map — grid + viewer updated.`);
    // regenerate thumbnails so the grid shows the new zone positions —
    // debounced: at 250 maps this is the expensive part of every keystroke
    clearTimeout(thumbTimer.current);
    thumbTimer.current = window.setTimeout(async () => {
      for (const b of bundles) {
        if (!b.dep) continue;
        let pts: number[][] | null = null;
        const tKey = [...b.store.keys()].find(p => p.endsWith("bmd.tree_list"));
        if (tKey && b.store.get(tKey)!.length > 40) {   // non-null: tKey came from store.keys()
          try {
            const v = b.store.get(tKey)!;
            const tp = parseTreeList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
            pts = tp.species.flatMap((s, si) => s.trees.map(tr => [tr.x, tr.z, si]));
          } catch (e) { /* keep old thumb trees */ }
        }
        b.thumb = await makeThumb(b.colourBytes, pts, b.dep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance, z.o]), b.extent);
      }
      setBundles(bundles.slice());
    }, 400);
  };

  const processBatch = async (fileList: File[], fac: 1.5 | 2 = factor) => {
    if (!fileList.length || batchBusy) return;
    srcFiles.current = fileList;
    setBatchBusy(true);
    const log: string[] = [];
    setBatchLog(log.slice());
    const newBundles: Bundle[] = [];
    for (const f of fileList) {
      try {
        const { store, defPath } = await loadZipStore(f);
        const r = enlargeStore(store, defPath, fac, headroom);
        // auto on import: xfactor height scale + one cluster fill pass, baked into the store
        const enc = new TextEncoder(), dec = new TextDecoder();
        let scaleSet: string | null = null, origBias: string | null = null, biasSet: string | null = null;
        if (r.origScale) scaleSet = (parseFloat(r.origScale) * fac).toFixed(6);
        for (const p of [...r.out.keys()]) {
          if (!/height_map_\d_settings\.xml$/.test(p)) continue;
          let x = dec.decode(r.out.get(p)!);
          if (scaleSet) x = setScale(x, scaleSet);
          const lod0 = /height_map_0_settings\.xml$/.test(p);
          if (lod0) origBias = /\bbias='([0-9.\-]+)'/.exec(x)?.[1] ?? null;
          x = shiftBias(x, fac);   // bias sinks with the enlargement: b - |b|*(f-1)
          if (lod0) biasSet = /\bbias='([0-9.\-]+)'/.exec(x)?.[1] ?? null;
          r.out.set(p, enc.encode(x));
        }
        let auto = 0, roadNote = "";
        const tKey = [...r.out.keys()].find(p => p.endsWith("bmd.tree_list"));
        if (fillN.trim() !== "0" && tKey && r.nTrees) {   // ponytail: fill box "0" = skip auto-fill
          const v = r.out.get(tKey)!;
          const tp = parseTreeList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
          const target = Math.min(Math.round(r.nTrees * (fac * fac - 1) * FILL_INTENSITY), 45000 - r.nTrees);
          if (target > 0) {
            const rd = await roadFromStore(r.out, r.extent);
            roadNote = rd.note;
            auto = fillSpecies(tp.species, target, r.extent, "cluster", null, Math.random, rd.road).added;
            r.out.set(tKey, buildTreeList(tp));
            r.nTrees += auto;
            r.treePts = tp.species.flatMap((s, si) => s.trees.map(tr => [tr.x, tr.z, si]));
          }
        }
        const thumb = await makeThumb(r.colourBytes, r.treePts, r.dep ? r.dep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance, z.o]) : null, r.extent);
        // original side panel: re-parse the untouched tree list so even culled oob trees show
        let origPts: number[][] | null = null;
        const oKey = [...store.keys()].find(p => p.endsWith("bmd.tree_list"));
        if (oKey && store.get(oKey)!.length > 40) {
          try {
            const ov = store.get(oKey)!;
            origPts = parseTreeList(ov.buffer.slice(ov.byteOffset, ov.byteOffset + ov.byteLength))
              .species.flatMap((s, si) => s.trees.map(tr => [tr.x, tr.z, si]));
          } catch (e) { /* panel just shows no trees */ }
        }
        const origThumb = await makeThumb(r.colourBytes, origPts,
          r.dep ? r.dep.zones.filter(z => z.block === 0).map(z => [z.x0 ?? z.x, z.y0 ?? z.y, z.w, z.h, z.alliance, z.o]) : null,
          r.extent / fac, 512);
        newBundles.push({
          name: f.name.replace(/\.zip$/i, ""), store: r.out, origThumb, root: r.root, factor: fac, exported: false,
          thumb, nTrees: r.nTrees, nZones: r.nZones, dep: r.dep, depPath: r.depPath,
          colourBytes: r.colourBytes, extent: r.extent, origScale: r.origScale, scaleSet, origBias, biasSet,
        });
        log.push(`✓ ${f.name}: ×${fac}, ${r.nTrees} trees (${auto} auto${r.cull ? `, ${r.cull} oob culled` : ""})${r.nBldg ? `, ${r.nBldg} bldg` : ""}, ${r.nZones} zones +${r.shift}m, ${r.scaleNote}${scaleSet ? "→" + scaleSet : ""}${roadNote ? ", " + roadNote : ""}`);
      } catch (e) {
        // cast: everything thrown here (JSZip failures, our own throws) is an Error
        log.push(`✗ ${f.name}: ${(e as Error).message}`);
      }
      setBatchLog(log.slice());
    }
    setBundles(newBundles);
    setBatchBusy(false);
    if (newBundles.length) {
      setCurBundle(0);
      loadStore(newBundles[0].store, newBundles[0].root, newBundles[0].name + " [1/" + newBundles.length + "]", fac, newBundles[0].dep);
      setScaleOpt(newBundles[0].scaleSet || "");
      setStatus(`Batch processed ${newBundles.length}/${fileList.length} maps — review each in the viewer, then Export map zip for the ones you approve.`);
    } else setStatus("Batch: no maps processed.");
  };

  // after import this re-runs the whole pipeline from the original zips at the
  // new factor (auto fill target + height scale follow it); per-map edits reset
  const switchFactor = (f: 1.5 | 2) => {
    if (f === factor || batchBusy) return;
    setFactor(f);
    if (srcFiles.current.length) processBatch(srcFiles.current, f);
  };

  const viewBundle = (i: number) => {
    syncCurrent();
    setCurBundle(i);
    const b = bundles[i];
    loadStore(b.store, b.root, b.name + " [" + (i + 1) + "/" + bundles.length + "]", b.factor, b.dep);
    setScaleOpt(b.scaleSet || "");
  };

  const doExport = async () => {
    if (!files) return;
    const zip = new JSZip();
    for (const [p, v] of exportEntries(files, xmlRef.current, trees, deploy, blds)) zip.file(p, v);
    const name = (mapName.replace(/ \[\d+\/\d+\]$/, "") || "map") + (enlarged ? "_" + mapSize : "") + ".zip";
    try { if (!await saveZip(zip, name)) return; }   // user cancelled
    catch (e) { setStatus(`Export failed: ${(e as Error).message}`); return; }
    if (curBundle !== null && bundles[curBundle]) {
      bundles[curBundle].exported = true;
      setBundles(bundles.slice());
    }
    setStatus("Exported. Size/link fields rewritten in edited binaries; everything else byte-identical passthrough.");
  };

  // ---------- canvas ----------
  const w2sc = (x: number, z: number, cw: number, ch: number) => w2s(view.current, x, z, cw, ch);
  const s2wc = (sx: number, sz: number, cw: number, ch: number) => s2w(view.current, sx, sz, cw, ch);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!; // canvas 2d context is always available
    const cw = cv.width, ch = cv.height;
    ctx.fillStyle = "#12160f"; ctx.fillRect(0, 0, cw, ch);
    if (mode3d && t3.current) {
      // 3D relief follows the map's live height scale (auto ×factor + the height scale box).
      // ponytail: 2 m per scale unit — THE knob if terrain reads too steep or too flat
      const p = Object.keys(xmlRef.current).find(k => /height_map_0_settings\.xml$/.test(k));
      const m = p ? /\bscale='([0-9.\-]+)'/.exec(xmlRef.current[p]) : null;
      render3d(ctx, cw, ch, t3.current, cam3.current, mapSize, m ? parseFloat(m[1]) * 2.3 : 30, layer.trees ? buckets3.current : null, SP_COLORS, layer.colour,
        layer.bldg ? bucketsB.current : null, bldgMeshes.current.list);
      return;
    }
    const half = mapSize / 2, ihalf = imgExtent / 2;

    // image row 0 = world +Z and the mirrored w2s puts +Z at the TOP of the screen,
    // so images now draw unflipped — matching the in-game orientation.
    // w2sc(-half,-half) is bottom-left on screen, w2sc(half,half) top-right.
    const drawMap = (img: CanvasImageSource, a: number, b: number, c: number, d: number) =>
      ctx.drawImage(img, a, d, c - a, b - d);
    {
      const [a, b] = w2sc(-half, -half, cw, ch), [c, d] = w2sc(half, half, cw, ch);
      if (layer.height && hmCanvas) { ctx.imageSmoothingEnabled = true; drawMap(hmCanvas, a, b, c, d); }
      else { ctx.fillStyle = "#222a1d"; ctx.fillRect(a, d, c - a, b - d); }
    }
    if (layer.colour && colourImg) {
      // with the grid.fx fix the colour/blend window spans the full terrain
      const [a, b] = w2sc(-half, -half, cw, ch), [c, d] = w2sc(half, half, cw, ch);
      ctx.globalAlpha = 0.9;
      drawMap(colourImg, a, b, c, d);
      ctx.globalAlpha = 1;
    }
    if (layer.alpha && alphaImg) {
      // road/alpha map overlay — what the auto-fill road mask sees
      const [a, b] = w2sc(-half, -half, cw, ch), [c, d] = w2sc(half, half, cw, ch);
      ctx.globalAlpha = 0.55;
      drawMap(alphaImg, a, b, c, d);
      ctx.globalAlpha = 1;
    }
    const box = (hx: number, color: string, dash: number[], label: string) => {
      const [a, b] = w2sc(-hx, -hx, cw, ch), [c, d] = w2sc(hx, hx, cw, ch);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
      ctx.strokeRect(a, d, c - a, b - d); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(label, a + 6, d + 14);
    };
    if (enlarged) box(ihalf, "#c9b45f", [6, 4], `original extent ±${ihalf}`);
    box(half, "#8a9a78", [], `terrain ±${half}`);

    if (layer.trees && trees) {
      const r = Math.max(1.1, view.current.zoom * 4);
      trees.species.forEach((s, si) => {
        ctx.fillStyle = SP_COLORS[si % SP_COLORS.length];
        for (const t of s.trees) {
          const [sx, sz] = w2sc(t.x, t.z, cw, ch);
          if (sx < -5 || sz < -5 || sx > cw + 5 || sz > ch + 5) continue;
          ctx.globalAlpha = t.isNew ? 1 : 0.7;
          ctx.beginPath(); ctx.arc(sx, sz, t.isNew ? r * 1.2 : r, 0, 6.283); ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
    }
    if (layer.bldg && blds.length) {
      // building markers colour-coded by category (far lists faded). Below ~5 px the
      // rotation is invisible, so draw plain rects — 1 canvas op instead of 6 for 10k+ lists
      const bh = Math.max(3, 9 * view.current.zoom);
      const rot = bh > 5;
      for (const bl of blds) {
        const far = /far/i.test(bl.path);
        let lastCat = -1;
        for (const bd of bl.records) {
          const [bsx, bsz] = w2sc(bd.x, bd.z, cw, ch);
          if (bsx < -20 || bsz < -20 || bsx > cw + 20 || bsz > ch + 20) continue;
          const c = bldgCat(bd.name);
          if (c !== lastCat) {   // records cluster by model, so style churn stays low
            lastCat = c;
            ctx.fillStyle = BLDG_CATS[c].col + (far ? "66" : "cc");
            if (rot) { ctx.strokeStyle = BLDG_CATS[c].col; ctx.lineWidth = 1; }
          }
          if (rot) {
            ctx.save();
            ctx.translate(bsx, bsz);
            ctx.rotate(bd.rot / 65536 * 6.283);   // CW-positive game yaw + mirrored screen y cancel out
            ctx.fillRect(-bh, -bh, bh * 2, bh * 2);
            ctx.strokeRect(-bh, -bh, bh * 2, bh * 2);
            ctx.restore();
          } else ctx.fillRect(bsx - bh, bsz - bh, bh * 2, bh * 2);
        }
      }
    }
    if (layer.deploy && deploy) {
      deploy.zones.forEach((z, zi) => {
        if (z.block !== blockIdx) return;
        const [sx, sz] = w2sc(z.x, z.y, cw, ch);
        const zw = z.w * view.current.zoom, zh = z.h * view.current.zoom;
        ctx.save();
        ctx.translate(sx, sz);
        ctx.rotate(-z.o);   // mirrored screen y: world angles render negated
        const col = z.alliance === 0 ? "#6d9ee0" : "#e07d6d";
        ctx.fillStyle = col; ctx.globalAlpha = zi === selZone ? 0.35 : 0.18;
        ctx.fillRect(-zw / 2, -zh / 2, zw, zh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col; ctx.lineWidth = zi === selZone ? 2.5 : 1.3;
        ctx.strokeRect(-zw / 2, -zh / 2, zw, zh);
        // facing arrow: the deployed army faces the zone's local +h direction —
        // on the mirrored screen (rotate(-o), y flipped) that is local −y here
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(0, -(zh / 2 + 14));
        ctx.moveTo(-5, -(zh / 2 + 8)); ctx.lineTo(0, -(zh / 2 + 14)); ctx.lineTo(5, -(zh / 2 + 8));
        ctx.stroke();
        if (zi === selZone && tool === "zones") {
          // corner resize handles + rotate knob (opposite side of the facing arrow)
          ctx.fillStyle = "#f0ecd8";
          for (const [hx, hy] of [[-zw / 2, -zh / 2], [zw / 2, -zh / 2], [zw / 2, zh / 2], [-zw / 2, zh / 2]])
            ctx.fillRect(hx - 4, hy - 4, 8, 8);
          ctx.strokeStyle = "#f0ecd8"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, zh / 2); ctx.lineTo(0, zh / 2 + ROT_KNOB); ctx.stroke();
          ctx.beginPath(); ctx.arc(0, zh / 2 + ROT_KNOB, 5, 0, 6.283); ctx.fill();
        }
        ctx.restore();
      });
    }
    if (layer.bldg && tool === "bldg" && cursor.current && blds.length) {
      // hover label: the raw model key of the nearest marker under the cursor
      const [hx2, hz2] = w2sc(cursor.current[0], cursor.current[1], cw, ch);
      let name: string | null = null, best = 16 * 16, lx2 = 0, lz2 = 0;
      for (const bl of blds) for (const bd of bl.records) {
        const [bsx, bsz] = w2sc(bd.x, bd.z, cw, ch);
        const dd = (bsx - hx2) * (bsx - hx2) + (bsz - hz2) * (bsz - hz2);
        if (dd < best) { best = dd; name = bd.name; lx2 = bsx; lz2 = bsz; }
      }
      if (name) {
        ctx.font = "11px ui-monospace, monospace";
        const tw2 = ctx.measureText(name).width;
        ctx.fillStyle = "#10140fd9";
        ctx.fillRect(lx2 + 10, lz2 - 21, tw2 + 10, 16);
        ctx.fillStyle = "#e8e3c9";
        ctx.fillText(name, lx2 + 15, lz2 - 9);
      }
    }
    if (cursor.current && tool !== "pan" && tool !== "bldg") {
      const [sx, sz] = w2sc(cursor.current[0], cursor.current[1], cw, ch);
      const rr2 = tool === "place" ? 8 : brushR * view.current.zoom;
      ctx.strokeStyle = tool === "erase" ? "#e06d6d" : "#e8e3c9";
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sx, sz, rr2, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [files, colourImg, alphaImg, hmCanvas, trees, blds, deploy, blockIdx, selZone, enlarged, mapSize, imgExtent, layer, tool, brushR, mode3d]);

  // losing the heightmap (bundle switch to a map without one) must drop back to 2D,
  // or the 2D scene renders while the input handlers still steer the invisible 3D camera
  useEffect(() => { if (!hmData) setMode3d(false); }, [hmData]);
  // 3D scene caches: terrain on data change; tree buckets every render (edits mutate species in place)
  useEffect(() => {
    // full-res drape: the colour image's own pixels (2048 cap bounds the texture at 16 MB)
    const S = colourImg ? Math.min(colourImg.naturalWidth || 512, 2048) : 256;
    t3.current = mode3d && hmData ? buildTerrain(hmData, colourImg ? sampleImage(colourImg, S) : null, S) : null;
  }, [mode3d, hmData, colourImg]);
  useEffect(() => {
    buckets3.current = mode3d && trees && t3.current ? bucketTrees(trees.species, mapSize, t3.current.G) : null;
    bucketsB.current = mode3d && blds.length && t3.current
      ? bucketBuildings(blds.map(bl => ({ records: bl.records, far: /far/i.test(bl.path) })), mapSize, t3.current.G,
        n => bldgMeshes.current.byName.get(n.toLowerCase()) ?? -1) : null;
  });
  useEffect(() => { draw(); });
  useEffect(() => {
    const cv = canvasRef.current!;   // non-null: canvas is always mounted with the component
    const ro = new ResizeObserver(() => {
      const r = cv.parentElement!.getBoundingClientRect();
      cv.width = r.width; cv.height = r.height; draw();
    });
    ro.observe(cv.parentElement!);   // non-null: canvas lives inside the viewer div
    return () => ro.disconnect();
  }, [draw]);

  const stamp = (wx: number, wz: number) => {
    addTreesAt(stampPoints(wx, wz, brushR, density, mapSize));
  };

  const onMouse = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!, rect = cv.getBoundingClientRect();   // non-null: handler fires on the mounted canvas
    const sx = e.clientX - rect.left, sz = e.clientY - rect.top;
    const [wx, wz] = s2wc(sx, sz, cv.width, cv.height);
    cursor.current = [wx, wz];
    if (mode3d && t3.current) {   // same gate as draw(): without terrain the canvas shows 2D
      // left drag = orbit (yaw/pitch); MIDDLE drag = pan the camera target across the map
      if (e.type === "mousedown") {
        if (e.button === 1) {
          e.preventDefault();   // stop the browser's middle-click autoscroll
          drag.current = { pan3: true, sx, sz, cx: cam3.current.cx ?? 0, cz: cam3.current.cz ?? 0 };
        } else drag.current = { panning: true, sx, sz, cx: cam3.current.yaw, cz: cam3.current.pitch };
      } else if (e.type === "mousemove" && drag.current?.pan3) {
        const c = cam3.current;
        const sc3 = Math.min(cv.width, cv.height) / (mapSize * 1.45) * c.zoom;
        const sp3 = Math.max(0.05, Math.sin(c.pitch)), cy3 = Math.cos(c.yaw), sy3 = Math.sin(c.yaw);
        const drx = (sx - drag.current.sx) / sc3, drz = (sz - drag.current.sz) / (sc3 * sp3);
        c.cx = drag.current.cx - (drx * cy3 + drz * sy3);   // terrain follows the cursor
        c.cz = drag.current.cz - (drx * sy3 - drz * cy3);
        if (!raf3.current) raf3.current = requestAnimationFrame(() => { raf3.current = 0; draw(); });
      } else if (e.type === "mousemove" && drag.current?.panning) {
        cam3.current.yaw = drag.current.cx + (sx - drag.current.sx) * 0.008;
        cam3.current.pitch = Math.min(1.5, Math.max(0.2, drag.current.cz + (sz - drag.current.sz) * 0.006));
        // mousemove can outpace the display; render at most once per frame
        if (!raf3.current) raf3.current = requestAnimationFrame(() => { raf3.current = 0; draw(); });
      } else if (e.type !== "mousemove") drag.current = null;
      return;
    }
    if (e.type === "mousedown") {
      if (e.button !== 0 || tool === "pan" || e.shiftKey) drag.current = { sx, sz, cx: view.current.cx, cz: view.current.cz, panning: true };
      else if (tool === "zones") {
        // resize/rotate handles of the selected zone take priority over body hits
        const zs = selZone !== null && deploy ? deploy.zones[selZone] : null;
        let handled = false;
        if (zs && zs.block === blockIdx) {
          const [zsx, zsz] = w2sc(zs.x, zs.y, cv.width, cv.height);
          const zw = zs.w * view.current.zoom, zh = zs.h * view.current.zoom;
          const local = (lx: number, lz: number): [number, number] =>   // matches the rotate(-o) mirrored draw
            [zsx + lx * Math.cos(zs.o) + lz * Math.sin(zs.o), zsz - lx * Math.sin(zs.o) + lz * Math.cos(zs.o)];
          const snap = () => undoRef.current.push({ type: "zone-move", zi: selZone!, x: zs.x, y: zs.y, w: zs.w, h: zs.h, o: zs.o, x0: zs.x0, y0: zs.y0 });
          const [kx, kz] = local(0, zh / 2 + ROT_KNOB);   // knob now opposite the facing arrow
          if (Math.hypot(sx - kx, sz - kz) <= 8) {
            snap(); drag.current = { zone: selZone!, mode: "rotate", ox: zs.x, oy: zs.y, wx0: wx, wz0: wz }; handled = true;
          } else for (const [clx, clz] of [[-zw / 2, -zh / 2], [zw / 2, -zh / 2], [zw / 2, zh / 2], [-zw / 2, zh / 2]]) {
            const [hx, hz] = local(clx, clz);
            if (Math.hypot(sx - hx, sz - hz) <= 7) {
              snap(); drag.current = { zone: selZone!, mode: "resize", ox: zs.x, oy: zs.y, wx0: wx, wz0: wz }; handled = true; break;
            }
          }
        }
        if (!handled) {
          const hit = deploy ? zoneAt(deploy.zones, blockIdx, wx, wz) : null;
          setSelZone(hit);
          if (hit !== null) {
            const z = deploy!.zones[hit];   // non-null: hit is only set while deploy exists
            drag.current = { zone: hit, ox: z.x, oy: z.y, wx0: wx, wz0: wz };
            undoRef.current.push({ type: "zone-move", zi: hit, x: z.x, y: z.y, w: z.w, h: z.h, o: z.o, x0: z.x0, y0: z.y0 });
          }
        }
      }
      else if (tool === "bldg" && layer.bldg) {   // never grab markers the layer is hiding
        // grab the nearest building marker within 14 px
        let best: [number, number] | null = null, bestD = 14 * 14;
        blds.forEach((bl, li) => bl.records.forEach((bd, ri) => {
          const [bx, bz] = w2sc(bd.x, bd.z, cv.width, cv.height);
          const dd = (bx - sx) * (bx - sx) + (bz - sz) * (bz - sz);
          if (dd < bestD) { bestD = dd; best = [li, ri]; }
        }));
        if (best) {
          const bd = blds[best[0]].records[best[1]];
          undoRef.current.push({ type: "bldg-move", li: best[0], ri: best[1], x: bd.x, z: bd.z });
          drag.current = { bldg: best, ox: bd.x, oy: bd.z, wx0: wx, wz0: wz };
          rr();   // refs alone don't re-render: surface the new undo entry immediately
        }
      }
      else {
        drag.current = { painting: true, last: [wx, wz] };
        if (tool === "place") addTreesAt([[wx, wz]]);
        else if (tool === "brush") stamp(wx, wz);
        else if (tool === "erase") eraseAt(wx, wz);
      }
    } else if (e.type === "mousemove") {
      if (drag.current?.panning) {
        view.current.cx = drag.current.cx - (sx - drag.current.sx) / view.current.zoom;
        view.current.cz = drag.current.cz + (sz - drag.current.sz) / view.current.zoom;   // mirrored screen y
      } else if (drag.current?.zone !== undefined) {
        const zi = drag.current.zone;
        const z = deploy!.zones[zi];   // non-null: zone drags only start when deploy exists
        const keep = { x: z.x, y: z.y, w: z.w, h: z.h, o: z.o, x0: z.x0, y0: z.y0 };
        const others = deploy!.zones.filter((oz, i) => i !== zi && oz.block === z.block);
        const before = others.map(oz => zonesOverlap(z, oz));   // pre-step overlap state
        if (drag.current.mode === "rotate") {
          const [zsx, zsz] = w2sc(z.x, z.y, cv.width, cv.height);
          z.o = Math.round((Math.PI / 2 - Math.atan2(sz - zsz, sx - zsx)) * 1000) / 1000;   // knob trails the facing (screen-local +y), mirrored screen
        } else if (drag.current.mode === "resize") {
          // pointer in the zone's rotated frame; centre stays put, w/h follow the corner
          const dx = wx - z.x, dz = wz - z.y;
          const rx = dx * Math.cos(-z.o) - dz * Math.sin(-z.o);
          const rz = dx * Math.sin(-z.o) + dz * Math.cos(-z.o);
          z.w = Math.max(10, Math.round(Math.abs(rx) * 20) / 10);
          z.h = Math.max(10, Math.round(Math.abs(rz) * 20) / 10);
        } else {
          z.x = Math.round((drag.current.ox + (wx - drag.current.wx0)) * 10) / 10;
          z.y = Math.round((drag.current.oy + (wz - drag.current.wz0)) * 10) / 10;
          // rebase so a later auto-shift recompute lands the zone back here
          if (z.y0 !== undefined) { z.x0 = z.x - (z.sdx ?? 0); z.y0 = z.y - (z.sdy ?? 0); }
        }
        // zones may not overlap ANY zone (own or enemy alliance) or leave the
        // playable area: stick at the last valid state. Pairs already
        // overlapping before the step (stacked preset areas) may keep separating.
        if (!zoneInBounds(z, mapSize / 2) || others.some((oz, i) => !before[i] && zonesOverlap(z, oz)))
          Object.assign(z, keep);
        deploy!.changed = true;
      } else if (drag.current?.bldg) {
        const bd = blds[drag.current.bldg[0]].records[drag.current.bldg[1]];
        bd.x = Math.round((drag.current.ox + (wx - drag.current.wx0)) * 10) / 10;
        bd.z = Math.round((drag.current.oy + (wz - drag.current.wz0)) * 10) / 10;
      } else if (drag.current?.painting) {
        const [lx, lz] = drag.current.last, d = Math.hypot(wx - lx, wz - lz);
        if (tool === "brush" && d > brushR * 0.6) { stamp(wx, wz); drag.current.last = [wx, wz]; }
        else if (tool === "erase" && d > brushR * 0.3) { eraseAt(wx, wz); drag.current.last = [wx, wz]; }
        else if (tool === "place" && entity.kind === "tree" && d > 12) { addTreesAt([[wx, wz]]); drag.current.last = [wx, wz]; }
      }
      draw();
    } else drag.current = null;
  };
  // native non-passive listener: React registers onWheel passively, so a
  // preventDefault() there is ignored and logs a console error
  useEffect(() => {
    const cv = canvasRef.current!;   // non-null: canvas is always mounted with the component
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (mode3d && t3.current) {   // same gate as draw()
        // anchor the zoom on the cursor's ground point, so zooming in walks you there
        const c = cam3.current, r3 = cv.getBoundingClientRect();
        const mx = e.clientX - r3.left - cv.width / 2, my = e.clientY - r3.top - cv.height / 2;
        const base = Math.min(cv.width, cv.height) / (mapSize * 1.45);
        const sp3 = Math.max(0.05, Math.sin(c.pitch)), cy3 = Math.cos(c.yaw), sy3 = Math.sin(c.yaw);
        const before = c.zoom;
        c.zoom = Math.min(400, Math.max(0.3, c.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));   // 400 ≈ standing on the ground
        const k = 1 / (base * before) - 1 / (base * c.zoom);
        const a = mx * k, b = (my / sp3) * k;
        c.cx = (c.cx ?? 0) + a * cy3 + b * sy3;
        c.cz = (c.cz ?? 0) + a * sy3 - b * cy3;
        if (!raf3.current) raf3.current = requestAnimationFrame(() => { raf3.current = 0; draw(); });
        return;
      }
      const rect = cv.getBoundingClientRect();
      const sx = e.clientX - rect.left, sz = e.clientY - rect.top;
      const [wx, wz] = s2wc(sx, sz, cv.width, cv.height);
      const v = view.current;
      v.zoom = Math.min(4, Math.max(0.02, v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      v.cx = wx - (sx - cv.width / 2) / v.zoom;
      v.cz = wz + (sz - cv.height / 2) / v.zoom;   // mirrored screen y
      draw();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [draw]);

  // ---------- UI ----------
  const S: Styles = {
    app: { display: "flex", height: "100vh", background: "#10140f", color: "#d9d4bd", fontFamily: "ui-monospace,'Cascadia Mono',Consolas,monospace", fontSize: 13 },
    side: { width: 292, padding: 14, borderRight: "1px solid #2b3226", overflowY: "auto", flexShrink: 0 },
    h: { fontSize: 15, letterSpacing: 1, color: "#e8e3c9", margin: "0 0 2px" },
    sub: { fontSize: 11, color: "#8a9179", margin: "0 0 12px" },
    lbl: { display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 1.2, color: "#8a9179", margin: "13px 0 5px" },
    row: { display: "flex", gap: 6, alignItems: "center", marginBottom: 4 },
    btn: (on: boolean) => ({ flex: 1, padding: "6px 4px", background: on ? "#4a5a3a" : "#1c2318", border: `1px solid ${on ? "#7a8a5a" : "#3a4433"}`, color: on ? "#f0ecd8" : "#b9b39a", borderRadius: 3, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }),
    act: (en: boolean) => ({ width: "100%", padding: "9px", background: en ? "#5a4a1e" : "#242a1e", border: `1px solid ${en ? "#a08a3a" : "#3a4433"}`, color: en ? "#f0e8c0" : "#6a715c", borderRadius: 3, cursor: en ? "pointer" : "default", fontFamily: "inherit", fontSize: 13, marginTop: 6 }),
    ent: (on: boolean) => ({ display: "flex", alignItems: "center", gap: 6, padding: "4px 7px", marginBottom: 2, background: on ? "#2a3323" : "transparent", border: `1px solid ${on ? "#5a6a44" : "transparent"}`, borderRadius: 3, cursor: "pointer", fontSize: 11 }),
    num: { width: 64, background: "#1c2318", border: "1px solid #3a4433", color: "#d9d4bd", padding: "3px 6px", borderRadius: 3, fontFamily: "inherit" },
    status: { position: "absolute", left: 306, bottom: 10, right: 12, fontSize: 13, color: "#9aa287", background: "#141a10cc", padding: "10px 14px", borderRadius: 4, pointerEvents: "none" },
  };

  return (
    <div style={S.app}>
      {batchBusy && (
        <div style={{ position: "fixed", inset: 0, background: "#000a", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#151a11", border: "1px solid #5a6a44", borderRadius: 6, padding: 18, width: 440, maxHeight: "70vh", overflowY: "auto", fontSize: 12 }}>
            <div style={{ color: "#e8e3c9", marginBottom: 10 }}>Processing maps… ({batchLog.length} done)</div>
            {batchLog.map((l, i) => <div key={i} style={{ color: l.startsWith("✓") ? "#9ab87a" : "#d08a7a", marginBottom: 2 }}>{l}</div>)}
          </div>
        </div>
      )}
      <div style={S.side}>
        <h1 style={S.h}>NTW MAP ENLARGER</h1>
        <p style={S.sub}>{mapName || "custom battle-map toolkit"}</p>

        <label style={S.lbl}>Terrain factor</label>
        <div style={S.row}>
          <button style={S.btn(factor === 1.5)} onClick={() => switchFactor(1.5)}>×1.5 → {Math.round(baseSize * 1.5)}</button>
          <button style={S.btn(factor === 2)} onClick={() => switchFactor(2)}>×2 → {baseSize * 2}</button>
        </div>
        <p style={{ fontSize: 10, color: "#6d755f", margin: "2px 0 0", lineHeight: 1.4 }}>
          tree coordinates spread automatically with the terrain. Switching after
          import re-processes every map from its original zip (edits reset).
        </p>

        <label style={S.lbl}>Batch process (multi-zip)</label>
          {/* non-null files: a file input's change event always carries a FileList */}
          <input type="file" accept=".zip" multiple style={{ fontSize: 11, width: "100%", color: "#b9b39a" }}
            disabled={batchBusy}
            onChange={e => e.target.files!.length && processBatch([...e.target.files!])} />
          <div style={S.row}>
            <span style={{ fontSize: 11, width: 108 }}>edge headroom (m)</span>
            <input style={S.num} type="number" value={headroom} onChange={e => applyHeadroom(+e.target.value)} />
          </div>
          <div style={S.row}>
            <span style={{ fontSize: 11, width: 108 }}>height scale</span>
            <input style={S.num} placeholder="keep" value={scaleOpt} onChange={e => applyScale(e.target.value)} />
            <span style={{ fontSize: 10, color: "#8a9179" }}>
              orig {curBundle !== null && bundles[curBundle] && bundles[curBundle].origScale ? bundles[curBundle].origScale : "—"}
            </span>
          </div>
          {curBundle !== null && bundles[curBundle]?.origBias && (
            <p style={{ fontSize: 10, color: "#8a9179", margin: "1px 0 0" }}>
              bias {+bundles[curBundle].origBias!} → {+bundles[curBundle].biasSet!}
            </p>
          )}
          {(() => {
            const orig = curBundle !== null && bundles[curBundle] ? bundles[curBundle].origScale : null;
            if (!orig) return null;
            return (
              <div style={S.row}>
                {[2, 3, 4, 5].map(m => {
                  const v = (parseFloat(orig) * m).toFixed(6);
                  return <button key={m} style={S.btn(scaleOpt === v)} onClick={() => applyScale(v)}>×{m}</button>;
                })}
              </div>
            );
          })()}
          <label style={S.lbl}>Tree auto-fill (current map)</label>
          <div style={S.row}>
            {(["cluster", "colour", "uniform", "spaced"] as const).map(a => (
              <button key={a} style={S.btn(fillAlgo === a)} onClick={() => setFillAlgo(a)}>{a}</button>
            ))}
          </div>
          <div style={S.row}>
            <input style={{ ...S.num, width: 76 }} type="number" placeholder={trees ? String(Math.round(trees.species.reduce((x, s) => x + s.trees.length, 0) * (appliedF * appliedF - 1) * FILL_INTENSITY)) : "n"} value={fillN} onChange={e => setFillN(e.target.value)} />
            <button style={{ ...S.btn(false), flex: 1 }} onClick={fillTrees} disabled={!trees}>add trees</button>
          </div>
          <p style={{ fontSize: 10, color: "#6d755f", lineHeight: 1.4, margin: "2px 0 0" }}>
            cluster = grow existing forests · colour = forest-coloured ground ·
            uniform = scatter · spaced = even blue-noise. Blank = restore original
            density. Undoable, per map. Import auto-runs one cluster pass and
            ×factor height scale on every map; set 0 here before importing to
            skip the auto-fill.
          </p>

          <p style={{ fontSize: 10, color: "#6d755f", lineHeight: 1.4, margin: "2px 0 0" }}>
            height scale multiplies each map's own original value. Deployment
            zones are pushed toward the map edge per map, stopping headroom
            metres short so they never touch the boundary.
          </p>
          {/* while busy the log lives in the modal; this stays as the all-failed fallback */}
          {batchLog.length > 0 && bundles.length === 0 && !batchBusy && (
            <div style={{ fontSize: 10, background: "#151a11", padding: 6, borderRadius: 3, marginTop: 4, maxHeight: 120, overflowY: "auto" }}>
              {batchLog.map((l, i) => <div key={i} style={{ color: l.startsWith("✓") ? "#9ab87a" : "#d08a7a" }}>{l}</div>)}
            </div>
          )}
          {bundles.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={S.row}>
                <button style={S.btn(false)} onClick={bulkExport}>export ALL</button>
              </div>
              <button style={S.act(curBundle !== null)} disabled={curBundle === null} onClick={doExport}>Export current map zip</button>
            </div>
          )}

        <label style={S.lbl}>Layers</label>
        {(["colour", "alpha", "height", "trees", "bldg", "deploy"] as const).map(k => (
          <div key={k} style={S.row}>
            <input type="checkbox" id={k} checked={layer[k]} onChange={e => setLayer({ ...layer, [k]: e.target.checked })} />
            <label htmlFor={k} style={{ fontSize: 11 }}>{{ colour: "colour map (stretched)", alpha: "ground type map (roads)", height: "heightmap (stretched)", trees: "trees", bldg: "buildings", deploy: "deployment zones" }[k]}</label>
          </div>
        ))}
        {deploy && (() => {
          const labels = Array.from({ length: deploy.nBlocks }, (_, i) => {
            const a = deploy.zones.filter(z => z.block === i && z.alliance === 0).length;
            const b = deploy.zones.filter(z => z.block === i && z.alliance === 1).length;
            return `${i + 1}: ${a}v${b}`;
          });
          return (
            <div style={S.row}>
              <select value={blockIdx} onChange={e => { setBlockIdx(+e.target.value); setSelZone(null); }}
                style={{ ...S.num, flex: 1, width: "auto" }}>
                {labels.map((l, i) => <option key={i} value={i}>{l}</option>)}
              </select>
              <button style={S.btn(false)} onClick={() => { setBlockIdx((blockIdx + deploy.nBlocks - 1) % deploy.nBlocks); setSelZone(null); }}>◀</button>
              <button style={S.btn(false)} onClick={() => { setBlockIdx((blockIdx + 1) % deploy.nBlocks); setSelZone(null); }}>▶</button>
            </div>
          );
        })()}

        <label style={S.lbl}>Tool</label>
        <div style={S.row}>
          <button style={S.btn(tool === "pan")} onClick={() => setTool("pan")}>pan</button>
          <button style={S.btn(tool === "place")} onClick={() => setTool("place")}>place</button>
        </div>
        <div style={S.row}>
          <button style={S.btn(tool === "brush")} onClick={() => setTool("brush")}>brush</button>
          <button style={S.btn(tool === "erase")} onClick={() => setTool("erase")}>erase</button>
        </div>
        <div style={S.row}>
          <button style={S.btn(tool === "zones")} onClick={() => setTool("zones")}>zones (drag to move)</button>
        </div>
        <div style={S.row}>
          <button style={S.btn(tool === "bldg")} onClick={() => setTool("bldg")} disabled={!blds.length}>
            buildings (drag to move{blds.length ? ` · ${blds.reduce((a, b) => a + b.records.length, 0)}` : ""})
          </button>
        </div>
        {blds.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", fontSize: 10, color: "#8a9179", margin: "3px 0 0" }}>
            {BLDG_CATS.map(c => (
              <span key={c.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 8, height: 8, background: c.col, borderRadius: 2 }} />{c.name}
              </span>
            ))}
          </div>
        )}
        <label style={S.lbl}>Building models — 3D view ({meshCount ? `${meshCount} loaded` : "optional"})</label>
        {/* non-null files: a file input's change event always carries a FileList */}
        <input type="file" accept=".zip,.rigid_model" multiple style={{ fontSize: 11, width: "100%", color: "#b9b39a" }}
          onChange={e => e.target.files!.length && importModels([...e.target.files!])} />
        <p style={{ fontSize: 10, color: "#6d755f", lineHeight: 1.4, margin: "2px 0 0" }}>
          import a rigidmodels zip (or loose .rigid_model files) and the 3D view
          swaps building blocks for the real low-LOD meshes when zoomed in.
        </p>
        <label style={S.lbl}>Brush {brushR} m · density {density}</label>
        <input type="range" min={15} max={300} value={brushR} onChange={e => setBrushR(+e.target.value)} style={{ width: "100%" }} />
        <input type="range" min={1} max={25} value={density} onChange={e => setDensity(+e.target.value)} style={{ width: "100%" }} />

        <label style={S.lbl}>Tree species</label>
        {trees && trees.species.map((s, i) => (
          <div key={"t" + i} style={S.ent(entity.kind === "tree" && entity.idx === i)} onClick={() => setEntity({ kind: "tree", idx: i })}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: SP_COLORS[i % SP_COLORS.length] }} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
            <span style={{ color: "#8a9179" }}>{s.trees.length}</span>
          </div>
        ))}
        <div style={S.row}>
          <button style={{ ...S.btn(false), marginTop: 8 }} onClick={undo}>undo ({undoRef.current.length})</button>
        </div>

        {deploy && selZone !== null && deploy.zones[selZone] && (() => { const z = deploy.zones[selZone]; return (
          <div style={{ fontSize: 11, background: "#1a2016", padding: 7, borderRadius: 3, marginBottom: 4 }}>
            <div style={{ color: z.alliance === 0 ? "#6d9ee0" : "#e07d6d", marginBottom: 4 }}>alliance {z.alliance} zone</div>
            <div>x {z.x} · y {z.y}</div>
            <div>{z.w} × {z.h} m · {(z.o * 180 / Math.PI).toFixed(1)}°</div>
            <div style={{ color: "#6d755f", marginTop: 3 }}>drag = move · corner = resize · knob = rotate</div>
          </div>
        ); })()}

        <label style={S.lbl}>Shader fix — grid.fx (once per install)</label>
        {/* non-null files: a file input's change event always carries a FileList */}
        <input type="file" accept=".fx" style={{ fontSize: 11, width: "100%", color: "#b9b39a" }}
          onChange={e => e.target.files![0] && onGridFx(e.target.files![0])} />
        {shaderMsg && <p style={{ fontSize: 10, color: "#c9b45f", lineHeight: 1.5, margin: "5px 0 0" }}>{shaderMsg}</p>}
        <p style={{ fontSize: 10, color: "#6d755f", lineHeight: 1.5, margin: "4px 0 0" }}>
          patches the UV divisor to ×{factor} — must match the terrain factor of
          the maps you play. Install via PFM + delete shader cache.
        </p>

        <p style={{ fontSize: 10, color: "#6d755f", marginTop: 12, lineHeight: 1.5 }}>
          wheel zoom · shift/right-drag pan while using tools.
          Heightmap pixels are never modified — the engine stretches them via
          world_width. With the shader fix installed, colour + blend maps stretch
          across the full terrain.
        </p>
      </div>

      {curBundle !== null && bundles[curBundle] && (
        <div style={{ width: 440, borderRight: "1px solid #2b3226", padding: 10, flexShrink: 0, overflowY: "auto" }}>
          <label style={S.lbl}>Original — {Math.round(bundles[curBundle].extent / bundles[curBundle].factor)} m</label>
          <img src={bundles[curBundle].origThumb} style={{ width: "100%", borderRadius: 3 }} alt="original map" />
          <p style={{ fontSize: 10, color: "#6d755f", lineHeight: 1.4 }}>
            untouched import: original size, all original tree positions,
            deployment zones. The viewer on the right is the enlarged result.
          </p>
          <label style={S.lbl}>Files — {bundles[curBundle].store.size}</label>
          {[...bundles[curBundle].store.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, v]) => (
            <div key={p} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "2px 0", borderBottom: "1px solid #1c2318", color: "#b9b39a" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bundles[curBundle].root ? p.slice(bundles[curBundle].root.length) : p}</span>
              <span style={{ color: "#6d755f", flexShrink: 0, marginLeft: 8 }}>{v.length >= 1048576 ? (v.length / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(v.length / 1024)) + " KB"}</span>
            </div>
          ))}
        </div>
      )}
      {/* minWidth 0: without it the canvas's pixel width blocks this pane from
          shrinking, pushing the grid panel past the viewport */}
      <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ display: "block", cursor: mode3d || tool === "pan" ? "grab" : "crosshair" }}
          onMouseDown={onMouse} onMouseMove={onMouse} onMouseUp={onMouse} onMouseLeave={onMouse}
          onContextMenu={e => e.preventDefault()} />
        <div style={{ position: "absolute", top: 10, right: 12, display: "flex", gap: 6, alignItems: "center" }}>
          <button style={{ ...S.btn(!mode3d), flex: "none", padding: "6px 14px" }} onClick={() => setMode3d(false)}>2D</button>
          <button style={{ ...S.btn(mode3d), flex: "none", padding: "6px 14px" }} disabled={!hmData} title={hmData ? "" : "needs a readable heightmap"}
            onClick={() => { setMode3d(true); setStatus("3D terrain: drag = orbit · middle-drag = pan · wheel = zoom to cursor (down to ground level). Relief follows the height scale; editing tools stay in 2D."); }}>3D</button>
        </div>
        <div style={S.status}>{status}</div>
      </div>
      {bundles.length > 0 && (
        <div style={{ width: 232, borderLeft: "1px solid #2b3226", overflowY: "auto", padding: 10, flexShrink: 0 }}>
          {bundles.map((b, i) => (
            <div key={i} onClick={() => viewBundle(i)}
              style={{ cursor: "pointer", border: `1px solid ${curBundle === i ? "#a08a3a" : "#3a4433"}`, borderRadius: 4, background: "#151a11", padding: 5, marginBottom: 10 }}>
              {b.thumb ? <img src={b.thumb} width={200} height={200} style={{ display: "block", borderRadius: 2 }} alt="" />
                : <div style={{ width: 200, height: 200, background: "#1a2016" }} />}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4, color: "#d9d4bd" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>{b.name}</span>
                <span style={{ color: b.exported ? "#9ab87a" : "#8a9179" }}>{b.exported ? "exported" : b.nTrees + "t"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
