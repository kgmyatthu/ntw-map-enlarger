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

export const DEF_XML = `<?xml version="1.0"?>\n<battlefield base_terrain_width='1024.000000' base_terrain_height='1024.000000'/>`;

export const HEIGHT_XML = `<height_map world_width='1024.000000' world_height='1024.000000' scale='0.600000'/>`;

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
