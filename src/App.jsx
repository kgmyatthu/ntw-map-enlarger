import { useState, useRef, useEffect, useCallback } from "react";
import JSZip from "jszip";

// =====================================================================
// NTW CUSTOM MAP ENLARGER
// Import a map folder zip -> view colour map + heightmap (both stretched,
// matching grid.fx-fixed engine) -> 2x enlarge (XML LOD chain, optional scale)
// -> edit trees & buildings -> export zip.
// Binary codecs ported from byte-identical-verified Python (43 tree
// lists, 83 building lists round-tripped).
// =====================================================================

// ---------- tree_list codec (LRDZ 14B / RIKI 16B records) ----------
function parseTreeList(buf) {
  const d = new Uint8Array(buf);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const magic = String.fromCharCode(d[8], d[9], d[10], d[11]);
  const stride = magic === "RIKI" ? 16 : 14;
  const starts = [];
  let i = 0;
  while (i < d.length - 4) {
    if (d[i] === 0x0e) {
      const ln = dv.getUint16(i + 1, true);
      if (ln >= 4 && ln <= 200 && i + 3 + ln * 2 <= d.length) {
        let ok = true;
        for (let k = 0; k < Math.min(20, ln * 2); k += 2) {
          const c = d[i + 3 + k];
          if (c < 32 || c >= 127 || d[i + 3 + k + 1] !== 0) { ok = false; break; }
        }
        if (ok) { starts.push({ off: i, len: ln }); i += 3 + ln * 2; continue; }
      }
    }
    i++;
  }
  if (!starts.length) throw new Error("no species blocks");
  const header = d.slice(0, starts[0].off);
  const species = [];
  for (let s = 0; s < starts.length; s++) {
    const { off, len } = starts[s];
    let name = "";
    for (let k = 0; k < len; k++) name += String.fromCharCode(d[off + 3 + k * 2]);
    const nameBytes = d.slice(off, off + 3 + len * 2);
    const ds = off + 3 + len * 2;
    const end = s + 1 < starts.length ? starts[s + 1].off : d.length;
    const trees = [];
    let j = ds + 4;
    while (j + stride <= end && d[j] === 0x00 && d[j + 1] === 0x0c) {
      trees.push({ x: dv.getFloat32(j + 2, true), z: dv.getFloat32(j + 6, true), extra: d.slice(j + 10, j + stride), isNew: false });
      j += stride;
    }
    species.push({ name, nameBytes, trees, trailing: d.slice(j, end) });
  }
  return { header, species, stride, magic, origBytes: d };
}

function discoverSizeFields(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const L = d.length, hdr = [], ftr = [];
  let off = 0;
  while (off < Math.min(48, L - 3)) {
    const v = dv.getUint32(off, true);
    if (L - v >= 0 && L - v <= 64) { hdr.push([off, L - v]); off += 4; } else off++;
  }
  off = Math.max(0, L - 80);
  while (off < L - 3) {
    const v = dv.getUint32(off, true);
    if (L - v >= 0 && L - v <= 64) { ftr.push([L - off, L - v]); off += 4; } else off++;
  }
  return { hdr, ftr };
}

function buildTreeList(parsed) {
  const { header, species, stride, origBytes } = parsed;
  let size = header.length;
  for (const s of species) size += s.nameBytes.length + 4 + s.trees.length * stride + s.trailing.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  out.set(header, p); p += header.length;
  for (const s of species) {
    out.set(s.nameBytes, p); p += s.nameBytes.length;
    dv.setUint32(p, s.trees.length * 256 + 8, true); p += 4;
    for (const t of s.trees) {
      out[p] = 0x00; out[p + 1] = 0x0c;
      dv.setFloat32(p + 2, t.x, true);
      dv.setFloat32(p + 6, t.z, true);
      out.set(t.extra, p + 10);
      p += stride;
    }
    out.set(s.trailing, p); p += s.trailing.length;
  }
  const { hdr, ftr } = discoverSizeFields(origBytes);
  for (const [off, k] of hdr) dv.setUint32(off, size - k, true);
  for (const [feo, k] of ftr) dv.setUint32(size - feo, size - k, true);
  return out;
}

// ---------- DDS heightmap reader (8/16/24/32-bit uncompressed) ----------
function readDDS(buf) {
  const dv = new DataView(buf);
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  const bits = dv.getUint32(88, true);
  const px = new Float32Array(w * h);
  if (bits === 8) {
    const d = new Uint8Array(buf, 128, w * h);
    for (let i = 0; i < w * h; i++) px[i] = d[i] / 255;
  } else if (bits === 16) {
    for (let i = 0; i < w * h; i++) px[i] = dv.getUint16(128 + i * 2, true) / 65535;
  } else if (bits === 24) {
    const d = new Uint8Array(buf, 128);
    for (let i = 0; i < w * h; i++) px[i] = d[i * 3] / 255;
  } else {
    const d = new Uint8Array(buf, 128);
    for (let i = 0; i < w * h; i++) px[i] = d[i * 4] / 255;
  }
  return { w, h, px };
}

function heightToCanvas(hm) {
  const cv = document.createElement("canvas");
  cv.width = hm.w; cv.height = hm.h;
  const ctx = cv.getContext("2d");
  const im = ctx.createImageData(hm.w, hm.h);
  let mn = 1, mx = 0;
  for (let i = 0; i < hm.px.length; i++) { if (hm.px[i] < mn) mn = hm.px[i]; if (hm.px[i] > mx) mx = hm.px[i]; }
  const rg = mx - mn || 1;
  for (let i = 0; i < hm.px.length; i++) {
    const v = Math.round(((hm.px[i] - mn) / rg) * 235 + 20);
    im.data[i * 4] = v * 0.55; im.data[i * 4 + 1] = v * 0.62; im.data[i * 4 + 2] = v * 0.5; im.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return cv;
}

// ---------- XML enlarge edits ----------
function scaleAttr(xml, attr, f) {
  return xml.replace(new RegExp(`(${attr}=')([0-9.]+)(')`, "g"),
    (m, a, v, c) => `${a}${(parseFloat(v) * f).toFixed(6)}${c}`);
}
function setScale(xml, scale) {
  return xml.replace(/(scale=')([0-9.\-]+)(')/g, (m, a, v, c) => `${a}${scale}${c}`);
}

// ---------- deployment_areas.xml (text-preserving zone editor) ----------
function parseDeployment(text) {
  // normalise European decimal commas inside attribute values
  text = text.replace(/(=')([\-0-9]+),([0-9]+)(')/g, "$1$2.$3$4");
  const segs = [];        // alternating raw text / zone segments
  const zones = [];
  const re = /<deployment_area[\s\S]*?<\/deployment_area>/g;
  let last = 0, m, block = -1;
  const blockStarts = [];
  const bre = /<BATTLE_DEPLOYMENT_AREAS>/g;
  let bm;
  while ((bm = bre.exec(text))) blockStarts.push(bm.index);
  const alRe = /<ALLIANCE id='(\d+)'>/g;
  const alliances = [];
  let am;
  while ((am = alRe.exec(text))) alliances.push({ idx: am.index, id: +am[1] });
  while ((m = re.exec(text))) {
    segs.push({ raw: text.slice(last, m.index) });
    const seg = m[0];
    const g = (rx) => { const r = rx.exec(seg); return r ? parseFloat(r[1]) : 0; };
    let blk = 0; for (let i = 0; i < blockStarts.length; i++) if (blockStarts[i] < m.index) blk = i;
    let al = 0; for (const a of alliances) if (a.idx < m.index) al = a.id;
    const z = {
      x: g(/x="([\-0-9.]+)"/), y: g(/y="([\-0-9.]+)"/),
      w: g(/width metres="([\-0-9.]+)"/), h: g(/height metres="([\-0-9.]+)"/),
      o: g(/orientation radians="([\-0-9.]+)"/),
      block: blk, alliance: al, seg,
    };
    zones.push(z);
    segs.push({ zone: z });
    last = m.index + seg.length;
  }
  segs.push({ raw: text.slice(last) });
  const nBlocks = blockStarts.length || 1;
  return { segs, zones, nBlocks, changed: false };
}

function serializeDeployment(dep) {
  let out = "";
  for (const s of dep.segs) {
    if (s.raw !== undefined) { out += s.raw; continue; }
    const z = s.zone;
    let seg = z.seg;
    seg = seg.replace(/x="[\-0-9.]+"/, `x="${+z.x.toFixed(1)}"`);
    seg = seg.replace(/y="[\-0-9.]+"/, `y="${+z.y.toFixed(1)}"`);
    seg = seg.replace(/width metres="[\-0-9.]+"/, `width metres="${+z.w.toFixed(1)}"`);
    seg = seg.replace(/height metres="[\-0-9.]+"/, `height metres="${+z.h.toFixed(1)}"`);
    out += seg;
  }
  return out;
}

const SP_COLORS = ["#7ec97e", "#5fb8b8", "#c9b45f", "#b88add", "#e08b6d", "#8fa9e0", "#d97fa6", "#a3c95f"];

export default function MapEnlarger() {
  const [files, setFiles] = useState(null);
  const [mapName, setMapName] = useState("");
  const [colourImg, setColourImg] = useState(null);
  const [hmCanvas, setHmCanvas] = useState(null);
  const [trees, setTrees] = useState(null);
  const [deploy, setDeploy] = useState(null);
  const [blockIdx, setBlockIdx] = useState(0);
  const [selZone, setSelZone] = useState(null);
  const [shiftN, setShiftN] = useState(400);
  const [enlarged, setEnlarged] = useState(false);
  const [baseSize, setBaseSize] = useState(2048);
  const [scaleOpt, setScaleOpt] = useState("");
  const [factor, setFactor] = useState(2);
  const [appliedF, setAppliedF] = useState(1);
  const [shaderMsg, setShaderMsg] = useState(null);
  const [batchShift, setBatchShift] = useState(400);  // deployment shift metres
  const [batchLog, setBatchLog] = useState([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [bundles, setBundles] = useState([]);
  const [curBundle, setCurBundle] = useState(null);
  const [gridOpen, setGridOpen] = useState(false);
  const [fillAlgo, setFillAlgo] = useState("cluster");
  const [fillN, setFillN] = useState("");
  const [layer, setLayer] = useState({ colour: true, height: true, trees: true, deploy: true });
  const [tool, setTool] = useState("pan");
  const [entity, setEntity] = useState({ kind: "tree", idx: 0 });
  const [brushR, setBrushR] = useState(60);
  const [density, setDensity] = useState(6);
  const [status, setStatus] = useState("Import a map folder zip to begin.");
  const [, tick] = useState(0);
  const rr = () => tick(t => t + 1);

  const canvasRef = useRef(null);
  const view = useRef({ zoom: 0.16, cx: 0, cz: 0 });
  const drag = useRef(null);
  const cursor = useRef(null);
  const undoRef = useRef([]);
  const xmlRef = useRef({});

  const mapSize = enlarged ? Math.round(baseSize * appliedF) : baseSize;
  const imgExtent = baseSize;

  const loadStore = (store, root, displayName, processedFactor, depOverride) => {
    {
      const get = (n) => { for (const [p, v] of store) if (p === root + n || p.endsWith("/" + n) || p === n) return { p, v }; return null; };

      const def = get("definition.xml");
      if (!def) throw new Error("no definition.xml in zip");
      const defTxt = new TextDecoder().decode(def.v);
      const bw = /base_terrain_width='([0-9.]+)'/.exec(defTxt);
      const raw = bw ? Math.round(parseFloat(bw[1])) : 2048;
      const bs = processedFactor ? Math.round(raw / processedFactor) : raw;
      setBaseSize(bs);
      setMapName(displayName);
      xmlRef.current = { [def.p]: defTxt };
      for (let i = 0; i < 4; i++) {
        const s = get(`height_map_${i}_settings.xml`);
        if (s) xmlRef.current[s.p] = new TextDecoder().decode(s.v);
      }

      let ci = null;
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
            const cx = cv.getContext("2d"); cx.filter = "grayscale(1)"; cx.drawImage(im, 0, 0);
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
    }
  };

  const applyScale = (v) => {
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



  const addTreesAt = (pts) => {
    if (!trees || entity.kind !== "tree") return;
    const s = trees.species[entity.idx];
    const src = s.trees.length ? s.trees : trees.species.find(x => x.trees.length)?.trees;
    if (!src) return;
    const added = pts.map((p, i) => ({ x: Math.round(p[0] * 10) / 10, z: Math.round(p[1] * 10) / 10, extra: src[i % src.length].extra, isNew: true }));
    s.trees.push(...added);
    undoRef.current.push({ type: "tree-add", si: entity.idx, n: added.length });
    rr();
  };
  const eraseAt = (wx, wz) => {
    const removed = [];
    if (trees) trees.species.forEach((s, si) => {
      for (let i = s.trees.length - 1; i >= 0; i--) {
        const t = s.trees[i], dx = t.x - wx, dz = t.z - wz;
        if (dx * dx + dz * dz <= brushR * brushR) { removed.push({ kind: "tree", si, i, t }); s.trees.splice(i, 1); }
      }
    });
    if (removed.length) { undoRef.current.push({ type: "erase", removed }); rr(); }
  };
  const undo = () => {
    const a = undoRef.current.pop();
    if (!a) return;
    if (a.type === "fill") { a.addedPer.forEach((n, si) => n && trees.species[si].trees.splice(-n, n)); refreshCurThumb(); }
    else if (a.type === "zone-move") { const z = deploy.zones[a.zi]; z.x = a.x; z.y = a.y; if (a.y0 !== undefined) z.y0 = a.y0; deploy.changed = true; }
    else if (a.type === "tree-add") trees.species[a.si].trees.splice(-a.n, a.n);
    else [...a.removed].reverse().forEach(r => trees.species[r.si].trees.splice(r.i, 0, r.t));
    rr();
  };

  // grid.fx patch — the streak fix. The terrain shader computes colour/blend
  // UVs as world_position.xz / terrain_size_meters + 0.5 with the CPU feeding
  // 2048; scaling the divisor widens the window to match the enlarged map.
  const patchGridFx = async (file) => {
    let txt = await file.text();
    const A = "float2 tex_cm = r.world_position.xz/(terrain_size_meters);";
    const B = "float2 offset = 1.0f / (terrain_size_meters);";
    const nA = txt.split(A).length - 1;
    const nB = txt.split(B).length - 1;
    const F = factor === 1.5 ? "1.5f" : "2.0f";
    if (nA === 0 && /terrain_size_meters \* [12]\.[05]f/.test(txt)) {
      setShaderMsg("Already patched \u2014 start from the original grid.fx to change factor.");
      return;
    }
    if (nA === 0) {
      setShaderMsg("Pattern not found \u2014 different shader version? Send it to be inspected.");
      return;
    }
    txt = txt.split(A).join(`float2 tex_cm = r.world_position.xz/(terrain_size_meters * ${F});`);
    txt = txt.split(B).join(`float2 offset = 1.0f / (terrain_size_meters * ${F});`);
    const blob = new Blob([txt], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "grid.fx";
    a.click();
    setShaderMsg(`Patched ${nA} UV site${nA > 1 ? "s" : ""} + ${nB} offset \u2192 window \u00d7${factor} (${Math.round(2048 * factor)} m). Install via PFM + delete shader cache.`);
  };

  const shiftAllOutward = () => {
    if (!deploy) return;
    for (const z of deploy.zones) z.y += (z.y >= 0 ? 1 : -1) * shiftN;
    deploy.changed = true;
    undoRef.current = [];
    setStatus(`All deployment zones shifted ${shiftN} m outward (every block, both alliances). Undo history cleared.`);
    rr();
  };

  // ---- tree auto-fill (per current map, on demand, undoable) ----
  const colourWeightFn = () => {
    if (!colourImg) return null;
    const S = 512;
    const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
    const cx = cv.getContext("2d");
    cx.drawImage(colourImg, 0, 0, S, S);
    const d = cx.getImageData(0, 0, S, S).data;
    return (wx, wz) => {
      const u = wx / mapSize + 0.5, v = 1 - (wz / mapSize + 0.5);   // row 0 = +Z
      const px = Math.min(S - 1, Math.max(0, (u * S) | 0)), py = Math.min(S - 1, Math.max(0, (v * S) | 0));
      const i = (py * S + px) * 4, r = d[i], g = d[i + 1], b = d[i + 2], m = (r + g + b) / 3;
      return Math.max(0, (g - m) - 0.3 * m + 18) / 60;
    };
  };

  const fillTrees = () => {
    if (!trees) return;
    const counts = trees.species.map(s => s.trees.length);
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) { setStatus("No existing trees to base fill on."); return; }
    const suggested = Math.round(total * (appliedF * appliedF - 1));
    const target = Math.min(parseInt(fillN) > 0 ? parseInt(fillN) : Math.max(suggested, 0), 45000 - total);
    if (target <= 0) { setStatus("Nothing to add (target 0)."); return; }
    const half = mapSize / 2 - 60;
    const all = trees.species.flatMap(s => s.trees.map(tr => [tr.x, tr.z]));
    const cw = fillAlgo === "colour" ? colourWeightFn() : null;
    // spatial hash for 'spaced'
    const cell = Math.max(8, Math.sqrt((mapSize * mapSize) / Math.max(1, total + target)) * 0.7);
    const hash = new Map();
    const hkey = (x, z) => ((x / cell) | 0) + ":" + ((z / cell) | 0);
    if (fillAlgo === "spaced") for (const [x, z] of all) hash.set(hkey(x, z), true);
    const addedPer = trees.species.map(() => 0);
    let added = 0, tries = 0;
    while (added < target && tries < target * 40) {
      tries++;
      let wx, wz;
      if (fillAlgo === "cluster") {
        const [bx, bz] = all[(Math.random() * all.length) | 0];
        const a = Math.random() * 6.283, r = Math.abs((Math.random() + Math.random() + Math.random()) / 1.5 - 1) * 90;
        wx = bx + Math.cos(a) * r; wz = bz + Math.sin(a) * r;
      } else {
        wx = (Math.random() * 2 - 1) * half; wz = (Math.random() * 2 - 1) * half;
      }
      if (Math.abs(wx) > half || Math.abs(wz) > half) continue;
      if (fillAlgo === "colour" && cw && Math.random() > cw(wx, wz)) continue;
      if (fillAlgo === "spaced" && hash.has(hkey(wx, wz))) continue;
      let r = Math.random() * total, si = 0;
      for (; si < counts.length; si++) { r -= counts[si]; if (r <= 0) break; }
      si = Math.min(si, counts.length - 1);
      const s = trees.species[si];
      if (!s.trees.length) continue;
      const proto = s.trees[(Math.random() * s.trees.length) | 0];
      const nt = { x: Math.round(wx * 10) / 10, z: Math.round(wz * 10) / 10, extra: proto.extra, isNew: true };
      s.trees.push(nt);
      if (fillAlgo === "spaced") hash.set(hkey(wx, wz), true);
      if (fillAlgo === "cluster") all.push([wx, wz]);
      addedPer[si]++; added++;
    }
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

  const makeThumb = async (colourBytes, treePts, zoneRects, extent) => {
    const S = 220;
    const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#1a2016"; ctx.fillRect(0, 0, S, S);
    if (colourBytes) {
      const img = await new Promise(res => {
        const im = new Image();
        im.onload = () => res(im); im.onerror = () => res(null);
        im.src = URL.createObjectURL(new Blob([colourBytes]));
      });
      if (img) { ctx.save(); ctx.translate(0, S); ctx.scale(1, -1); ctx.drawImage(img, 0, 0, S, S); ctx.restore(); }
    }
    const w2t = (x, z) => [(x / extent + 0.5) * S, (z / extent + 0.5) * S];
    if (treePts) {
      ctx.fillStyle = "#7ec97e";
      for (let i = 0; i < treePts.length; i += Math.max(1, (treePts.length / 2500) | 0)) {
        const [px, pz] = w2t(treePts[i][0], treePts[i][1]);
        ctx.fillRect(px, pz, 1.2, 1.2);
      }
    }
    if (zoneRects) for (const [x, y, w, h, al] of zoneRects) {
      const [a, b] = w2t(x - w / 2, y - h / 2), [c, d] = w2t(x + w / 2, y + h / 2);
      ctx.strokeStyle = al === 0 ? "#6d9ee0" : "#e07d6d"; ctx.lineWidth = 1;
      ctx.strokeRect(a, b, c - a, d - b);
    }
    ctx.strokeStyle = "#8a9a78"; ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
    return cv.toDataURL("image/png");
  };

  // write the currently-viewed map's live edits back into its bundle
  const syncCurrent = () => {
    if (curBundle === null || !bundles[curBundle] || !files) return;
    const b = bundles[curBundle];
    const enc = new TextEncoder();
    for (const p of Object.keys(xmlRef.current)) b.store.set(p, enc.encode(xmlRef.current[p]));
    if (trees) b.store.set(trees.path, buildTreeList(trees));
    if (deploy && deploy.changed) b.store.set(deploy.path, enc.encode(serializeDeployment(deploy)));
  };

  const bulkExport = async () => {
    if (!bundles.length) return;
    syncCurrent();
    const outZip = new JSZip();
    const used = new Set();
    for (const b of bundles) {
      let root = b.root || b.name + "/";
      let base = root;
      for (let k = 2; used.has(root); k++) root = base.replace(/\/$/, "") + "_" + k + "/";
      used.add(root);
      for (const [p, v] of b.store) {
        const rel = b.root ? p.slice(b.root.length) : p;
        outZip.file(root + rel, v);
      }
      b.exported = true;
    }
    setBundles(bundles.slice());
    const blob = await outZip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `batch_enlarged_x${bundles[0].factor}.zip`;
    a.click();
    setStatus(`Bulk export: ${bundles.length} maps in one zip (includes any per-map edits).`);
  };

  const applyBatchShift = async (n) => {
    setBatchShift(n);
    if (!bundles.length || isNaN(n)) return;
    syncCurrent();                                   // keep any tree brushing
    const enc = new TextEncoder();
    for (const b of bundles) {
      if (!b.dep) continue;
      for (const z of b.dep.zones) z.y = z.y0 + (z.y0 >= 0 ? 1 : -1) * n;
      b.store.set(b.depPath, enc.encode(serializeDeployment(b.dep)));
      b.exported = false;
    }
    if (curBundle !== null && bundles[curBundle]) {
      const b = bundles[curBundle];
      loadStore(b.store, b.root, b.name + " [" + (curBundle + 1) + "/" + bundles.length + "]", b.factor, b.dep);
      setScaleOpt(b.scaleSet || "");
    }
    setBundles(bundles.slice());
    // regenerate thumbnails so the grid shows the new zone positions
    for (const b of bundles) {
      if (!b.dep) continue;
      let pts = null;
      const tKey = [...b.store.keys()].find(p => p.endsWith("bmd.tree_list"));
      if (tKey && b.store.get(tKey).length > 40) {
        try {
          const v = b.store.get(tKey);
          const tp = parseTreeList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
          pts = tp.species.flatMap(s => s.trees.map(tr => [tr.x, tr.z]));
        } catch (e) { /* keep old thumb trees */ }
      }
      b.thumb = await makeThumb(b.colourBytes, pts, b.dep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance]), b.extent);
    }
    setBundles(bundles.slice());
    setStatus(`Deployment shift ${n} m applied live to all ${bundles.length} maps \u2014 grid + viewer updated.`);
  };

  const processBatch = async (fileList) => {
    if (!fileList.length || batchBusy) return;
    setBatchBusy(true);
    const log = [];
    setBatchLog(log.slice());
    const newBundles = [];
    const enc = new TextEncoder();
    for (const f of fileList) {
      try {
        const zip = await JSZip.loadAsync(f);
        const store = new Map();
        let defPath = null;
        for (const path of Object.keys(zip.files)) {
          if (zip.files[path].dir) continue;
          store.set(path, new Uint8Array(await zip.files[path].async("arraybuffer")));
          if (path.endsWith("definition.xml")) defPath = path;
        }
        if (!defPath) throw new Error("no definition.xml");
        const inner = defPath.slice(0, -"definition.xml".length);
        const out = new Map();

        let nTrees = 0, nZones = 0, scaleNote = "", origScale = null;
        let thumbTrees = null, thumbZones = null, colourBytes = null, extent = 4096;
        let bundleDep = null, depPath = null;
        {
          const dtxt = new TextDecoder().decode(store.get(defPath));
          const bw = /base_terrain_width='([0-9.]+)'/.exec(dtxt);
          extent = Math.round((bw ? parseFloat(bw[1]) : 2048) * factor);
        }
        for (const [p, v] of store) {
          const name = inner ? p.slice(inner.length) : p;
          if (name === "definition.xml") {
            let x = new TextDecoder().decode(v);
            x = scaleAttr(x, "base_terrain_width", factor);
            x = scaleAttr(x, "base_terrain_height", factor);
            out.set(p, enc.encode(x));
          } else if (/^height_map_\d_settings\.xml$/.test(name)) {
            let x = new TextDecoder().decode(v);
            const before = (/scale='([0-9.\-]+)'/.exec(x) || [])[1];
            x = scaleAttr(x, "world_width", factor);
            x = scaleAttr(x, "world_height", factor);
            if (name === "height_map_0_settings.xml" && before) { origScale = before; scaleNote = `scale ${before}`; }
            out.set(p, enc.encode(x));
          } else if (name === "deployment_areas.xml") {
            const dp = parseDeployment(new TextDecoder().decode(v));
            for (const z of dp.zones) { z.y0 = z.y; z.y += (z.y >= 0 ? 1 : -1) * batchShift; }
            nZones = dp.zones.length;
            dp.path = p; bundleDep = dp; depPath = p;
            out.set(p, enc.encode(serializeDeployment(dp)));
          } else if (name === "bmd.tree_list" && v.length > 40) {
            const tp = parseTreeList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
            for (const s of tp.species) for (const tr of s.trees) { tr.x *= factor; tr.z *= factor; }
            nTrees = tp.species.reduce((a, s) => a + s.trees.length, 0);
            thumbTrees = tp.species.flatMap(s => s.trees.map(tr => [tr.x, tr.z]));
            out.set(p, buildTreeList(tp));
          } else {
            if (/colour_map_0\.(jpg|jpeg|png)$/i.test(name)) colourBytes = v;
            out.set(p, v);
          }
        }
        const thumb = await makeThumb(colourBytes, thumbTrees, thumbZones ?? (bundleDep ? bundleDep.zones.filter(z => z.block === 0).map(z => [z.x, z.y, z.w, z.h, z.alliance]) : null), extent);
        newBundles.push({ name: f.name.replace(/\.zip$/i, ""), store: out, root: inner, factor, exported: false, thumb, nTrees, nZones, dep: bundleDep, depPath, colourBytes, extent, origScale });
        log.push(`\u2713 ${f.name}: \u00d7${factor}, ${nTrees} trees, ${nZones} zones +${batchShift}m, ${scaleNote}`);
      } catch (e) {
        log.push(`\u2717 ${f.name}: ${e.message}`);
      }
      setBatchLog(log.slice());
    }
    setBundles(newBundles);
    setBatchBusy(false);
    if (newBundles.length) {
      setGridOpen(true);
      setCurBundle(0);
      loadStore(newBundles[0].store, newBundles[0].root, newBundles[0].name + " [1/" + newBundles.length + "]", factor, newBundles[0].dep);
      setScaleOpt(newBundles[0].scaleSet || "");
      setStatus(`Batch processed ${newBundles.length}/${fileList.length} maps \u2014 review each in the viewer, then Export map zip for the ones you approve.`);
    } else setStatus("Batch: no maps processed.");
  };

  const viewBundle = (i) => {
    syncCurrent();
    setCurBundle(i);
    setGridOpen(false);
    const b = bundles[i];
    loadStore(b.store, b.root, b.name + " [" + (i + 1) + "/" + bundles.length + "]", b.factor, b.dep);
    setScaleOpt(b.scaleSet || "");
  };

  const doExport = async () => {
    if (!files) return;
    const zip = new JSZip();
    const enc = new TextEncoder();
    for (const [p, v] of files) {
      if (xmlRef.current[p] !== undefined) zip.file(p, enc.encode(xmlRef.current[p]));
      else if (trees && p === trees.path) zip.file(p, buildTreeList(trees));
      else if (deploy && p === deploy.path && deploy.changed) zip.file(p, enc.encode(serializeDeployment(deploy)));
      else zip.file(p, v);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (mapName.replace(/ \[\d+\/\d+\]$/, "") || "map") + (enlarged ? "_" + mapSize : "") + ".zip";
    a.click();
    if (curBundle !== null && bundles[curBundle]) {
      bundles[curBundle].exported = true;
      setBundles(bundles.slice());
    }
    setStatus("Exported. Size/link fields rewritten in edited binaries; everything else byte-identical passthrough.");
  };

  // ---------- canvas ----------
  const w2s = (x, z, cw, ch) => [cw / 2 + (x - view.current.cx) * view.current.zoom, ch / 2 + (z - view.current.cz) * view.current.zoom];
  const s2w = (sx, sz, cw, ch) => [(sx - cw / 2) / view.current.zoom + view.current.cx, (sz - ch / 2) / view.current.zoom + view.current.cz];

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const cw = cv.width, ch = cv.height;
    ctx.fillStyle = "#12160f"; ctx.fillRect(0, 0, cw, ch);
    const half = mapSize / 2, ihalf = imgExtent / 2;

    // image row 0 = world +Z (verified: existing trees land on forest pixels
    // only with a vertical flip), so both image layers draw V-flipped.
    const drawFlipped = (img, a, b, c, d) => {
      ctx.save();
      ctx.translate(0, d);
      ctx.scale(1, -1);
      ctx.drawImage(img, a, 0, c - a, d - b);
      ctx.restore();
    };
    {
      const [a, b] = w2s(-half, -half, cw, ch), [c, d] = w2s(half, half, cw, ch);
      if (layer.height && hmCanvas) { ctx.imageSmoothingEnabled = true; drawFlipped(hmCanvas, a, b, c, d); }
      else { ctx.fillStyle = "#222a1d"; ctx.fillRect(a, b, c - a, d - b); }
    }
    if (layer.colour && colourImg) {
      // with the grid.fx fix the colour/blend window spans the full terrain
      const [a, b] = w2s(-half, -half, cw, ch), [c, d] = w2s(half, half, cw, ch);
      ctx.globalAlpha = 0.9;
      drawFlipped(colourImg, a, b, c, d);
      ctx.globalAlpha = 1;
    }
    const box = (hx, color, dash, label) => {
      const [a, b] = w2s(-hx, -hx, cw, ch), [c, d] = w2s(hx, hx, cw, ch);
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
          const [sx, sz] = w2s(t.x, t.z, cw, ch);
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
        const [sx, sz] = w2s(z.x, z.y, cw, ch);
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
        ctx.restore();
      });
    }
    if (cursor.current && tool !== "pan") {
      const [sx, sz] = w2s(cursor.current[0], cursor.current[1], cw, ch);
      const rr2 = tool === "place" ? 8 : brushR * view.current.zoom;
      ctx.strokeStyle = tool === "erase" ? "#e06d6d" : "#e8e3c9";
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sx, sz, rr2, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [files, colourImg, hmCanvas, trees, deploy, blockIdx, selZone, enlarged, mapSize, imgExtent, layer, tool, brushR]);

  useEffect(() => { draw(); });
  useEffect(() => {
    const cv = canvasRef.current;
    const ro = new ResizeObserver(() => {
      const r = cv.parentElement.getBoundingClientRect();
      cv.width = r.width; cv.height = r.height; draw();
    });
    ro.observe(cv.parentElement);
    return () => ro.disconnect();
  }, [draw]);

  const stamp = (wx, wz) => {
    const pts = [];
    for (let k = 0; k < density; k++) {
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * brushR;
      const x = wx + Math.cos(a) * r, z = wz + Math.sin(a) * r;
      if (Math.abs(x) < mapSize / 2 - 10 && Math.abs(z) < mapSize / 2 - 10) pts.push([x, z]);
    }
    addTreesAt(pts);
  };

  const onMouse = (e) => {
    const cv = canvasRef.current, rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left, sz = e.clientY - rect.top;
    const [wx, wz] = s2w(sx, sz, cv.width, cv.height);
    cursor.current = [wx, wz];
    if (e.type === "mousedown") {
      if (e.button !== 0 || tool === "pan" || e.shiftKey) drag.current = { sx, sz, cx: view.current.cx, cz: view.current.cz, panning: true };
      else if (tool === "zones") {
        let hit = null;
        if (deploy) deploy.zones.forEach((z, zi) => {
          if (z.block !== blockIdx) return;
          const dx = wx - z.x, dz = wz - z.y;
          const rx = dx * Math.cos(-z.o) - dz * Math.sin(-z.o);
          const rz = dx * Math.sin(-z.o) + dz * Math.cos(-z.o);
          if (Math.abs(rx) <= z.w / 2 && Math.abs(rz) <= z.h / 2) hit = zi;
        });
        setSelZone(hit);
        if (hit !== null) {
          const z = deploy.zones[hit];
          drag.current = { zone: hit, ox: z.x, oy: z.y, wx0: wx, wz0: wz };
          undoRef.current.push({ type: "zone-move", zi: hit, x: z.x, y: z.y, y0: z.y0 });
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
        const z = deploy.zones[drag.current.zone];
        z.x = Math.round((drag.current.ox + (wx - drag.current.wx0)) * 10) / 10;
        z.y = Math.round((drag.current.oy + (wz - drag.current.wz0)) * 10) / 10;
        if (z.y0 !== undefined) z.y0 = z.y - (z.y0 >= 0 ? 1 : -1) * batchShift;
        deploy.changed = true;
      } else if (drag.current?.painting) {
        const [lx, lz] = drag.current.last, d = Math.hypot(wx - lx, wz - lz);
        if (tool === "brush" && d > brushR * 0.6) { stamp(wx, wz); drag.current.last = [wx, wz]; }
        else if (tool === "erase" && d > brushR * 0.3) { eraseAt(wx, wz); drag.current.last = [wx, wz]; }
        else if (tool === "place" && entity.kind === "tree" && d > 12) { addTreesAt([[wx, wz]]); drag.current.last = [wx, wz]; }
      }
      draw();
    } else drag.current = null;
  };
  const onWheel = (e) => {
    e.preventDefault();
    const cv = canvasRef.current, rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left, sz = e.clientY - rect.top;
    const [wx, wz] = s2w(sx, sz, cv.width, cv.height);
    const v = view.current;
    v.zoom = Math.min(4, Math.max(0.02, v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    v.cx = wx - (sx - cv.width / 2) / v.zoom;
    v.cz = wz - (sz - cv.height / 2) / v.zoom;
    draw();
  };

  // ---------- UI ----------
  const S = {
    app: { display: "flex", height: "100vh", background: "#10140f", color: "#d9d4bd", fontFamily: "ui-monospace,'Cascadia Mono',Consolas,monospace", fontSize: 13 },
    side: { width: 292, padding: 14, borderRight: "1px solid #2b3226", overflowY: "auto", flexShrink: 0 },
    h: { fontSize: 15, letterSpacing: 1, color: "#e8e3c9", margin: "0 0 2px" },
    sub: { fontSize: 11, color: "#8a9179", margin: "0 0 12px" },
    lbl: { display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 1.2, color: "#8a9179", margin: "13px 0 5px" },
    row: { display: "flex", gap: 6, alignItems: "center", marginBottom: 4 },
    btn: (on) => ({ flex: 1, padding: "6px 4px", background: on ? "#4a5a3a" : "#1c2318", border: `1px solid ${on ? "#7a8a5a" : "#3a4433"}`, color: on ? "#f0ecd8" : "#b9b39a", borderRadius: 3, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }),
    act: (en) => ({ width: "100%", padding: "9px", background: en ? "#5a4a1e" : "#242a1e", border: `1px solid ${en ? "#a08a3a" : "#3a4433"}`, color: en ? "#f0e8c0" : "#6a715c", borderRadius: 3, cursor: en ? "pointer" : "default", fontFamily: "inherit", fontSize: 13, marginTop: 6 }),
    ent: (on) => ({ display: "flex", alignItems: "center", gap: 6, padding: "4px 7px", marginBottom: 2, background: on ? "#2a3323" : "transparent", border: `1px solid ${on ? "#5a6a44" : "transparent"}`, borderRadius: 3, cursor: "pointer", fontSize: 11 }),
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
          <button style={S.btn(factor === 1.5)} onClick={() => !enlarged && setFactor(1.5)}>×1.5 → {Math.round(baseSize * 1.5)}</button>
          <button style={S.btn(factor === 2)} onClick={() => !enlarged && setFactor(2)}>×2 → {baseSize * 2}</button>
        </div>
        <p style={{ fontSize: 10, color: "#6d755f", margin: "2px 0 0", lineHeight: 1.4 }}>
          tree coordinates spread automatically with the terrain
        </p>

        <label style={S.lbl}>Batch process (multi-zip)</label>
          <input type="file" accept=".zip" multiple style={{ fontSize: 11, width: "100%", color: "#b9b39a" }}
            disabled={batchBusy}
            onChange={e => e.target.files.length && processBatch([...e.target.files])} />
          <div style={S.row}>
            <span style={{ fontSize: 11, width: 108 }}>deploy shift (m)</span>
            <input style={S.num} type="number" value={batchShift} onChange={e => applyBatchShift(+e.target.value)} />
          </div>
          <div style={S.row}>
            <span style={{ fontSize: 11, width: 108 }}>height scale</span>
            <input style={S.num} placeholder="keep" value={scaleOpt} onChange={e => applyScale(e.target.value)} />
            <span style={{ fontSize: 10, color: "#8a9179" }}>
              orig {curBundle !== null && bundles[curBundle] && bundles[curBundle].origScale ? bundles[curBundle].origScale : "—"}
            </span>
          </div>
          <label style={S.lbl}>Tree auto-fill (current map)</label>
          <div style={S.row}>
            {["cluster", "colour", "uniform", "spaced"].map(a => (
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
            density. Undoable, per map.
          </p>

          <p style={{ fontSize: 10, color: "#6d755f", lineHeight: 1.4, margin: "2px 0 0" }}>
            height scale multiplies each map's own original value. Review is
            view-only: trees are auto-coordinated, not editable in batch.
          </p>
          {batchLog.length > 0 && bundles.length === 0 && (
            <div style={{ fontSize: 10, background: "#151a11", padding: 6, borderRadius: 3, marginTop: 4, maxHeight: 120, overflowY: "auto" }}>
              {batchLog.map((l, i) => <div key={i} style={{ color: l.startsWith("\u2713") ? "#9ab87a" : "#d08a7a" }}>{l}</div>)}
            </div>
          )}
          {bundles.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={S.row}>
                <button style={S.btn(gridOpen)} onClick={() => setGridOpen(!gridOpen)}>grid preview</button>
                <button style={S.btn(false)} onClick={bulkExport}>export ALL</button>
              </div>
              {bundles.map((b, i) => (
                <div key={i} style={S.ent(curBundle === i)} onClick={() => viewBundle(i)}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: b.exported ? "#9ab87a" : "#8a9179", flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                  <span style={{ color: b.exported ? "#9ab87a" : "#6d755f" }}>{b.exported ? "exported" : "review"}</span>
                </div>
              ))}
              <button style={S.act(curBundle !== null)} disabled={curBundle === null} onClick={doExport}>Export current map zip</button>
            </div>
          )}

        <label style={S.lbl}>Layers</label>
        {["colour", "height", "trees", "deploy"].map(k => (
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

        {deploy && <>
            {selZone !== null && deploy.zones[selZone] && (() => { const z = deploy.zones[selZone]; return (
              <div style={{ fontSize: 11, background: "#1a2016", padding: 7, borderRadius: 3, marginBottom: 4 }}>
                <div style={{ color: z.alliance === 0 ? "#6d9ee0" : "#e07d6d", marginBottom: 4 }}>alliance {z.alliance} zone</div>
                {["x", "y", "w", "h"].map(k => (
                  <div key={k} style={S.row}>
                    <span style={{ width: 14 }}>{k}</span>
                    <input style={{ ...S.num, width: 80 }} type="number" value={z[k]}
                      onChange={e => { z[k] = +e.target.value; if (k === "y" && z.y0 !== undefined) z.y0 = z.y - (z.y0 >= 0 ? 1 : -1) * batchShift; deploy.changed = true; rr(); }} />
                  </div>
                ))}
              </div>
            ); })()}
        </>}

        <label style={S.lbl}>Shader fix — grid.fx (once per install)</label>
        <input type="file" accept=".fx" style={{ fontSize: 11, width: "100%", color: "#b9b39a" }}
          onChange={e => e.target.files[0] && patchGridFx(e.target.files[0])} />
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

      <div style={{ flex: 1, position: "relative" }}>
        <canvas ref={canvasRef} style={{ display: "block", cursor: tool === "pan" ? "grab" : "crosshair" }}
          onMouseDown={onMouse} onMouseMove={onMouse} onMouseUp={onMouse} onMouseLeave={onMouse}
          onWheel={onWheel} onContextMenu={e => e.preventDefault()} />
        {gridOpen && bundles.length > 0 && (
          <div style={{ position: "absolute", inset: 0, background: "#10140fee", overflowY: "auto", padding: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {bundles.map((b, i) => (
                <div key={i} onClick={() => viewBundle(i)}
                  style={{ cursor: "pointer", width: 224, border: `1px solid ${curBundle === i ? "#a08a3a" : "#3a4433"}`, borderRadius: 4, background: "#151a11", padding: 5 }}>
                  {b.thumb ? <img src={b.thumb} width={212} height={212} style={{ display: "block", borderRadius: 2 }} alt="" />
                    : <div style={{ width: 212, height: 212, background: "#1a2016" }} />}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4, color: "#d9d4bd" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{b.name}</span>
                    <span style={{ color: b.exported ? "#9ab87a" : "#8a9179" }}>{b.exported ? "exported" : b.nTrees + "t"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={S.status}>{status}</div>
      </div>
    </div>
  );
}
