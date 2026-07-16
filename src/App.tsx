import { useState, useRef, useEffect, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import JSZip from "jszip";
import type {
  LoadedTreeList, LoadedDeployment, FileStore, Bundle, UndoAction, Tool, FillAlgo,
  LayerState, Entity, View, DragState, Styles,
} from "./types";
import { parseTreeList, buildTreeList } from "./lib/treeList";
import { readDDS } from "./lib/dds";
import { parseDeployment, serializeDeployment, autoShiftZones, zonesOverlap, zoneInBounds } from "./lib/deployment";
import { setScale, baseTerrainWidth, patchGridFx } from "./lib/xml";
import { w2s, s2w, addTrees, eraseTrees, stampPoints, zoneAt, applyUndo, makeColourWeight, fillSpecies } from "./lib/edit";
import { findFile, loadZipStore, enlargeStore, syncStore, exportEntries } from "./lib/store";
import { heightToCanvas, sampleImage, makeThumb, download, saveZip, saveZipInDir, pickExportDir } from "./lib/canvas";

// =====================================================================
// NTW CUSTOM MAP ENLARGER
// Import a map folder zip -> view colour map + heightmap (both stretched,
// matching grid.fx-fixed engine) -> 2x enlarge (XML LOD chain, optional scale)
// -> edit trees & buildings -> export zip.
// Binary codecs (src/lib) ported from byte-identical-verified Python (43
// tree lists, 83 building lists round-tripped).
// =====================================================================

const SP_COLORS = ["#7ec97e", "#5fb8b8", "#c9b45f", "#b88add", "#e08b6d", "#8fa9e0", "#d97fa6", "#a3c95f"];
const ROT_KNOB = 22;   // px from the zone's top edge to the rotate knob

export default function MapEnlarger() {
  const [files, setFiles] = useState<FileStore | null>(null);
  const [mapName, setMapName] = useState("");
  const [colourImg, setColourImg] = useState<HTMLImageElement | null>(null);
  const [hmCanvas, setHmCanvas] = useState<HTMLCanvasElement | null>(null);
  const [trees, setTrees] = useState<LoadedTreeList | null>(null);
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
  const [layer, setLayer] = useState<LayerState>({ colour: true, height: true, trees: true, deploy: true });
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
  const drag = useRef<DragState | null>(null);
  const cursor = useRef<[number, number] | null>(null);
  const undoRef = useRef<UndoAction[]>([]);
  const xmlRef = useRef<Record<string, string>>({});

  const mapSize = enlarged ? Math.round(baseSize * appliedF) : baseSize;
  const imgExtent = baseSize;

  const loadStore = (store: FileStore, root: string, displayName: string, processedFactor: number, depOverride: LoadedDeployment | null) => {
    const get = (n: string) => findFile(store, root, n);

    const def = get("definition.xml");
    if (!def) throw new Error("no definition.xml in zip");
    const defTxt = new TextDecoder().decode(def.v);
    const raw = Math.round(baseTerrainWidth(defTxt));
    const bs = processedFactor ? Math.round(raw / processedFactor) : raw;
    setBaseSize(bs);
    setMapName(displayName);
    xmlRef.current = { [def.p]: defTxt };
    for (let i = 0; i < 4; i++) {
      const s = get(`height_map_${i}_settings.xml`);
      if (s) xmlRef.current[s.p] = new TextDecoder().decode(s.v);
    }

    let ci: { p: string; v: Uint8Array<ArrayBuffer> } | null = null;
    for (const n of ["colour_map_0.JPG", "colour_map_0.jpg", "colour_map_0.png"]) { ci = get(n); if (ci) break; }
    if (ci) {
      const im = new Image();
      im.onload = () => { setColourImg(im); rr(); };
      im.src = URL.createObjectURL(new Blob([ci.v]));
    } else setColourImg(null);

    let hm = get("height_map_0.dds");
    if (hm) setHmCanvas(heightToCanvas(readDDS(hm.v.buffer.slice(hm.v.byteOffset, hm.v.byteOffset + hm.v.byteLength))));
    else {
      hm = get("height_map_0.png");
      if (hm) {
        const im = new Image();
        im.onload = () => {
          const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
          const cx = cv.getContext("2d")!; // fresh canvas: 2d context is always available
          cx.filter = "grayscale(1)"; cx.drawImage(im, 0, 0);
          setHmCanvas(cv); rr();
        };
        im.src = URL.createObjectURL(new Blob([hm.v]));
      } else setHmCanvas(null);
    }

    const tl = get("bmd.tree_list");
    setTrees(tl && tl.v.length > 40 ? { ...parseTreeList(tl.v.buffer.slice(tl.v.byteOffset, tl.v.byteOffset + tl.v.byteLength)), path: tl.p } : null);
    const dpf = get("deployment_areas.xml");
    if (depOverride) setDeploy(depOverride);
    else if (dpf) {
      try { setDeploy({ ...parseDeployment(new TextDecoder().decode(dpf.v)), path: dpf.p }); }
      catch (e) { console.warn("deploy:", e); setDeploy(null); }
    } else setDeploy(null);
    setBlockIdx(0); setSelZone(null);

    setFiles(store);
    setEnlarged(!!processedFactor);
    setAppliedF(processedFactor || 1);
    undoRef.current = [];
    setStatus(`Loaded ${store.size} files, base terrain ${bs} m. ${tl ? "trees ✓" : "no trees"}${dpf ? ", deployment ✓" : ""}.`);
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
    applyUndo(a, trees, deploy);
    if (a.type === "fill") refreshCurThumb();
    rr();
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

  const fillTrees = () => {
    if (!trees) return;
    const total = trees.species.reduce((a, s) => a + s.trees.length, 0);
    if (!total) { setStatus("No existing trees to base fill on."); return; }
    const suggested = Math.round(total * (appliedF * appliedF - 1));
    const target = Math.min(parseInt(fillN) > 0 ? parseInt(fillN) : Math.max(suggested, 0), 45000 - total);
    if (target <= 0) { setStatus("Nothing to add (target 0)."); return; }
    const { addedPer, added } = fillSpecies(trees.species, target, mapSize, fillAlgo, fillAlgo === "colour" ? colourWeightFn() : null);
    undoRef.current.push({ type: "fill", addedPer });
    refreshCurThumb();
    setStatus(`Added ${added} trees (${fillAlgo}${added < target ? ", hit sampling limit" : ""}); undo removes them.`);
    rr();
  };

  const refreshCurThumb = async () => {
    if (curBundle === null || !bundles[curBundle] || !trees) return;
    const b = bundles[curBundle];
    const pts = trees.species.flatMap(s => s.trees.map(tr => [tr.x, tr.z]));
    b.thumb = await makeThumb(b.colourBytes, pts, b.dep ? b.dep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance]) : null, b.extent);
    setBundles(bundles.slice());
  };

  // write the currently-viewed map's live edits back into its bundle
  const syncCurrent = () => {
    if (curBundle === null || !bundles[curBundle] || !files) return;
    syncStore(bundles[curBundle].store, xmlRef.current, trees, deploy);
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
            pts = tp.species.flatMap(s => s.trees.map(tr => [tr.x, tr.z]));
          } catch (e) { /* keep old thumb trees */ }
        }
        b.thumb = await makeThumb(b.colourBytes, pts, b.dep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance]), b.extent);
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
        let scaleSet: string | null = null;
        if (r.origScale) {
          scaleSet = (parseFloat(r.origScale) * fac).toFixed(6);
          for (const p of [...r.out.keys()]) {
            if (/height_map_\d_settings\.xml$/.test(p)) r.out.set(p, enc.encode(setScale(dec.decode(r.out.get(p)!), scaleSet)));
          }
        }
        let auto = 0;
        const tKey = [...r.out.keys()].find(p => p.endsWith("bmd.tree_list"));
        if (fillN.trim() !== "0" && tKey && r.nTrees) {   // ponytail: fill box "0" = skip auto-fill
          const v = r.out.get(tKey)!;
          const tp = parseTreeList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
          const target = Math.min(Math.round(r.nTrees * (fac * fac - 1)), 45000 - r.nTrees);
          if (target > 0) {
            auto = fillSpecies(tp.species, target, r.extent, "cluster", null).added;
            r.out.set(tKey, buildTreeList(tp));
            r.nTrees += auto;
            r.treePts = tp.species.flatMap(s => s.trees.map(tr => [tr.x, tr.z]));
          }
        }
        const thumb = await makeThumb(r.colourBytes, r.treePts, r.dep ? r.dep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance]) : null, r.extent);
        newBundles.push({
          name: f.name.replace(/\.zip$/i, ""), store: r.out, root: r.root, factor: fac, exported: false,
          thumb, nTrees: r.nTrees, nZones: r.nZones, dep: r.dep, depPath: r.depPath,
          colourBytes: r.colourBytes, extent: r.extent, origScale: r.origScale, scaleSet,
        });
        log.push(`✓ ${f.name}: ×${fac}, ${r.nTrees} trees (${auto} auto), ${r.nZones} zones +${r.shift}m, ${r.scaleNote}${scaleSet ? "→" + scaleSet : ""}`);
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
    for (const [p, v] of exportEntries(files, xmlRef.current, trees, deploy)) zip.file(p, v);
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
    const half = mapSize / 2, ihalf = imgExtent / 2;

    // image row 0 = world +Z (verified: existing trees land on forest pixels
    // only with a vertical flip), so both image layers draw V-flipped.
    const drawFlipped = (img: CanvasImageSource, a: number, b: number, c: number, d: number) => {
      ctx.save();
      ctx.translate(0, d);
      ctx.scale(1, -1);
      ctx.drawImage(img, a, 0, c - a, d - b);
      ctx.restore();
    };
    {
      const [a, b] = w2sc(-half, -half, cw, ch), [c, d] = w2sc(half, half, cw, ch);
      if (layer.height && hmCanvas) { ctx.imageSmoothingEnabled = true; drawFlipped(hmCanvas, a, b, c, d); }
      else { ctx.fillStyle = "#222a1d"; ctx.fillRect(a, b, c - a, d - b); }
    }
    if (layer.colour && colourImg) {
      // with the grid.fx fix the colour/blend window spans the full terrain
      const [a, b] = w2sc(-half, -half, cw, ch), [c, d] = w2sc(half, half, cw, ch);
      ctx.globalAlpha = 0.9;
      drawFlipped(colourImg, a, b, c, d);
      ctx.globalAlpha = 1;
    }
    const box = (hx: number, color: string, dash: number[], label: string) => {
      const [a, b] = w2sc(-hx, -hx, cw, ch), [c, d] = w2sc(hx, hx, cw, ch);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
      ctx.strokeRect(a, b, c - a, d - b); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(label, a + 6, b + 14);
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
    if (layer.deploy && deploy) {
      deploy.zones.forEach((z, zi) => {
        if (z.block !== blockIdx) return;
        const [sx, sz] = w2sc(z.x, z.y, cw, ch);
        const zw = z.w * view.current.zoom, zh = z.h * view.current.zoom;
        ctx.save();
        ctx.translate(sx, sz);
        ctx.rotate(z.o);
        const col = z.alliance === 0 ? "#6d9ee0" : "#e07d6d";
        ctx.fillStyle = col; ctx.globalAlpha = zi === selZone ? 0.35 : 0.18;
        ctx.fillRect(-zw / 2, -zh / 2, zw, zh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col; ctx.lineWidth = zi === selZone ? 2.5 : 1.3;
        ctx.strokeRect(-zw / 2, -zh / 2, zw, zh);
        if (zi === selZone && tool === "zones") {
          // corner resize handles + rotate knob, drawn in the zone's rotated frame
          ctx.fillStyle = "#f0ecd8";
          for (const [hx, hy] of [[-zw / 2, -zh / 2], [zw / 2, -zh / 2], [zw / 2, zh / 2], [-zw / 2, zh / 2]])
            ctx.fillRect(hx - 4, hy - 4, 8, 8);
          ctx.strokeStyle = "#f0ecd8"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, -zh / 2); ctx.lineTo(0, -zh / 2 - ROT_KNOB); ctx.stroke();
          ctx.beginPath(); ctx.arc(0, -zh / 2 - ROT_KNOB, 5, 0, 6.283); ctx.fill();
        }
        ctx.restore();
      });
    }
    if (cursor.current && tool !== "pan") {
      const [sx, sz] = w2sc(cursor.current[0], cursor.current[1], cw, ch);
      const rr2 = tool === "place" ? 8 : brushR * view.current.zoom;
      ctx.strokeStyle = tool === "erase" ? "#e06d6d" : "#e8e3c9";
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sx, sz, rr2, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [files, colourImg, hmCanvas, trees, deploy, blockIdx, selZone, enlarged, mapSize, imgExtent, layer, tool, brushR]);

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
    if (e.type === "mousedown") {
      if (e.button !== 0 || tool === "pan" || e.shiftKey) drag.current = { sx, sz, cx: view.current.cx, cz: view.current.cz, panning: true };
      else if (tool === "zones") {
        // resize/rotate handles of the selected zone take priority over body hits
        const zs = selZone !== null && deploy ? deploy.zones[selZone] : null;
        let handled = false;
        if (zs && zs.block === blockIdx) {
          const [zsx, zsz] = w2sc(zs.x, zs.y, cv.width, cv.height);
          const zw = zs.w * view.current.zoom, zh = zs.h * view.current.zoom;
          const local = (lx: number, lz: number): [number, number] =>
            [zsx + lx * Math.cos(zs.o) - lz * Math.sin(zs.o), zsz + lx * Math.sin(zs.o) + lz * Math.cos(zs.o)];
          const snap = () => undoRef.current.push({ type: "zone-move", zi: selZone!, x: zs.x, y: zs.y, w: zs.w, h: zs.h, o: zs.o, x0: zs.x0, y0: zs.y0 });
          const [kx, kz] = local(0, -zh / 2 - ROT_KNOB);
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
      else {
        drag.current = { painting: true, last: [wx, wz] };
        if (tool === "place") addTreesAt([[wx, wz]]);
        else if (tool === "brush") stamp(wx, wz);
        else if (tool === "erase") eraseAt(wx, wz);
      }
    } else if (e.type === "mousemove") {
      if (drag.current?.panning) {
        view.current.cx = drag.current.cx - (sx - drag.current.sx) / view.current.zoom;
        view.current.cz = drag.current.cz - (sz - drag.current.sz) / view.current.zoom;
      } else if (drag.current?.zone !== undefined) {
        const zi = drag.current.zone;
        const z = deploy!.zones[zi];   // non-null: zone drags only start when deploy exists
        const keep = { x: z.x, y: z.y, w: z.w, h: z.h, o: z.o, x0: z.x0, y0: z.y0 };
        const others = deploy!.zones.filter((oz, i) => i !== zi && oz.block === z.block);
        const before = others.map(oz => zonesOverlap(z, oz));   // pre-step overlap state
        if (drag.current.mode === "rotate") {
          const [zsx, zsz] = w2sc(z.x, z.y, cv.width, cv.height);
          z.o = Math.round((Math.atan2(sz - zsz, sx - zsx) + Math.PI / 2) * 1000) / 1000;
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
      const rect = cv.getBoundingClientRect();
      const sx = e.clientX - rect.left, sz = e.clientY - rect.top;
      const [wx, wz] = s2wc(sx, sz, cv.width, cv.height);
      const v = view.current;
      v.zoom = Math.min(4, Math.max(0.02, v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      v.cx = wx - (sx - cv.width / 2) / v.zoom;
      v.cz = wz - (sz - cv.height / 2) / v.zoom;
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
    status: { position: "absolute", left: 306, bottom: 10, right: 12, fontSize: 11, color: "#9aa287", background: "#141a10cc", padding: "6px 10px", borderRadius: 4, pointerEvents: "none" },
  };

  return (
    <div style={S.app}>
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
            <input style={{ ...S.num, width: 76 }} type="number" placeholder={trees ? String(Math.round(trees.species.reduce((x, s) => x + s.trees.length, 0) * (appliedF * appliedF - 1))) : "n"} value={fillN} onChange={e => setFillN(e.target.value)} />
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
          {batchLog.length > 0 && bundles.length === 0 && (
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
        {(["colour", "height", "trees", "deploy"] as const).map(k => (
          <div key={k} style={S.row}>
            <input type="checkbox" id={k} checked={layer[k]} onChange={e => setLayer({ ...layer, [k]: e.target.checked })} />
            <label htmlFor={k} style={{ fontSize: 11 }}>{{ colour: "colour map (stretched)", height: "heightmap (stretched)", trees: "trees", deploy: "deployment zones" }[k]}</label>
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

      {/* minWidth 0: without it the canvas's pixel width blocks this pane from
          shrinking, pushing the grid panel past the viewport */}
      <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ display: "block", cursor: tool === "pan" ? "grab" : "crosshair" }}
          onMouseDown={onMouse} onMouseMove={onMouse} onMouseUp={onMouse} onMouseLeave={onMouse}
          onContextMenu={e => e.preventDefault()} />
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
