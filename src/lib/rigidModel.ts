// ---------- NTW .rigid_model reader (positions only, for the 3D viewport) ----------
// Layout derived from and verified byte-exact against 3081/3260 files of the
// rigidmodels/buildings corpus (exact-EOF + index-bounds + header-bbox oracles):
//   u32 submeshCount
//   per submesh:
//     u32 0x12345678, u32 lodNumber, u8 unknown,
//     3 × (u16 charCount, UTF-16LE name, u8 0)   — diffuse/normal/gloss textures
//     3 × (u16 0, u8 0)                          — three empty extra name slots
//     u32 nVert, nVert × 80-byte vertices        — position f32×3 at +0, y is UP
//     u32 nIdx,  nIdx × u32 triangle indices
//   file trailer: 6 × f32 bounding box
// The ~5% of files with non-empty extra name slots are rejected — callers fall
// back to the block preview. ponytail: positions only; normals/uvs live in the
// other 68 vertex bytes if texturing is ever wanted.

export interface RigidMesh {
  /** merged xyz triples across submeshes; y up, metres */
  verts: Float32Array;
  /** merged triangle indices into verts */
  idx: Uint32Array;
}

const MAX_TRIS = 8000;   // ponytail: heavier than any far-LOD building; reject to block fallback

export function parseRigidModel(buf: ArrayBufferLike): RigidMesh {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 32) throw new Error("too short");
  const nSub = dv.getUint32(0, true);
  if (nSub === 0 || nSub > 64) throw new Error("bad submesh count");
  const parts: { verts: Float32Array; idx: Uint32Array }[] = [];
  let p = 4;
  for (let s = 0; s < nSub; s++) {
    if (p + 9 > b.length || dv.getUint32(p, true) !== 0x12345678) throw new Error(`submesh ${s}: no magic`);
    p += 9;   // magic + lod + unknown byte
    for (let k = 0; k < 6; k++) {   // 3 texture names + 3 (normally empty) extras
      const len = dv.getUint16(p, true); p += 2;
      if (k >= 3 && len !== 0) throw new Error("unknown variant (extra name slot)");
      if (len > 300 || p + len * 2 + 1 > b.length) throw new Error(`submesh ${s}: bad name`);
      p += len * 2 + 1;
    }
    const nVert = dv.getUint32(p, true); p += 4;
    if (nVert === 0 || p + nVert * 80 > b.length) throw new Error(`submesh ${s}: bad vertex count`);
    const verts = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) {
      verts[i * 3] = dv.getFloat32(p, true);
      verts[i * 3 + 1] = dv.getFloat32(p + 4, true);
      verts[i * 3 + 2] = dv.getFloat32(p + 8, true);
      p += 80;
    }
    const nIdx = dv.getUint32(p, true); p += 4;
    if (nIdx % 3 !== 0 || p + nIdx * 4 > b.length) throw new Error(`submesh ${s}: bad index count`);
    const idx = new Uint32Array(nIdx);
    for (let i = 0; i < nIdx; i++) {
      idx[i] = dv.getUint32(p, true); p += 4;
      if (idx[i] >= nVert) throw new Error(`submesh ${s}: index out of range`);
    }
    parts.push({ verts, idx });
  }
  if (p + 24 !== b.length) throw new Error("bad trailer");
  let nv = 0, ni = 0;
  for (const q of parts) { nv += q.verts.length; ni += q.idx.length; }
  if (ni / 3 > MAX_TRIS) throw new Error("too many triangles");
  const verts = new Float32Array(nv), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const q of parts) {
    verts.set(q.verts, vo);
    for (let i = 0; i < q.idx.length; i++) idx[io + i] = q.idx[i] + vo / 3;
    vo += q.verts.length; io += q.idx.length;
  }
  return { verts, idx };
}
