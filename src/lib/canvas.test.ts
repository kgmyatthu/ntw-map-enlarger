import { describe, it, expect, vi, afterEach } from "vitest";
import { heightToCanvas, sampleImage, makeThumb, download } from "./canvas";
import { stubImage } from "../test/fixtures";
import type { HeightMap } from "../types";

// Local vi.fn-based 2d context stub (the global setup stub is a no-op and
// cannot be asserted on). Installed per test, restored in afterEach.
interface CtxStub {
  ctx: {
    canvas: HTMLCanvasElement | null;
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    fillRect: ReturnType<typeof vi.fn>;
    strokeRect: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    translate: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    scale: ReturnType<typeof vi.fn>;
    drawImage: ReturnType<typeof vi.fn>;
    putImageData: ReturnType<typeof vi.fn>;
    createImageData: ReturnType<typeof vi.fn>;
    getImageData: ReturnType<typeof vi.fn>;
  };
  /** ctx.fillStyle captured at each fillRect call */
  fillStyles: string[];
  /** ctx.strokeStyle captured at each strokeRect call */
  strokeStyles: string[];
}

const origGetContext = HTMLCanvasElement.prototype.getContext;
let installed = false;

function installCtxStub(): CtxStub {
  const fillStyles: string[] = [];
  const strokeStyles: string[] = [];
  const ctx: CtxStub["ctx"] = {
    canvas: null,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    fillRect: vi.fn(() => { fillStyles.push(ctx.fillStyle); }),
    strokeRect: vi.fn(() => { strokeStyles.push(ctx.strokeStyle); }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    createImageData: vi.fn((w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;
      return { width: w, height: h, data };
    }),
  };
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    ctx.canvas = this;
    return ctx;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  installed = true;
  return { ctx, fillStyles, strokeStyles };
}

afterEach(() => {
  if (installed) {
    HTMLCanvasElement.prototype.getContext = origGetContext;
    installed = false;
  }
  vi.restoreAllMocks();
});

describe("heightToCanvas", () => {
  it("sizes the canvas from the heightmap and puts normalised RGBA pixels", () => {
    const { ctx } = installCtxStub();
    const hm: HeightMap = { w: 2, h: 1, px: new Float32Array([0, 1]) } as HeightMap;
    const cv = heightToCanvas(hm);

    expect(cv.width).toBe(2);
    expect(cv.height).toBe(1);
    expect(ctx.createImageData).toHaveBeenCalledWith(2, 1);
    expect(ctx.putImageData).toHaveBeenCalledTimes(1);
    const [im, px, py] = ctx.putImageData.mock.calls[0];
    expect(px).toBe(0);
    expect(py).toBe(0);
    expect(im).toBe(ctx.createImageData.mock.results[0].value);

    const d: Uint8ClampedArray = im.data;
    // px=0 -> v = 20 -> [20*0.55, 20*0.62, 20*0.5, 255] clamped
    expect(d[0]).toBe(11);
    expect(d[1]).toBe(12); // 12.4 rounds to 12
    expect(d[2]).toBe(10);
    expect(d[3]).toBe(255);
    // px=1 -> v = 255
    expect(d[4]).toBe(140); // 140.25
    expect(d[5]).toBe(158); // 158.1
    expect(d[6]).toBe(128); // 127.5 ties-to-even
    expect(d[7]).toBe(255);
  });

  it("handles a flat heightmap via the rg||1 fallback without NaN", () => {
    const { ctx } = installCtxStub();
    const hm: HeightMap = { w: 2, h: 2, px: new Float32Array([0.5, 0.5, 0.5, 0.5]) } as HeightMap;
    heightToCanvas(hm);

    const [im] = ctx.putImageData.mock.calls[0];
    const d: Uint8ClampedArray = im.data;
    // every pixel: v = round(0/1*235 + 20) = 20
    for (let i = 0; i < 4; i++) {
      expect(d[i * 4]).toBe(11);
      expect(d[i * 4 + 1]).toBe(12);
      expect(d[i * 4 + 2]).toBe(10);
      expect(d[i * 4 + 3]).toBe(255);
      expect(Number.isNaN(d[i * 4])).toBe(false);
    }
  });
});

describe("sampleImage", () => {
  it("draws the image onto an SxS canvas and returns S*S RGBA pixels", () => {
    const { ctx } = installCtxStub();
    const img = document.createElement("canvas") as unknown as CanvasImageSource;
    const S = 8;
    const out = sampleImage(img, S);

    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(img, 0, 0, S, S);
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, S, S);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(out.length).toBe(S * S * 4);
    // exact array from getImageData, not a copy of something else
    expect(out).toBe(ctx.getImageData.mock.results[0].value.data);
    expect(out[5]).toBe(5);
  });
});

describe("makeThumb", () => {
  it("with null colourBytes/treePts/zoneRects only paints background + border and returns the data URL", async () => {
    const { ctx, fillStyles, strokeStyles } = installCtxStub();
    const url = await makeThumb(null, null, null, 1024);

    expect(url).toBe("data:image/png;base64,stub");
    // no image drawing path at all
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.save).not.toHaveBeenCalled();
    expect(ctx.translate).not.toHaveBeenCalled();
    expect(ctx.scale).not.toHaveBeenCalled();
    expect(ctx.restore).not.toHaveBeenCalled();
    // background fill + outer border only
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 220, 220);
    expect(fillStyles).toEqual(["#1a2016"]);
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
    expect(ctx.strokeRect).toHaveBeenCalledWith(0.5, 0.5, 219, 219);
    expect(strokeStyles).toEqual(["#8a9a78"]);
  });

  it("with colourBytes draws the image unflipped (row 0 = +Z belongs at the top, like the game)", async () => {
    const restoreImage = stubImage();
    try {
      const { ctx } = installCtxStub();
      const url = await makeThumb(new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>, null, null, 1024);

      expect(url).toBe("data:image/png;base64,stub");
      expect(ctx.scale).not.toHaveBeenCalled();   // no mirror flip of the image
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
      const [img, dx, dy, dw, dh] = ctx.drawImage.mock.calls[0];
      expect(img).toBeTruthy();
      expect([dx, dy, dw, dh]).toEqual([0, 0, 220, 220]);
    } finally {
      restoreImage();
    }
  });

  it("skips drawing when the colour image fails to load (onerror path)", async () => {
    const Orig = globalThis.Image;
    class ErrImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    globalThis.Image = ErrImage as unknown as typeof Image;
    try {
      const { ctx } = installCtxStub();
      const url = await makeThumb(new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>, null, null, 1024);
      expect(url).toBe("data:image/png;base64,stub");
      expect(ctx.drawImage).not.toHaveBeenCalled();
      expect(ctx.save).not.toHaveBeenCalled();
      expect(ctx.restore).not.toHaveBeenCalled();
    } finally {
      globalThis.Image = Orig;
    }
  });

  it("decimates large tree point sets", async () => {
    const { ctx, fillStyles } = installCtxStub();
    const N = 10000;
    const pts: number[][] = [];
    for (let i = 0; i < N; i++) pts.push([(i % 100) - 50, ((i / 100) | 0) - 50]);
    await makeThumb(null, pts, null, 1024);

    // fillRect calls made while fillStyle was the tree colour
    const treeFills = fillStyles.filter(s => s === "#7ec97e").length;
    expect(treeFills).toBeGreaterThan(0);
    expect(treeFills).toBeLessThan(N / 2); // step = (10000/2500)|0 = 4 -> 2500 rects
    expect(treeFills).toBe(2500);
    // tree rects are 1.2x1.2
    const treeCall = ctx.fillRect.mock.calls[1];
    expect(treeCall[2]).toBeCloseTo(1.2);
    expect(treeCall[3]).toBeCloseTo(1.2);
  });

  it("draws every point when there are few tree points", async () => {
    const { fillStyles } = installCtxStub();
    await makeThumb(null, [[0, 0], [10, 10], [-10, -10]], null, 1024);
    expect(fillStyles.filter(s => s === "#7ec97e").length).toBe(3);
  });

  it("colours points by their species index; missing index falls back to colour 0", async () => {
    const { fillStyles } = installCtxStub();
    await makeThumb(null, [[0, 0, 0], [10, 10, 1], [-10, -10]], null, 1024);
    // background fill + 3 tree fills
    expect(fillStyles.slice(1)).toEqual(["#7ec97e", "#5fb8b8", "#7ec97e"]);
  });

  it("strokes zone rects in blue for alliance 0 and red otherwise, rotated about their centre", async () => {
    const { ctx, strokeStyles } = installCtxStub();
    const extent = 1024;
    const zones = [
      [0, 0, 100, 50, 0],                 // alliance 0, unrotated
      [10, 20, 80, 40, 1, Math.PI / 2],   // alliance 1, rotated 90°
    ];
    await makeThumb(null, null, zones, extent);

    // two zone strokes + final border stroke
    expect(ctx.strokeRect).toHaveBeenCalledTimes(3);
    expect(strokeStyles).toEqual(["#6d9ee0", "#e07d6d", "#8a9a78"]);

    // zone 1: translate to its thumb centre, rotate 0, stroke centred on origin
    const S = 220;
    expect(ctx.translate.mock.calls[0]).toEqual([(0 / extent + 0.5) * S, (0 / extent + 0.5) * S]);
    expect(ctx.rotate.mock.calls[0][0]).toBeCloseTo(0);   // -0 from the mirror negation
    const [a, b, w, h] = ctx.strokeRect.mock.calls[0];
    expect(a).toBeCloseTo((-100 / 2 / extent) * S);
    expect(b).toBeCloseTo((-50 / 2 / extent) * S);
    expect(w).toBeCloseTo((100 / extent) * S);
    expect(h).toBeCloseTo((50 / extent) * S);

    // zone 2 rotates by its NEGATED orientation (mirrored screen y)
    expect(ctx.rotate.mock.calls[1][0]).toBeCloseTo(-Math.PI / 2);
    expect(ctx.save).toHaveBeenCalledTimes(2);
    expect(ctx.restore).toHaveBeenCalledTimes(2);
  });
});

describe("download", () => {
  it("creates an anchor with the blob URL and filename and clicks it", () => {
    let clicked: HTMLAnchorElement | null = null;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
    });
    const urlSpy = vi.spyOn(URL, "createObjectURL");
    const blob = new Blob(["hello"], { type: "application/zip" });

    download(blob, "out.zip");

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(urlSpy).toHaveBeenCalledWith(blob);
    expect(clicked).not.toBeNull();
    expect(clicked!.download).toBe("out.zip");
    expect(clicked!.href).toBe("blob:stub");
  });
});

describe("saveZip", () => {
  const win = window as unknown as Record<string, unknown>;
  afterEach(() => { delete win.showSaveFilePicker; });

  it("streams valid zip bytes to the picked file with backpressure and progress", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("a.txt", new Uint8Array([104, 101, 108, 108, 111])); // "hello"

    const chunks: Uint8Array[] = [];
    let closed = false;
    win.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (d: Uint8Array) => { chunks.push(d.slice()); },
        close: async () => { closed = true; },
        abort: async () => {},
      }),
    });
    const pct: number[] = [];
    const { saveZip } = await import("./canvas");
    expect(await saveZip(zip, "t.zip", p => pct.push(p))).toBe(true);
    expect(closed).toBe(true);
    expect(pct.length).toBeGreaterThan(0);
    expect(pct[pct.length - 1]).toBe(100);

    // round-trip: the streamed bytes reassemble into a readable zip
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    const re = await JSZip.loadAsync(buf);
    expect(Array.from(await re.file("a.txt")!.async("uint8array"))).toEqual([104, 101, 108, 108, 111]);
  });

  it("returns false when the user cancels the save dialog", async () => {
    const JSZip = (await import("jszip")).default;
    win.showSaveFilePicker = async () => { throw new DOMException("cancel", "AbortError"); };
    const { saveZip } = await import("./canvas");
    expect(await saveZip(new JSZip(), "t.zip")).toBe(false);
  });

  it("aborts the file and rethrows when a write fails", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("a.txt", new Uint8Array([1]));
    let aborted = false;
    win.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async () => { throw new Error("disk full"); },
        close: async () => {},
        abort: async () => { aborted = true; },
      }),
    });
    const { saveZip } = await import("./canvas");
    await expect(saveZip(zip, "t.zip")).rejects.toThrow("disk full");
    expect(aborted).toBe(true);
  });
});

describe("pickExportDir / saveZipInDir", () => {
  const win = window as unknown as Record<string, unknown>;
  afterEach(() => { delete win.showDirectoryPicker; });

  it("pickExportDir returns null when the API is unavailable", async () => {
    const { pickExportDir } = await import("./canvas");
    expect(await pickExportDir()).toBeNull();
  });

  it("pickExportDir returns false when the user cancels the folder dialog", async () => {
    win.showDirectoryPicker = async () => { throw new DOMException("cancel", "AbortError"); };
    const { pickExportDir } = await import("./canvas");
    expect(await pickExportDir()).toBe(false);
  });

  it("saveZipInDir creates the named file in the picked folder and streams a valid zip", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("a.txt", new Uint8Array([104, 105])); // "hi"

    const chunks: Uint8Array[] = [];
    let created: string | null = null;
    let closed = false;
    const dir = {
      getFileHandle: async (name: string, opts: { create: boolean }) => {
        created = opts.create ? name : null;
        return {
          createWritable: async () => ({
            write: async (d: Uint8Array) => { chunks.push(d.slice()); },
            close: async () => { closed = true; },
            abort: async () => {},
          }),
        };
      },
    };
    win.showDirectoryPicker = async () => dir;
    const { pickExportDir, saveZipInDir } = await import("./canvas");
    const picked = await pickExportDir();
    expect(picked).toBe(dir);
    await saveZipInDir(picked as typeof dir, zip, "part1.zip");
    expect(created).toBe("part1.zip");
    expect(closed).toBe(true);

    const total = chunks.reduce((a, c) => a + c.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    const re = await JSZip.loadAsync(buf);
    expect(Array.from(await re.file("a.txt")!.async("uint8array"))).toEqual([104, 105]);
  });
});
