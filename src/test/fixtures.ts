import JSZip from "jszip";

// Shared synthetic fixtures for the NTW map formats. Reuse these — don't
// hand-roll buffers in individual test files.

export interface FixTree { x: number; z: number; extra?: number[] }
export interface FixSpecies { name: string; trees: FixTree[]; trailing?: number[] }

/**
 * Build a syntactically valid bmd.tree_list buffer.
 * Layout: [u32le total size][4 pad][magic][40 pad] then per species:
 * 0x0e + u16le name length + UTF-16LE name, u32le count (n*256+8, the
 * builder's formula, so round-trips are byte-identical), then records
 * (00 0c f32x f32z + extra), then optional trailing bytes.
 * Names must be 4..200 ASCII chars. extra defaults to 0xAA fill
 * (4 bytes for LRDZ stride 14, 6 for RIKI stride 16).
 */
export function buildTreeListBuf(species: FixSpecies[], magic: "LRDZ" | "RIKI" = "LRDZ"): Uint8Array<ArrayBuffer> {
  const stride = magic === "RIKI" ? 16 : 14;
  const extraLen = stride - 10;
  const parts: number[] = [0, 0, 0, 0, 1, 1, 1, 1];
  for (const ch of magic) parts.push(ch.charCodeAt(0));
  for (let i = 0; i < 40; i++) parts.push(1);   // pad: keeps size-field discovery away from record bytes
  for (const s of species) {
    if (s.name.length < 4 || s.name.length > 200) throw new Error("species name must be 4..200 chars");
    parts.push(0x0e, s.name.length & 0xff, s.name.length >> 8);
    for (const ch of s.name) parts.push(ch.charCodeAt(0), 0);
    const count = s.trees.length * 256 + 8;
    parts.push(count & 0xff, (count >> 8) & 0xff, (count >> 16) & 0xff, (count >> 24) & 0xff);
    for (const t of s.trees) {
      parts.push(0x00, 0x0c);
      const f = new DataView(new ArrayBuffer(8));
      f.setFloat32(0, t.x, true); f.setFloat32(4, t.z, true);
      for (let i = 0; i < 8; i++) parts.push(f.getUint8(i));
      const extra = t.extra ?? Array(extraLen).fill(0xaa);
      if (extra.length !== extraLen) throw new Error(`extra must be ${extraLen} bytes for ${magic}`);
      parts.push(...extra);
    }
    parts.push(...(s.trailing ?? []));
  }
  const out = new Uint8Array(parts);
  new DataView(out.buffer).setUint32(0, out.length, true);   // header size field, rewritten on build
  return out as Uint8Array<ArrayBuffer>;
}

/**
 * Build an LRDZ tree_list with the real files' section-chain structure
 * (modelled byte-for-byte on the vanilla presets): the 42-byte header ends
 * with a section node [80 01 00 02][u32 -> next section][08 u32 count], the
 * last species of each section carries the next section's node in its
 * trailing, and the final species carries the terminal node pointing at EOF.
 */
export function sectionedTreeListBuf(sections: FixSpecies[][]): Uint8Array<ArrayBuffer> {
  const parts: number[] = [0xce, 0xab, 0, 0, 0, 0, 0, 0];
  for (const ch of "LRDZ") parts.push(ch.charCodeAt(0));
  parts.push(0, 0, 0, 0);                  // @12: file size, patched below
  parts.push(0x80, 0x00, 0x00, 0x01);      // root node
  parts.push(0, 0, 0, 0);                  // @20: file size
  parts.push(0x08, 0x03, 0x00, 0x00, 0x00);
  const markers: number[] = [];            // start offset of every section node
  const links: number[] = [];              // offset of the u32 link inside each node
  const pushNode = (cnt: number) => {
    markers.push(parts.length);
    parts.push(0x80, 0x01, 0x00, 0x02);
    links.push(parts.length);
    parts.push(0, 0, 0, 0);                // next-section offset, patched below
    parts.push(0x08, cnt & 0xff, (cnt >> 8) & 0xff, 0, 0);
  };
  pushNode(sections[0].length);            // header is 42 B, like the presets
  sections.forEach((sec, si) => {
    sec.forEach((s, i) => {
      if (s.name.length < 4 || s.name.length > 200) throw new Error("species name must be 4..200 chars");
      parts.push(0x0e, s.name.length & 0xff, s.name.length >> 8);
      for (const ch of s.name) parts.push(ch.charCodeAt(0), 0);
      const count = s.trees.length * 256 + 8;
      parts.push(count & 0xff, (count >> 8) & 0xff, (count >> 16) & 0xff, (count >> 24) & 0xff);
      for (const t of s.trees) {
        parts.push(0x00, 0x0c);
        const f = new DataView(new ArrayBuffer(8));
        f.setFloat32(0, t.x, true); f.setFloat32(4, t.z, true);
        for (let k = 0; k < 8; k++) parts.push(f.getUint8(k));
        parts.push(...(t.extra ?? [0xaa, 0xaa, 0xaa, 0xaa]));
      }
      parts.push(0x00);
      if (i === sec.length - 1) pushNode(si + 1 < sections.length ? sections[si + 1].length : 0);
    });
  });
  const out = new Uint8Array(parts);
  const dv = new DataView(out.buffer);
  links.forEach((lo, i) => dv.setUint32(lo, i + 1 < markers.length ? markers[i + 1] : out.length, true));
  dv.setUint32(12, out.length, true);
  dv.setUint32(20, out.length, true);
  return out as Uint8Array<ArrayBuffer>;
}

/** Minimal uncompressed DDS: h at byte 12, w at 16, bits at 88, pixels from byte 128. */
export function makeDDS(w: number, h: number, bits: 8 | 16 | 24 | 32, pixel: (i: number) => number = i => (i * 37) % 256): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(128 + w * h * (bits / 8));
  const dv = new DataView(out.buffer);
  dv.setUint32(12, h, true);
  dv.setUint32(16, w, true);
  dv.setUint32(88, bits, true);
  for (let i = 0; i < w * h; i++) {
    const v = pixel(i);
    if (bits === 8) out[128 + i] = v & 0xff;
    else if (bits === 16) dv.setUint16(128 + i * 2, v & 0xffff, true);
    else if (bits === 24) out[128 + i * 3] = v & 0xff;
    else out[128 + i * 4] = v & 0xff;
  }
  return out as Uint8Array<ArrayBuffer>;
}

/** Hand-assembled .building_list, independent of the app codec: ESF 0xABCE header,
 * [u32 end][0x0E name][0x0C x,z][0x10 rot][extra...] records, standard 2-name table. */
export function buildBuildingListBuf(recs: { name: string; x: number; z: number; rot?: number; extra?: number[] }[], tag = "LRDZ"): Uint8Array<ArrayBuffer> {
  const names = ["BATTLEFIELD_BUILDING_LIST", "BATTLEFIELD_BUILDING_LIST_BLOCK"];
  const recBytes: number[] = [];
  let off = 0x24;
  for (const r of recs) {
    const len = 4 + 3 + r.name.length * 2 + 9 + 3 + (r.extra?.length ?? 0);
    const b = new Uint8Array(len), dv = new DataView(b.buffer);
    off += len;
    let p = 0;
    dv.setUint32(p, off, true); p += 4;
    b[p] = 0x0e; dv.setUint16(p + 1, r.name.length, true); p += 3;
    for (const ch of r.name) { dv.setUint16(p, ch.charCodeAt(0), true); p += 2; }
    b[p] = 0x0c; dv.setFloat32(p + 1, r.x, true); dv.setFloat32(p + 5, r.z, true); p += 9;
    b[p] = 0x10; dv.setUint16(p + 1, r.rot ?? 0, true); p += 3;
    b.set(r.extra ?? [], p);
    recBytes.push(...b);
  }
  const nameBytes: number[] = [2, 0];
  for (const n of names) { nameBytes.push(n.length & 0xff, n.length >> 8); for (const c of n) nameBytes.push(c.charCodeAt(0)); }
  const header = new Uint8Array(0x24), hv = new DataView(header.buffer);
  hv.setUint32(0, 0xabce, true);
  for (let i = 0; i < 4; i++) header[8 + i] = tag.charCodeAt(i);
  header[0x10] = 0x80; header[0x13] = 1;
  header[0x18] = 0x81; hv.setUint16(0x19, 1, true);
  hv.setUint32(0x0c, off, true); hv.setUint32(0x14, off, true); hv.setUint32(0x1c, off, true);
  hv.setUint32(0x20, recs.length, true);
  return new Uint8Array([...header, ...recBytes, ...nameBytes]) as Uint8Array<ArrayBuffer>;
}

export function defaultBuildingListBuf(): Uint8Array<ArrayBuffer> {
  return buildBuildingListBuf([
    { name: "small_barn_v1", x: 100, z: -50, rot: 4096 },
    { name: "west_euro_hut03", x: -200, z: 300, extra: [0x0a, 0, 0, 0, 0] },
  ]);
}

/** Hand-assembled NTW .rigid_model (independent of the app codec): [u32 nSub], per sub
 * [magic 0x12345678][u32 lod][u8][3 texture names + 3 extra slots as u16 len/utf16/u8 0]
 * [u32 nVert][80B verts, pos f32x3][u32 nIdx][u32 idx], then a 6xf32 bbox trailer. */
export function buildRigidModelBuf(
  subs: { verts: [number, number, number][]; idx: number[]; tex?: string[] }[],
  bbox: number[] = [0, 0, 0, 1, 1, 1],
  extras: string[] = ["", "", ""],
): Uint8Array<ArrayBuffer> {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const u16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
  const f32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); parts.push(...b); };
  u32(subs.length);
  for (const s of subs) {
    u32(0x12345678); u32(5); parts.push(0);
    const names = [...(s.tex ?? ["difftex", "normtex", "glosstex"]), ...extras];
    for (const t of names) { u16(t.length); for (const ch of t) u16(ch.charCodeAt(0)); parts.push(0); }
    u32(s.verts.length);
    for (const [x, y, z] of s.verts) { f32(x); f32(y); f32(z); for (let i = 0; i < 68; i++) parts.push(0); }
    u32(s.idx.length);
    for (const i of s.idx) u32(i);
  }
  for (const v of bbox) f32(v);
  return new Uint8Array(parts) as Uint8Array<ArrayBuffer>;
}

export const DEF_XML = `<?xml version="1.0"?>\n<battlefield base_terrain_width='1024.000000' base_terrain_height='1024.000000'/>`;

export const HEIGHT_XML = `<height_map world_width='1024.000000' world_height='1024.000000' scale='0.600000' bias='-5.000000'/>`;

/** Real-world shape (BATTLE_DEPLOYMENT_AREA_HASH_TABLE root, <centre> tags).
 * Two blocks; block 0 has one zone per alliance. Integer coords so serialize()
 * round-trips byte-identically. */
export const DEPLOY_XML = `<BATTLE_DEPLOYMENT_AREA_HASH_TABLE>
<BATTLE_DEPLOYMENT_AREAS>	<!-- 1v1 Setup-->
<ALLIANCE id='0'>
<deployment_area id='0'><centre x="-200" y="-400"/><width metres="300"/><height metres="150"/><orientation radians="0"/></deployment_area>
</ALLIANCE>
<ALLIANCE id='1'>
<deployment_area id='0'><centre x="200" y="400"/><width metres="300"/><height metres="150"/><orientation radians="0"/></deployment_area>
</ALLIANCE>
</BATTLE_DEPLOYMENT_AREAS>
<BATTLE_DEPLOYMENT_AREAS>
<ALLIANCE id='0'>
<deployment_area id='0'><centre x="-100" y="-300"/><width metres="250"/><height metres="120"/><orientation radians="0.5"/></deployment_area>
</ALLIANCE>
</BATTLE_DEPLOYMENT_AREAS>
</BATTLE_DEPLOYMENT_AREA_HASH_TABLE>`;

export function defaultTreeListBuf(): Uint8Array<ArrayBuffer> {
  return buildTreeListBuf([
    { name: "pine", trees: [{ x: 100, z: -50 }, { x: 20, z: 30 }] },
    { name: "oaktree", trees: [{ x: -80, z: 60 }] },
  ]);
}

export interface MapZipOpts {
  name?: string;
  root?: string;
  /** null omits the file; undefined uses the default fixture */
  def?: string | null;
  heightSettings?: string | null;
  deploy?: string | null;
  treeList?: Uint8Array<ArrayBuffer> | null;
  buildings?: Uint8Array<ArrayBuffer> | null;
  dds?: Uint8Array<ArrayBuffer> | null;
  colourPng?: boolean;
}

/** A complete synthetic map zip as a File, ready for the batch input / loadZipStore. */
export async function makeMapZip(o: MapZipOpts = {}): Promise<File> {
  const root = o.root ?? "mymap/";
  const zip = new JSZip();
  const put = (n: string, v: string | Uint8Array | null | undefined, dflt: string | Uint8Array) => {
    const val = v === undefined ? dflt : v;
    if (val !== null) zip.file(root + n, val);
  };
  put("definition.xml", o.def, DEF_XML);
  put("height_map_0_settings.xml", o.heightSettings, HEIGHT_XML);
  put("deployment_areas.xml", o.deploy, DEPLOY_XML);
  put("bmd.tree_list", o.treeList, defaultTreeListBuf());
  put("bmd_near_buildings.building_list", o.buildings, defaultBuildingListBuf());
  put("height_map_0.dds", o.dds, makeDDS(4, 4, 8));
  if (o.colourPng !== false) zip.file(root + "colour_map_0.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes as Uint8Array<ArrayBuffer>], (o.name ?? "mymap") + ".zip", { type: "application/zip" });
}

/** Replace global Image with one that "loads" (4×4) as soon as src is set. Returns a restore fn. */
export function stubImage(): () => void {
  const Orig = globalThis.Image;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 4;
    height = 4;
    set src(_v: string) { queueMicrotask(() => this.onload?.()); }
  }
  globalThis.Image = FakeImage as unknown as typeof Image;
  return () => { globalThis.Image = Orig; };
}
