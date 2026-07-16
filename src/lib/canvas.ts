import type JSZip from "jszip";
import type { HeightMap } from "../types";

// ---------- DOM/canvas helpers (kept apart from pure logic for testability) ----------
export function heightToCanvas(hm: HeightMap): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = hm.w; cv.height = hm.h;
  const ctx = cv.getContext("2d")!; // fresh canvas: 2d context is always available
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

/** Draw an image onto an S×S canvas and return its RGBA pixels. */
export function sampleImage(img: CanvasImageSource, S: number): Uint8ClampedArray {
  const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
  const cx = cv.getContext("2d")!; // fresh canvas: 2d context is always available
  cx.drawImage(img, 0, 0, S, S);
  return cx.getImageData(0, 0, S, S).data;
}

export async function makeThumb(colourBytes: Uint8Array<ArrayBuffer> | null, treePts: number[][] | null, zoneRects: number[][] | null, extent: number): Promise<string> {
  const S = 220;
  const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
  const ctx = cv.getContext("2d")!; // fresh canvas: 2d context is always available
  ctx.fillStyle = "#1a2016"; ctx.fillRect(0, 0, S, S);
  if (colourBytes) {
    const img = await new Promise<HTMLImageElement | null>(res => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => res(null);
      im.src = URL.createObjectURL(new Blob([colourBytes]));
    });
    if (img) { ctx.save(); ctx.translate(0, S); ctx.scale(1, -1); ctx.drawImage(img, 0, 0, S, S); ctx.restore(); }
  }
  const w2t = (x: number, z: number): [number, number] => [(x / extent + 0.5) * S, (z / extent + 0.5) * S];
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
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

type SaveTarget = { write(d: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type SavePicker = (opts: object) => Promise<{ createWritable(): Promise<SaveTarget> }>;
export type ExportDir = { getFileHandle(name: string, opts: { create: boolean }): Promise<{ createWritable(): Promise<SaveTarget> }> };

/** Stream a zip chunk-by-chunk into an open writable — no blob storage, so big
 * exports survive a full system drive. Aborts the partial file on failure. */
async function pumpZip(zip: JSZip, w: SaveTarget, onProgress?: (percent: number) => void): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const s = zip.generateInternalStream({ type: "uint8array", streamFiles: true });
      // backpressure: pause the zip stream until each chunk is on disk
      s.on("data", (chunk, meta) => {
        s.pause();
        w.write(chunk).then(() => { onProgress?.(meta.percent); s.resume(); }, reject);
      });
      s.on("error", reject);
      s.on("end", resolve);
      s.resume();
    });
    await w.close();
  } catch (e) {
    await w.abort();
    throw e;   // caller reports (target drive full, permission revoked, ...)
  }
}

/** Pick a destination folder for multi-zip exports (one user gesture covers all
 * parts). null = API unavailable (use saveZip per file), false = user cancelled. */
export async function pickExportDir(): Promise<ExportDir | null | false> {
  const picker = (window as { showDirectoryPicker?: (opts: object) => Promise<ExportDir> }).showDirectoryPicker;
  if (!picker) return null;
  try { return await picker.call(window, { mode: "readwrite" }); }
  catch { return false; }
}

/** Stream a zip into `name` inside a previously picked folder — needs no user gesture. */
export async function saveZipInDir(dir: ExportDir, zip: JSZip, name: string, onProgress?: (percent: number) => void): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await pumpZip(zip, w, onProgress);
}

/** Save a single zip. Chromium: streamed to a user-picked file (one dialog).
 * Elsewhere: blob + anchor fallback. Returns false if the user cancels. */
export async function saveZip(zip: JSZip, name: string, onProgress?: (percent: number) => void): Promise<boolean> {
  const picker = (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) {
    const blob = await zip.generateAsync({ type: "blob", streamFiles: true }, m => onProgress?.(m.percent));
    download(blob, name);
    return true;
  }
  let w: SaveTarget;
  try {
    const h = await picker.call(window, { suggestedName: name, types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }] });
    w = await h.createWritable();
  } catch { return false; }   // user cancelled the save dialog
  await pumpZip(zip, w, onProgress);
  return true;
}
