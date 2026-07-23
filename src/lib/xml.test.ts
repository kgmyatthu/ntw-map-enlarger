import { describe, it, expect } from "vitest";
import { scaleAttr, setScale, shiftBias, baseTerrainWidth, patchGridFx } from "./xml";

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

describe("shiftBias", () => {
  it("negative bias sinks by the enlargement fraction: -5 x1.5 -> -7.5, x2 -> -10", () => {
    expect(shiftBias("<height_map scale='0.6' bias='-5.0'/>", 1.5)).toBe("<height_map scale='0.6' bias='-7.500000'/>");
    expect(shiftBias("<h bias='-5.0'/>", 2)).toBe("<h bias='-10.000000'/>");
  });
  it("positive bias sinks toward zero: 5 x1.5 -> 2.5, x2 -> 0", () => {
    expect(shiftBias("<h bias='5.0'/>", 1.5)).toBe("<h bias='2.500000'/>");
    expect(shiftBias("<h bias='5.0'/>", 2)).toBe("<h bias='0.000000'/>");
  });
  it("no bias attribute: untouched; scale attr not mistaken for bias", () => {
    const xml = "<height_map world_width='1024.000000' scale='0.600000'/>";
    expect(shiftBias(xml, 2)).toBe(xml);
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
