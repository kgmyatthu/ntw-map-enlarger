import JSZip from "jszip";
import type { FileStore, LoadedDeployment, LoadedTreeList } from "../types";
import { parseTreeList, buildTreeList } from "./treeList";
import { parseDeployment, serializeDeployment, autoShiftZones } from "./deployment";
import { scaleAttr, baseTerrainWidth, worldWidth } from "./xml";

/** Find a file by name under root, at any depth, or at the archive top level. */
export function findFile(store: FileStore, root: string, n: string): { p: string; v: Uint8Array<ArrayBuffer> } | null {
  for (const [p, v] of store) if (p === root + n || p.endsWith("/" + n) || p === n) return { p, v };
  return null;
}

/** Unpack a map zip into a FileStore. defPath may be virtual (file absent):
 * without a definition.xml the root is anchored on another edited file and
 * the def rewrite is simply skipped downstream. */
export async function loadZipStore(f: File | Blob | ArrayBuffer): Promise<{ store: FileStore; defPath: string }> {
  const zip = await JSZip.loadAsync(f);
  const store: FileStore = new Map();
  let defPath: string | null = null;
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path].dir) continue;
    store.set(path, new Uint8Array(await zip.files[path].async("arraybuffer")));
    if (path.endsWith("definition.xml")) defPath = path;
  }
  if (!defPath) {
    const alt = [...store.keys()].find(p => /(^|\/)(height_map_0_settings\.xml|deployment_areas\.xml|bmd\.tree_list)$/.test(p));
    if (!alt) throw new Error("no definition.xml");
    defPath = alt.slice(0, alt.lastIndexOf("/") + 1) + "definition.xml";
  }
  return { store, defPath };
}

export interface EnlargeResult {
  out: FileStore;
  root: string;
  nTrees: number;
  nZones: number;
  dep: LoadedDeployment | null;
  depPath: string | null;
  colourBytes: Uint8Array<ArrayBuffer> | null;
  treePts: number[][] | null;
  extent: number;
  origScale: string | null;
  scaleNote: string;
  /** per-map zone push-back actually applied (m) */
  shift: number;
  /** out-of-bounds trees removed (60–100% of those beyond the playable square) */
  cull: number;
}

/** The batch enlarge transform: scale terrain XML + tree coords, push deployment
 * zones back per map until `headroom` m clear of the enlarged map edge. */
export function enlargeStore(store: FileStore, defPath: string, factor: 1.5 | 2, headroom: number): EnlargeResult {
  const enc = new TextEncoder();
  const inner = defPath.slice(0, -"definition.xml".length);
  const out: FileStore = new Map();
  let nTrees = 0, nZones = 0, scaleNote = "", origScale: string | null = null, shift = 0, cull = 0;
  let treePts: number[][] | null = null, colourBytes: Uint8Array<ArrayBuffer> | null = null;
  let dep: LoadedDeployment | null = null, depPath: string | null = null;
  const defBuf = store.get(defPath);
  // ponytail: no definition.xml -> width from height settings world_width (they match in NTW maps), else 2048
  const width = defBuf ? baseTerrainWidth(new TextDecoder().decode(defBuf))
    : worldWidth(new TextDecoder().decode(findFile(store, inner, "height_map_0_settings.xml")?.v ?? new Uint8Array()));
  const extent = Math.round(width * factor);
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
      const dp: LoadedDeployment = { ...parseDeployment(new TextDecoder().decode(v)), path: p };
      shift = autoShiftZones(dp.zones, extent, headroom);
      nZones = dp.zones.length;
      dep = dp; depPath = p;
      out.set(p, enc.encode(serializeDeployment(dp)));
    } else if (name === "bmd.tree_list" && v.length > 40) {
      const tp = parseTreeList(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      let oob = 0, inside = 0, total = 0;
      const inBounds = (tr: { x: number; z: number }) => Math.abs(tr.x) <= extent / 2 && Math.abs(tr.z) <= extent / 2;
      for (const s of tp.species) for (const tr of s.trees) {
        tr.x *= factor; tr.z *= factor; total++;
        if (inBounds(tr)) inside++;
      }
      // cull 60% of trees beyond the playable square, ramping to 90% as the
      // projected post-fill count (inside × factor²) nears 30k, then to 100%
      // at 35k. Integer keep quota spread evenly over the oob trees — no RNG.
      const proj = inside * factor * factor;
      const rate = proj <= 30000 ? 0.4 - 0.3 * proj / 30000 : Math.max(0, 0.1 - 0.1 * (proj - 30000) / 5000);
      const keepN = Math.round((total - inside) * rate);
      for (const s of tp.species) {
        s.trees = s.trees.filter(tr => {
          if (inBounds(tr)) return true;
          const kept = Math.floor((oob + 1) * keepN / (total - inside)) > Math.floor(oob * keepN / (total - inside));
          oob++;
          if (!kept) cull++;
          return kept;
        });
      }
      nTrees = tp.species.reduce((a, s) => a + s.trees.length, 0);
      treePts = tp.species.flatMap((s, si) => s.trees.map(tr => [tr.x, tr.z, si]));
      out.set(p, buildTreeList(tp));
    } else {
      if (/colour_map_0\.(jpg|jpeg|png)$/i.test(name)) colourBytes = v;
      out.set(p, v);
    }
  }
  return { out, root: inner, nTrees, nZones, dep, depPath, colourBytes, treePts, extent, origScale, scaleNote, shift, cull };
}

/** Write live edits (xml overrides, trees, changed deployment) back into a bundle's store. */
export function syncStore(store: FileStore, xml: Record<string, string>, trees: LoadedTreeList | null, deploy: LoadedDeployment | null): void {
  const enc = new TextEncoder();
  for (const p of Object.keys(xml)) store.set(p, enc.encode(xml[p]));
  if (trees) store.set(trees.path, buildTreeList(trees));
  if (deploy && deploy.changed) store.set(deploy.path, enc.encode(serializeDeployment(deploy)));
}

/** Entries for the export zip: edited files rewritten, everything else byte-identical passthrough. */
export function exportEntries(files: FileStore, xml: Record<string, string>, trees: LoadedTreeList | null, deploy: LoadedDeployment | null): [string, Uint8Array<ArrayBuffer>][] {
  const entries: [string, Uint8Array<ArrayBuffer>][] = [];
  for (const [p, v] of files) {
    if (xml[p] !== undefined) entries.push([p, new TextEncoder().encode(xml[p])]);
    else if (trees && p === trees.path) entries.push([p, buildTreeList(trees)]);
    else if (deploy && p === deploy.path && deploy.changed) entries.push([p, new TextEncoder().encode(serializeDeployment(deploy))]);
    else entries.push([p, v]);
  }
  return entries;
}
