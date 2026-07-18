import type { HeightMap } from "../types";

// ---------- DDS heightmap reader (8/16/24/32-bit uncompressed) ----------
export function readDDS(buf: ArrayBufferLike): HeightMap {
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

// ---------- TGA reader (uncompressed/RLE; paletted, 8-bit grey or 24/32-bit BGR(A)) ----------
// Browsers can't decode .tga; NTW's ground_type_map_0 ships as a type-1
// colour-mapped TGA (8-bit indices into a 256-entry 24-bit BGR palette).
export function readTGA(b: Uint8Array): { w: number; h: number; data: Uint8ClampedArray } {
  const idLen = b[0], type = b[2];
  const w = b[12] | (b[13] << 8), h = b[14] | (b[15] << 8);
  const bpp = b[16] >> 3, topDown = (b[17] & 0x20) !== 0;
  const mapped = type === 1 || type === 9;
  const palOff = 18 + idLen, palFirst = b[3] | (b[4] << 8), palSize = b[7] >> 3;
  if (![1, 2, 3, 9, 10, 11].includes(type) || ![1, 3, 4].includes(bpp)
    || (mapped && (bpp !== 1 || ![3, 4].includes(palSize))))
    throw new Error(`unsupported tga (type ${type}, ${b[16]} bpp, ${b[7]}-bit palette)`);
  const px = new Uint8ClampedArray(w * h * 4);
  let o = 18 + idLen + (b[1] ? (b[5] | (b[6] << 8)) * palSize : 0);   // skip colour map if present
  const put = (i: number, p: number) => {
    if (mapped) p = palOff + (b[p] - palFirst) * palSize;
    const c = mapped || bpp >= 3;                // BGR(A) entry vs grey byte
    px[i * 4] = c ? b[p + 2] : b[p];
    px[i * 4 + 1] = c ? b[p + 1] : b[p];
    px[i * 4 + 2] = b[p];
    px[i * 4 + 3] = 255;
  };
  const n = w * h;
  if (type < 8) {
    for (let i = 0; i < n; i++) put(i, o + i * bpp);
  } else {
    for (let i = 0; i < n;) {
      const hdr = b[o++], cnt = (hdr & 0x7f) + 1;
      if (hdr & 0x80) { for (let k = 0; k < cnt; k++) put(i++, o); o += bpp; }   // run packet
      else for (let k = 0; k < cnt; k++) { put(i++, o); o += bpp; }              // raw packet
    }
  }
  if (topDown) return { w, h, data: px };
  // TGA default is bottom-up; flip so row 0 = top, matching the colour map convention
  const row = w * 4, flipped = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) flipped.set(px.subarray(y * row, y * row + row), (h - 1 - y) * row);
  return { w, h, data: flipped };
}
