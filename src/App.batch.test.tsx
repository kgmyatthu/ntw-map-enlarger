import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import JSZip from "jszip";
import App from "./App";
import { makeMapZip, stubImage } from "./test/fixtures";

// Component tests for the batch-processing side of src/App.tsx:
// zip input -> processBatch (auto ×2 height scale + one cluster fill pass)
// -> always-visible grid panel / per-map controls (deploy shift, height
// scale) -> single + bulk export.

// jsdom's TextEncoder returns a Uint8Array from another realm, which JSZip's
// `instanceof Uint8Array` data check rejects at generateAsync time (browser
// TextEncoder is same-realm, so this is purely a test-environment fix).
const OrigTextEncoder = globalThis.TextEncoder;
class RealmSafeTextEncoder extends OrigTextEncoder {
  override encode(input?: string) {
    return new Uint8Array(super.encode(input));
  }
}

let restoreImage: () => void;
let downloads: string[];

beforeEach(() => {
  globalThis.TextEncoder = RealmSafeTextEncoder as typeof TextEncoder;
  restoreImage = stubImage();
  downloads = [];
  // download() creates an <a> and clicks it; capture the name instead of navigating
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});

afterEach(() => {
  globalThis.TextEncoder = OrigTextEncoder;
  restoreImage();
  vi.restoreAllMocks();
});

const zipInput = (container: HTMLElement) =>
  container.querySelector('input[accept=".zip"]') as HTMLInputElement;

const loadedStatus = /Loaded \d+ files, base terrain 1024 m\. trees ✓, deployment ✓\./;

it("processes a single zip: grid tile, auto-filled species counts, tile click re-views", async () => {
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [await makeMapZip()] } });

  await screen.findByText(/Batch processed 1\/1 maps/);

  // grid tile badge: 3 fixture trees + 5 auto-cluster (suggested = 3·(2²−1)·0.5)
  expect(screen.getByText("8t")).toBeTruthy();
  // auto-view: sidebar title shows the map name with [i/n]
  expect(screen.getByText("mymap [1/1]")).toBeTruthy();

  // species sidebar: cluster fill splits randomly but totals 12
  const n = (s: string) => Number(screen.getByText(s).parentElement!.textContent!.slice(s.length));
  expect(n("pine")).toBeGreaterThanOrEqual(2);
  expect(n("oaktree")).toBeGreaterThanOrEqual(1);
  expect(n("pine") + n("oaktree")).toBe(8);

  // deployment loaded: block selector shows 1v1 for block 1 (fixture block 0)
  expect(screen.getByText("1: 1v1")).toBeTruthy();

  // grid panel visible with a generated thumbnail
  expect(container.querySelector('img[src^="data:image/png"]')).toBeTruthy();

  // clicking the grid tile re-views it -> "Loaded N files" style status
  fireEvent.click(screen.getByText("mymap"));
  await screen.findByText(loadedStatus);
});

it("corrupt zip: ✗ log entry and 'Batch: no maps processed.'", async () => {
  const { container } = render(<App />);
  const bad = new File([new Uint8Array([1, 2, 3])], "bad.zip");
  fireEvent.change(zipInput(container), { target: { files: [bad] } });

  await screen.findByText("Batch: no maps processed.");
  expect(screen.getByText(/✗ bad\.zip: .+/)).toBeTruthy();
  expect(screen.queryByText("review")).toBeNull();
});

it("zip without definition.xml still processes (def rewrite skipped)", async () => {
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [await makeMapZip({ name: "nodef", def: null })] } });

  await screen.findByText(/Batch processed 1\/1 maps/, undefined, { timeout: 4000 });
  expect(screen.getByText("nodef [1/1]")).toBeTruthy();
});

it("mixed good+bad batch: ✓ log line with counts + scale note, then 'Batch processed 1/2'", async () => {
  const good = await makeMapZip();
  const bad = new File([new Uint8Array([1, 2, 3])], "bad.zip");
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [good, bad] } });

  // the log is only rendered while no bundles exist; catch it while file 2 fails
  // largest group push: block-1 zone rides its centroid ray until y binds (t≈434)
  await screen.findByText(/✓ mymap\.zip: ×2, 8 trees \(5 auto\), 3 zones \+434m, scale 0\.600000→1\.200000/, undefined, { timeout: 4000 });

  await screen.findByText(/Batch processed 1\/2 maps/);
  expect(screen.getByText("8t")).toBeTruthy();
  expect(screen.getByText("mymap [1/1]")).toBeTruthy(); // 1 bundle survived
});

it("export ALL dedups duplicate internal roots (_2 suffix) and marks all bundles exported", async () => {
  // both zips use the default internal root "mymap/"
  const a = await makeMapZip({ name: "alpha" });
  const b = await makeMapZip({ name: "beta" });
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [a, b] } });
  await screen.findByText(/Batch processed 2\/2 maps/);

  const fileSpy = vi.spyOn(JSZip.prototype, "file");
  fireEvent.click(screen.getByText("export ALL"));

  await screen.findByText(/Bulk export: 2 maps in one zip/);
  expect(downloads).toContain("batch_enlarged_x2.zip");

  const paths = fileSpy.mock.calls.map(c => c[0] as string);
  expect(paths).toContain("mymap/definition.xml");
  expect(paths).toContain("mymap_2/definition.xml");
  // second bundle's whole tree went under the deduped root
  expect(paths.filter(p => p.startsWith("mymap_2/")).length).toBe(paths.filter(p => p.startsWith("mymap/")).length);

  // both grid tiles flipped from tree-count badge to exported
  expect(screen.queryByText("8t")).toBeNull();
  expect(screen.getAllByText("exported").length).toBeGreaterThanOrEqual(2);
});

it("'Export current map zip' exports with enlarged size in the name and marks the bundle", async () => {
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [await makeMapZip()] } });
  await screen.findByText(/Batch processed 1\/1 maps/);

  fireEvent.click(screen.getByText("Export current map zip"));
  await screen.findByText(/Exported\. Size\/link fields rewritten/);

  // mapName "mymap [1/1]" -> "mymap", enlarged 1024*2 -> mymap_2048.zip
  expect(downloads).toContain("mymap_2048.zip");
  expect(screen.queryByText("8t")).toBeNull();
  expect(screen.getAllByText("exported").length).toBeGreaterThanOrEqual(1);
});

it("grid panel is always visible; clicking a tile views that bundle (syncs the previous)", async () => {
  const a = await makeMapZip({ name: "alpha", root: "alpha/" });
  const b = await makeMapZip({ name: "beta", root: "beta/" });
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [a, b] } });
  await screen.findByText(/Batch processed 2\/2 maps/);

  // one tree-count badge per tile, no toggle needed
  expect(screen.getAllByText("8t")).toHaveLength(2);
  expect(screen.getByText("alpha [1/2]")).toBeTruthy(); // first bundle auto-viewed

  // clicking the second tile calls viewBundle(1): first bundle is synced back, no crash
  fireEvent.click(screen.getByText("beta"));
  await screen.findByText("beta [2/2]");
  await screen.findByText(loadedStatus);
  // grid stays visible after picking a tile
  expect(screen.getAllByText("8t")).toHaveLength(2);
});

it("headroom change re-shifts all maps live and regenerates thumbnails", async () => {
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [await makeMapZip()] } });
  await screen.findByText(/Batch processed 1\/1 maps/);

  const headroomInput = screen.getByDisplayValue("200") as HTMLInputElement;
  fireEvent.change(headroomInput, { target: { value: "250" } });

  await screen.findByText(/Deployment headroom 250 m: zones pushed back per map — grid \+ viewer updated\./);
  expect(headroomInput.value).toBe("250");
  // viewer reloaded the current bundle with the shifted deployment
  expect(screen.getByText("mymap [1/1]")).toBeTruthy();
  // grid thumbnail still present after regeneration
  expect(container.querySelector('img[src^="data:image/png"]')).toBeTruthy();
});

it("headroom and height scale before any batch are no-ops", () => {
  render(<App />);
  fireEvent.change(screen.getByDisplayValue("200"), { target: { value: "123" } });
  fireEvent.change(screen.getByPlaceholderText("keep"), { target: { value: "5" } });
  // no bundles / no files -> both bail out, status untouched
  expect(screen.getByText("Import a map folder zip to begin.")).toBeTruthy();
  expect((screen.getByPlaceholderText("keep") as HTMLInputElement).value).toBe("5");
  expect((screen.getByDisplayValue("123") as HTMLInputElement)).toBeTruthy();
});

it("height scale: set 0.9, ignore non-numeric, blank restores the original", async () => {
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [await makeMapZip()] } });
  await screen.findByText(/Batch processed 1\/1 maps/);

  // original scale from the fixture height settings is displayed
  expect(screen.getByText(/orig 0\.600000/)).toBeTruthy();

  const scale = screen.getByPlaceholderText("keep") as HTMLInputElement;
  // import auto-applied 2x of the original scale into the box
  expect(scale.value).toBe("1.200000");
  fireEvent.change(scale, { target: { value: "0.9" } });
  await screen.findByText(/Height scale=0\.9 set on THIS map's 1 LOD files \(per-map; blank restores 0\.600000\)\./);

  // non-numeric input is ignored (status unchanged)
  fireEvent.change(scale, { target: { value: "abc" } });
  expect(screen.getByText(/Height scale=0\.9 set/)).toBeTruthy();

  // blank restores the map's own original scale
  fireEvent.change(scale, { target: { value: "" } });
  await screen.findByText(/Height scale restored to original \(0\.600000\) on this map\./);
});

it("factor buttons toggle before any load", () => {
  render(<App />);
  const b15 = screen.getByText(/×1\.5 → 3072/); // labels from default baseSize 2048
  const b2 = screen.getByText(/×2 → 4096/);
  const pressed = b2.style.background; // ×2 is the default factor
  expect(b15.style.background).not.toBe(pressed);
  expect(screen.getByText(/patches the UV divisor to ×2/)).toBeTruthy();

  fireEvent.click(b15);
  expect(b15.style.background).toBe(pressed);
  expect(b2.style.background).not.toBe(pressed);
  expect(screen.getByText(/patches the UV divisor to ×1\.5/)).toBeTruthy();
});

it("factor switch after import re-processes the batch: fill target + height scale adapt", async () => {
  const { container } = render(<App />);
  fireEvent.change(zipInput(container), { target: { files: [await makeMapZip()] } });
  await screen.findByText(/Batch processed 1\/1 maps/);
  expect(screen.getByText("8t")).toBeTruthy();   // ×2: 3 base + 5 auto

  // labels recomputed from the loaded base size 1024
  fireEvent.click(screen.getByText(/×1\.5 → 1536/));

  // ×1.5: auto fill round(3·(1.5²−1)·0.5) = 2 -> 5 trees, auto scale 0.6·1.5
  await screen.findByText("5t");
  expect((screen.getByPlaceholderText("keep") as HTMLInputElement).value).toBe("0.900000");
  expect(screen.getByText("mymap [1/1]")).toBeTruthy();
  expect(screen.getByText(/patches the UV divisor to ×1\.5/)).toBeTruthy();

  // and back to ×2
  fireEvent.click(screen.getByText(/×2 → 2048/));
  await screen.findByText("8t");
  expect((screen.getByPlaceholderText("keep") as HTMLInputElement).value).toBe("1.200000");
});
