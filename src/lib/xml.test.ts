import { describe, it, expect } from "vitest";
import { scaleAttr, setScale, baseTerrainWidth, patchGridFx } from "./xml";

describe("scaleAttr", () => {
  it("scales matching attributes and leaves others alone", () => {
    const xml = "<t base_terrain_width='1024' other='3'/>";
    expect(scaleAttr(xml, "base_terrain_width", 2)).toBe("<t base_terrain_width='2048.000000' other='3'/>");
  });
});

describe("baseTerrainWidth", () => {
  it("parses the width", () => expect(baseTerrainWidth("<x base_terrain_width='1500.5'/>")).toBe(1500.5));
  it("defaults to 2048", () => expect(baseTerrainWidth("<x/>")).toBe(2048));
});

describe("setScale", () => {
  it("rewrites every scale attribute", () => {
    expect(setScale("<a scale='1.5'/><b scale='-2'/>", "3")).toBe("<a scale='3'/><b scale='3'/>");
  });
});

describe("patchGridFx", () => {
  const src = "float2 tex_cm = r.world_position.xz/(terrain_size_meters);\nfloat2 offset = 1.0f / (terrain_size_meters);";
  it("patches both sites at factor 2", () => {
    const r = patchGridFx(src, 2);
    expect(r.txt).toContain("terrain_size_meters * 2.0f");
    expect(r.msg).toMatch(/Patched 1 UV site \+ 1 offset/);
  });
  it("detects an already-patched shader", () => {
    const r = patchGridFx(patchGridFx(src, 2).txt!, 1.5);
    expect(r.txt).toBeNull();
    expect(r.msg).toMatch(/Already patched/);
  });
  it("reports unknown shader versions", () => {
    const r = patchGridFx("something else", 2);
    expect(r.txt).toBeNull();
    expect(r.msg).toMatch(/Pattern not found/);
  });
});
