import type { Tree, Species, TreeList } from "../types";

// ---------- tree_list codec (LRDZ 14B / RIKI 16B records) ----------
// Ported from byte-identical-verified Python (43 tree lists round-tripped).
export function parseTreeList(buf: ArrayBufferLike): TreeList {
  const d = new Uint8Array(buf);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const magic = String.fromCharCode(d[8], d[9], d[10], d[11]);
  const stride = magic === "RIKI" ? 16 : 14;
  const starts: { off: number; len: number }[] = [];
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
  const species: Species[] = [];
  for (let s = 0; s < starts.length; s++) {
    const { off, len } = starts[s];
    let name = "";
    for (let k = 0; k < len; k++) name += String.fromCharCode(d[off + 3 + k * 2]);
    const nameBytes = d.slice(off, off + 3 + len * 2);
    const ds = off + 3 + len * 2;
    const end = s + 1 < starts.length ? starts[s + 1].off : d.length;
    const trees: Tree[] = [];
    let j = ds + 4;
    while (j + stride <= end && d[j] === 0x00 && d[j + 1] === 0x0c) {
      trees.push({ x: dv.getFloat32(j + 2, true), z: dv.getFloat32(j + 6, true), extra: d.slice(j + 10, j + stride), isNew: false });
      j += stride;
    }
    species.push({ name, nameBytes, trees, trailing: d.slice(j, end) });
  }
  return { header, species, stride, magic, origBytes: d };
}

export function discoverSizeFields(d: Uint8Array) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const L = d.length, hdr: [number, number][] = [], ftr: [number, number][] = [];
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

export function buildTreeList(parsed: TreeList): Uint8Array<ArrayBuffer> {
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
