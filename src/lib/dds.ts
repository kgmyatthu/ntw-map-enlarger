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
