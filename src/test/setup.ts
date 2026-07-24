import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);

// jsdom has no canvas, ResizeObserver, or object URLs — stub the surface the app touches.
function makeCtx(cv: HTMLCanvasElement): CanvasRenderingContext2D {
  const imageData = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const noop = () => {};
  return {
    canvas: cv,
    fillRect: noop, strokeRect: noop, clearRect: noop, fillText: noop,
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    beginPath: noop, closePath: noop, arc: noop, fill: noop, stroke: noop, setLineDash: noop,
    moveTo: noop, lineTo: noop,
    drawImage: noop, putImageData: noop,
    measureText: (t: string) => ({ width: t.length * 6 }),
    createImageData: imageData,
    getImageData: (_x: number, _y: number, w: number, h: number) => imageData(w, h),
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1,
    font: "", filter: "", imageSmoothingEnabled: true,
  } as unknown as CanvasRenderingContext2D;
}

HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return makeCtx(this);
} as unknown as typeof HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,stub";

URL.createObjectURL = () => "blob:stub";
URL.revokeObjectURL = () => {};

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
