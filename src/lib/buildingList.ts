import type { Building, BuildingList } from "../types";

// ---------- .building_list codec (ESF 0xABCE flat record block) ----------
// Independently derived and byte-identical-verified against 243 preset files
// (426,850 records; both LRDZ and RIKI header tags, node versions 1 and 2,
// records with and without the trailing 0x0A f32). Header bytes, per-record
// trailing bytes and the name table are preserved verbatim; only offsets,
// count, names, coords and rotation are rewritten on build.

export function parseBuildingList(buf: ArrayBufferLike): BuildingList {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 0x24 || dv.getUint32(0, true) !== 0xabce) throw new Error("not a building_list (bad magic)");
  const namesOff = dv.getUint32(0x0c, true);
  if (b[0x10] !== 0x80 || b[0x18] !== 0x81) throw new Error("unexpected node layout");
  if (dv.getUint32(0x14, true) !== namesOff || dv.getUint32(0x1c, true) !== namesOff || namesOff > b.length)
    throw new Error("offset header mismatch");
  const count = dv.getUint32(0x20, true);
  const header = b.slice(0, 0x24);
  const records: Building[] = [];
  let p = 0x24;
  for (let i = 0; i < count; i++) {
    const end = dv.getUint32(p, true);
    if (end <= p || end > namesOff || b[p + 4] !== 0x0e) throw new Error(`record ${i}: bad frame @${p}`);
    const nlen = dv.getUint16(p + 5, true);
    // the name + coord(9) + angle(3) nodes must fit inside the declared frame,
    // or a corrupt nlen would silently read the next record / name table
    if (p + 7 + nlen * 2 + 12 > end) throw new Error(`record ${i}: nodes overrun the record frame`);
    let name = "";
    for (let k = 0; k < nlen; k++) name += String.fromCharCode(dv.getUint16(p + 7 + k * 2, true));
    let q = p + 7 + nlen * 2;
    if (b[q] !== 0x0c) throw new Error(`record ${i}: no coord node`);
    const x = dv.getFloat32(q + 1, true), z = dv.getFloat32(q + 5, true);
    q += 9;
    if (b[q] !== 0x10) throw new Error(`record ${i}: no angle node`);
    const rot = dv.getUint16(q + 1, true);
    q += 3;
    records.push({ name, x, z, rot, extra: b.slice(q, end) });
    p = end;
  }
  if (p !== namesOff) throw new Error("records do not end at the name table");
  return { header, records, nameTable: b.slice(namesOff) };
}

export function buildBuildingList(t: BuildingList): Uint8Array<ArrayBuffer> {
  let size = 0x24;
  for (const r of t.records) size += 4 + 3 + r.name.length * 2 + 9 + 3 + r.extra.length;
  const namesOff = size;
  const out = new Uint8Array(size + t.nameTable.length);
  const dv = new DataView(out.buffer);
  out.set(t.header, 0);
  dv.setUint32(0x0c, namesOff, true); dv.setUint32(0x14, namesOff, true); dv.setUint32(0x1c, namesOff, true);
  dv.setUint32(0x20, t.records.length, true);
  let p = 0x24;
  for (const r of t.records) {
    dv.setUint32(p, p + 4 + 3 + r.name.length * 2 + 9 + 3 + r.extra.length, true); p += 4;
    out[p] = 0x0e; dv.setUint16(p + 1, r.name.length, true); p += 3;
    for (let k = 0; k < r.name.length; k++) { dv.setUint16(p, r.name.charCodeAt(k), true); p += 2; }
    out[p] = 0x0c; dv.setFloat32(p + 1, r.x, true); dv.setFloat32(p + 5, r.z, true); p += 9;
    out[p] = 0x10; dv.setUint16(p + 1, r.rot, true); p += 3;
    out.set(r.extra, p); p += r.extra.length;
  }
  out.set(t.nameTable, p);
  return out as Uint8Array<ArrayBuffer>;
}
