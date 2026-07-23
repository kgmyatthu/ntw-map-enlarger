import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";
import { makeMapZip, stubImage, buildTreeListBuf } from "./test/fixtures";
import type { MapZipOpts } from "./test/fixtures";

// ---------------------------------------------------------------------------
// Viewer/editing tests for src/App.tsx.
//
// Geometry: jsdom canvas defaults to 300x150 and getBoundingClientRect() is
// all zeros, so clientX/clientY ARE canvas coordinates. The initial view is
// zoom 0.16 centred on world (0,0); screen y is MIRRORED (+z up, like the game):
//   world (wx,wz) -> screen (150 + wx*0.16, 75 - wz*0.16).
// The zip goes through the default x2 batch: tree world coords are doubled
// (pine (200,-100) & (40,60), oaktree (-160,120)); deployment zones keep
// their x but get y auto-pushed toward the edge until we raise the headroom
// so far that the computed per-map shift clamps to 0 (zeroShift below).
// ---------------------------------------------------------------------------

const SX = (wx: number) => 150 + wx * 0.16;
const SZ = (wz: number) => 75 - wz * 0.16;

let restoreImage: () => void;
beforeEach(() => { restoreImage = stubImage(); });
afterEach(() => { restoreImage(); vi.restoreAllMocks(); });

async function setup(opts?: MapZipOpts) {
  const utils = render(<App />);
  const zip = await makeMapZip(opts);
  // fill box "0" skips the import auto-fill so tree counts/positions stay the fixture's
  fireEvent.change(screen.getByPlaceholderText("n"), { target: { value: "0" } });
  const zipInput = utils.container.querySelector('input[accept=".zip"]') as HTMLInputElement;
  fireEvent.change(zipInput, { target: { files: [zip] } });
  await screen.findByText(/Batch processed 1\/1/);
  const canvas = utils.container.querySelector("canvas") as HTMLCanvasElement;
  return { container: utils.container, canvas };
}

/** Tree count shown in the sidebar species row. */
const count = (species: string) => {
  const spans = screen.getByText(species).parentElement!.querySelectorAll("span");
  return Number(spans[spans.length - 1].textContent);
};
const undoBtn = () => screen.getByText(/^undo \(/);
const clickTool = (label: string) => fireEvent.click(screen.getByText(label));
const down = (cv: HTMLElement, x: number, y: number, extra: object = {}) =>
  fireEvent.mouseDown(cv, { clientX: x, clientY: y, button: 0, ...extra });
const move = (cv: HTMLElement, x: number, y: number) =>
  fireEvent.mouseMove(cv, { clientX: x, clientY: y });
const up = (cv: HTMLElement, x: number, y: number) =>
  fireEvent.mouseUp(cv, { clientX: x, clientY: y });

/** Headroom 9999 clamps the computed shift to 0 so block-0 zones return to y=-400/400. */
async function zeroShift() {
  fireEvent.change(screen.getByDisplayValue("200"), { target: { value: "9999" } });
  await screen.findByText(/Deployment headroom 9999 m/);
}

/** Select the block-0 alliance-0 zone at world (-200,-400) (shift already 0). */
function selectZone(canvas: HTMLElement) {
  down(canvas, SX(-200), SZ(-400));   // (118, 11)
  up(canvas, SX(-200), SZ(-400));
  return screen.getByText("alliance 0 zone");
}

// ---------------------------------------------------------------- loading --

it("loads a map through the zip input and shows scaled species counts", async () => {
  await setup();
  expect(screen.getByText("mymap [1/1]")).toBeTruthy();
  expect(count("pine")).toBe(2);
  expect(count("oaktree")).toBe(1);
  expect(undoBtn().textContent).toBe("undo (0)");
  fireEvent.click(undoBtn());   // empty undo stack is a no-op
  expect(count("pine")).toBe(2);
});

// ------------------------------------------------------------------ tools --

it("tool buttons toggle the active tool (canvas cursor)", async () => {
  const { canvas } = await setup();
  expect(canvas.style.cursor).toBe("grab");
  for (const label of ["place", "brush", "erase", "zones (drag to move)"]) {
    clickTool(label);
    expect(canvas.style.cursor).toBe("crosshair");
  }
  clickTool("pan");
  expect(canvas.style.cursor).toBe("grab");
});

it("place adds a tree to the selected species and undo reverts it", async () => {
  const { canvas } = await setup();
  clickTool("place");
  down(canvas, 150, 75);        // world (0,0), empty ground
  up(canvas, 150, 75);
  expect(count("pine")).toBe(3);
  expect(count("oaktree")).toBe(1);
  expect(undoBtn().textContent).toBe("undo (1)");
  fireEvent.click(undoBtn());
  expect(count("pine")).toBe(2);
  expect(undoBtn().textContent).toBe("undo (0)");
});

it("place uses the species selected in the sidebar", async () => {
  const { canvas } = await setup();
  fireEvent.click(screen.getByText("oaktree"));   // select species row
  clickTool("place");
  down(canvas, SX(-300), SZ(200));
  up(canvas, SX(-300), SZ(200));
  expect(count("oaktree")).toBe(2);
  expect(count("pine")).toBe(2);
});

it("drag-place adds another tree only after moving > 12 world units", async () => {
  const { canvas } = await setup();
  clickTool("place");
  down(canvas, 150, 75);        // +1 at world (0,0)
  move(canvas, 155, 75);        // world x 31.25, d > 12 -> +1
  expect(count("pine")).toBe(4);
  move(canvas, 156, 75);        // d = 6.25 < 12 -> nothing
  expect(count("pine")).toBe(4);
  up(canvas, 156, 75);
  expect(count("pine")).toBe(4);
});

it("brush stamps density trees per stamp and undo restores counts", async () => {
  const { canvas } = await setup();
  clickTool("brush");
  down(canvas, 150, 75);        // stamp at centre: all 6 points in bounds
  expect(count("pine")).toBe(8);
  move(canvas, 160, 75);        // 62.5 world units > brushR*0.6 -> stamp again
  expect(count("pine")).toBe(14);
  up(canvas, 160, 75);
  fireEvent.click(undoBtn());
  expect(count("pine")).toBe(8);
  fireEvent.click(undoBtn());
  expect(count("pine")).toBe(2);
});

it("erase removes trees within brushR and undo restores them", async () => {
  const { canvas } = await setup();
  clickTool("erase");
  down(canvas, SX(200), SZ(-100));       // (182, 59) on the first pine
  expect(count("pine")).toBe(1);
  expect(count("oaktree")).toBe(1);      // far away, untouched
  move(canvas, SX(40), SZ(60));          // drag-erase the second pine
  expect(count("pine")).toBe(0);
  up(canvas, SX(40), SZ(60));
  fireEvent.click(undoBtn());
  expect(count("pine")).toBe(1);
  fireEvent.click(undoBtn());
  expect(count("pine")).toBe(2);
  expect(count("oaktree")).toBe(1);
});

// ------------------------------------------------------------------ zones --

it("zones tool selects a zone and shows the readout panel", async () => {
  const { canvas } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  selectZone(canvas);
  expect(screen.getByText("alliance 0 zone")).toBeTruthy();
  expect(screen.getByText(/x -200 · y -400/)).toBeTruthy();
  expect(screen.getByText(/300 × 150 m · 0\.0°/)).toBeTruthy();
});

it("dragging moves the zone and undo restores its position", async () => {
  const { canvas, container } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  down(canvas, SX(-200), SZ(-400));       // grab zone centre
  move(canvas, SX(-100), SZ(-350));       // drag by (+100, +50) world units
  up(canvas, SX(-100), SZ(-350));
  // zone drag mutates the ref without a React rerender; force one
  fireEvent.click(container.querySelector("#colour")!);
  expect(screen.getByText(/x -100 · y -350/)).toBeTruthy();
  fireEvent.click(undoBtn());
  expect(screen.getByText(/x -200 · y -400/)).toBeTruthy();
});

it("dragging a corner handle resizes the zone about its centre; undo restores", async () => {
  const { canvas, container } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  selectZone(canvas);
  // zone is 48x24 px at screen (118,139): bottom-right corner handle at (142,151)
  down(canvas, 142, 151);
  move(canvas, 166, 115);     // world (100,-250): |rx|=300, |rz|=150 -> 600 x 300
  up(canvas, 166, 115);
  fireEvent.click(container.querySelector("#colour")!);   // ref mutation -> force rerender
  expect(screen.getByText(/600 × 300 m/)).toBeTruthy();
  fireEvent.click(undoBtn());
  expect(screen.getByText(/300 × 150 m/)).toBeTruthy();
});

it("dragging the rotate knob spins the zone; undo restores orientation", async () => {
  const { canvas, container } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  selectZone(canvas);
  // zone centre at (118, 139); knob now trails the facing arrow: 22px BELOW the edge (118, 139+12+22)
  down(canvas, 118, 173);
  move(canvas, 142, 139);     // pointer due +x of the centre -> o = +pi/2
  up(canvas, 142, 139);
  fireEvent.click(container.querySelector("#colour")!);
  expect(screen.getByText(/90\.0°/)).toBeTruthy();
  fireEvent.click(undoBtn());
  expect(screen.getByText(/0\.0°/)).toBeTruthy();
});

it("dragging a zone onto the opposing alliance's zone sticks at the last valid spot", async () => {
  const { canvas, container } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  down(canvas, SX(-200), SZ(-400));       // grab alliance-0 zone
  move(canvas, SX(200), SZ(400));         // try to drop it dead on the alliance-1 zone
  up(canvas, SX(200), SZ(400));
  fireEvent.click(container.querySelector("#colour")!);
  // every overlapping step was vetoed: the zone never left its origin
  expect(screen.getByText(/x -200 · y -400/)).toBeTruthy();
});

it("a zone cannot be dragged past the playable boundary", async () => {
  const { canvas, container } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  down(canvas, SX(-200), SZ(-400));
  move(canvas, SX(-200), SZ(-1000));   // bottom edge would sit at -1075 < -1024
  up(canvas, SX(-200), SZ(-1000));
  fireEvent.click(container.querySelector("#colour")!);
  expect(screen.getByText(/x -200 · y -400/)).toBeTruthy();
});

it("a zone cannot be dragged onto a zone of its OWN alliance either", async () => {
  const TWO_SAME = `<BATTLE_DEPLOYMENT_AREA_HASH_TABLE>
<BATTLE_DEPLOYMENT_AREAS>
<ALLIANCE id='0'>
<deployment_area id='0'><centre x="-200" y="-400"/><width metres="300"/><height metres="150"/><orientation radians="0"/></deployment_area>
<deployment_area id='1'><centre x="200" y="-400"/><width metres="300"/><height metres="150"/><orientation radians="0"/></deployment_area>
</ALLIANCE>
</BATTLE_DEPLOYMENT_AREAS>
</BATTLE_DEPLOYMENT_AREA_HASH_TABLE>`;
  const { canvas, container } = await setup({ deploy: TWO_SAME });
  await zeroShift();
  clickTool("zones (drag to move)");
  down(canvas, SX(-200), SZ(-400));    // grab the left friendly zone
  move(canvas, SX(150), SZ(-400));     // would overlap its sibling at x=200
  up(canvas, SX(150), SZ(-400));
  fireEvent.click(container.querySelector("#colour")!);
  expect(screen.getByText(/x -200 · y -400/)).toBeTruthy();
});

it("clicking empty ground deselects the zone", async () => {
  const { canvas } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  selectZone(canvas);
  down(canvas, 150, 75);   // world (0,0): outside every block-0 zone
  up(canvas, 150, 75);
  expect(screen.queryByText(/alliance \d zone/)).toBeNull();
});

it("block select and arrow buttons cycle blocks and clear the selection", async () => {
  const { canvas, container } = await setup();
  await zeroShift();
  clickTool("zones (drag to move)");
  selectZone(canvas);
  const select = container.querySelector("select") as HTMLSelectElement;
  expect(select.value).toBe("0");
  fireEvent.change(select, { target: { value: "1" } });
  expect(select.value).toBe("1");
  expect(screen.queryByText(/alliance \d zone/)).toBeNull();
  fireEvent.click(screen.getByText("▶"));      // (1+1)%2 -> block 0
  expect(select.value).toBe("0");
  selectZone(canvas);                          // reselect in block 0
  fireEvent.click(screen.getByText("◀"));      // (0+2-1)%2 -> block 1
  expect(select.value).toBe("1");
  expect(screen.queryByText(/alliance \d zone/)).toBeNull();
});

// ------------------------------------------------------------- pan / zoom --

it("wheel zooms in and out with clamping and the cursor circle drawn", async () => {
  const { canvas } = await setup();
  clickTool("brush");                 // non-pan tool -> cursor circle branch
  move(canvas, 150, 75);              // sets cursor.current
  for (let i = 0; i < 30; i++) fireEvent.wheel(canvas, { deltaY: -100, clientX: 150, clientY: 75 });
  move(canvas, 160, 80);              // draw at max zoom
  for (let i = 0; i < 60; i++) fireEvent.wheel(canvas, { deltaY: 100, clientX: 150, clientY: 75 });
  move(canvas, 140, 70);              // draw at min zoom
  expect(count("pine")).toBe(2);      // still alive, nothing edited
});

it("pan tool, shift-drag and right-button drag pan without editing", async () => {
  const { canvas } = await setup();
  // default pan tool
  down(canvas, 150, 75);
  move(canvas, 170, 95);
  up(canvas, 170, 95);
  // shift-drag while the place tool is active
  clickTool("place");
  down(canvas, 150, 75, { shiftKey: true });
  move(canvas, 120, 60);
  up(canvas, 120, 60);
  // right-button drag while the place tool is active
  down(canvas, 150, 75, { button: 2 });
  move(canvas, 180, 90);
  up(canvas, 180, 90);
  expect(count("pine")).toBe(2);
  expect(count("oaktree")).toBe(1);
  expect(undoBtn().textContent).toBe("undo (0)");
});

it("mouseleave resets the drag so later moves stop painting", async () => {
  const { canvas } = await setup();
  clickTool("place");
  down(canvas, 150, 75);              // +1
  expect(count("pine")).toBe(3);
  // React synthesises onMouseLeave from a native mouseout
  fireEvent.mouseOut(canvas, { clientX: 150, clientY: 75 });
  move(canvas, 200, 75);              // way past 12 world units, drag is gone
  expect(count("pine")).toBe(3);
});

// ----------------------------------------------------------------- layers --

it("layer checkboxes toggle all four layers off and on", async () => {
  const { canvas, container } = await setup();
  const boxes = ["colour", "height", "trees", "deploy"]
    .map(id => container.querySelector("#" + id) as HTMLInputElement);
  for (const b of boxes) { fireEvent.click(b); expect(b.checked).toBe(false); }
  move(canvas, 150, 75);              // draw with every layer off
  for (const b of boxes) { fireEvent.click(b); expect(b.checked).toBe(true); }
  move(canvas, 160, 80);              // draw with every layer back on
  expect(count("pine")).toBe(2);
});

// -------------------------------------------------------------- auto-fill --

it("auto-fill cluster adds the requested trees and undo removes them", async () => {
  await setup();
  fireEvent.change(screen.getByPlaceholderText("5"), { target: { value: "25" } });
  fireEvent.click(screen.getByText("add trees"));
  await screen.findByText(/Added 25 trees \(cluster/);
  expect(count("pine") + count("oaktree")).toBe(28);
  fireEvent.click(undoBtn());
  expect(count("pine")).toBe(2);
  expect(count("oaktree")).toBe(1);
});

it("auto-fill uniform algorithm fills", async () => {
  await setup();
  clickTool("uniform");
  fireEvent.change(screen.getByPlaceholderText("5"), { target: { value: "10" } });
  fireEvent.click(screen.getByText("add trees"));
  await screen.findByText(/Added 10 trees \(uniform/);
  expect(count("pine") + count("oaktree")).toBe(13);
});

it("auto-fill spaced algorithm fills", async () => {
  await setup();
  clickTool("spaced");
  fireEvent.change(screen.getByPlaceholderText("5"), { target: { value: "5" } });
  fireEvent.click(screen.getByText("add trees"));
  await screen.findByText(/Added \d+ trees \(spaced/);
});

it("auto-fill colour algorithm uses the loaded colour map", async () => {
  await setup();
  clickTool("colour");
  fireEvent.change(screen.getByPlaceholderText("5"), { target: { value: "10" } });
  fireEvent.click(screen.getByText("add trees"));
  await screen.findByText(/Added \d+ trees \(colour/);
});

it("blank fill count uses the half-density suggested target", async () => {
  await setup();
  fireEvent.click(screen.getByText("add trees"));   // fillN '' -> suggested round(3·3·0.5) = 5
  await screen.findByText(/Added 5 trees \(cluster/);
  expect(count("pine") + count("oaktree")).toBe(8);
});

it("fillN '0' falls back to the suggested target, not the zero path", async () => {
  await setup();
  fireEvent.change(screen.getByPlaceholderText("5"), { target: { value: "0" } });
  fireEvent.click(screen.getByText("add trees"));
  await screen.findByText(/Added 5 trees \(cluster/);
  expect(screen.queryByText(/Nothing to add/)).toBeNull();
});

it("auto-fill on a map with zero trees reports there is nothing to base on", async () => {
  await setup({
    treeList: buildTreeListBuf([
      { name: "pine", trees: [] },
      { name: "oaktree", trees: [] },
    ]),
  });
  expect(count("pine")).toBe(0);
  fireEvent.click(screen.getByText("add trees"));
  await screen.findByText("No existing trees to base fill on.");
});

// ---------------------------------------------------------------- grid.fx --

const FX_A = "float2 tex_cm = r.world_position.xz/(terrain_size_meters);";
const FX_B = "float2 offset = 1.0f / (terrain_size_meters);";
const FX_SRC = `// shader\n${FX_A}\nvoid main() {}\n${FX_B}\nend\n`;
const FX_PATCHED = FX_SRC
  .replace(FX_A, "float2 tex_cm = r.world_position.xz/(terrain_size_meters * 2.0f);")
  .replace(FX_B, "float2 offset = 1.0f / (terrain_size_meters * 2.0f);");

const feedFx = (container: HTMLElement, text: string) => {
  const input = container.querySelector('input[accept=".fx"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], "grid.fx", { type: "text/plain" })] } });
};

it("grid.fx with both patchable lines downloads the patched shader", async () => {
  const clickSpy = vi.spyOn(HTMLElement.prototype, "click").mockImplementation(() => {});
  const { container } = render(<App />);
  feedFx(container, FX_SRC);
  await screen.findByText(/Patched 1 UV site \+ 1 offset/);
  expect(clickSpy).toHaveBeenCalledTimes(1);   // download anchor clicked
});

it("grid.fx without the pattern reports 'Pattern not found'", async () => {
  const clickSpy = vi.spyOn(HTMLElement.prototype, "click").mockImplementation(() => {});
  const { container } = render(<App />);
  feedFx(container, "totally different shader source");
  await screen.findByText(/Pattern not found/);
  expect(clickSpy).not.toHaveBeenCalled();
});

it("feeding the patched output back reports 'Already patched'", async () => {
  const clickSpy = vi.spyOn(HTMLElement.prototype, "click").mockImplementation(() => {});
  const { container } = render(<App />);
  feedFx(container, FX_PATCHED);
  await screen.findByText(/Already patched/);
  expect(clickSpy).not.toHaveBeenCalled();
});
