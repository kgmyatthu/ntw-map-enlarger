import { describe, it, expect } from "vitest";
import { parseDeployment, serializeDeployment, autoShiftZones, zonesOverlap, zoneInBounds } from "./deployment";
import { DEPLOY_XML } from "../test/fixtures";
import type { Zone } from "../types";

describe("parseDeployment", () => {
  it("parses the DEPLOY_XML fixture: 3 zones across 2 blocks with alliances and geometry", () => {
    const dep = parseDeployment(DEPLOY_XML);
    expect(dep.zones).toHaveLength(3);
    expect(dep.nBlocks).toBe(2);
    expect(dep.changed).toBe(false);
    expect(dep.zones.map(z => z.block)).toEqual([0, 0, 1]);
    expect(dep.zones.map(z => z.alliance)).toEqual([0, 1, 0]);
    const [a, b, c] = dep.zones;
    expect([a.x, a.y, a.w, a.h, a.o]).toEqual([-200, -400, 300, 150, 0]);
    expect([b.x, b.y, b.w, b.h, b.o]).toEqual([200, 400, 300, 150, 0]);
    expect([c.x, c.y, c.w, c.h, c.o]).toEqual([-100, -300, 250, 120, 0.5]);
    // segs alternate raw / zone: raw, z, raw, z, raw, z, raw
    expect(dep.segs).toHaveLength(7);
    expect(dep.segs[0].raw).toBeDefined();
    expect(dep.segs[1].zone).toBe(a);
    expect(dep.segs[3].zone).toBe(b);
    expect(dep.segs[5].zone).toBe(c);
    expect(dep.segs[6].raw).toBeDefined();
  });

  it("round-trips the fixture byte-identically through serializeDeployment", () => {
    expect(serializeDeployment(parseDeployment(DEPLOY_XML))).toBe(DEPLOY_XML);
  });

  it("parses the real single-quoted <centre> preset format (verbatim game snippet)", () => {
    const xml = `<BATTLE_DEPLOYMENT_AREA_HASH_TABLE>
	<BATTLE_DEPLOYMENT_AREAS>
		<ALLIANCE id='0'>
			<deployment_area id='0'>
				<centre x='0.000000' y='900.000000'/>
				<width metres='2000.000000'/>
				<height metres='200.000000'/>
				<orientation radians='3.142'/>
			</deployment_area>
		</ALLIANCE>
		<ALLIANCE id='1'>
			<deployment_area id='0'>
				<centre x='0.000000' y='-900.000000'/>
				<width metres='2000.000000'/>
				<height metres='200.000000'/>
				<orientation radians='0'/>
			</deployment_area>
		</ALLIANCE>
	</BATTLE_DEPLOYMENT_AREAS>
</BATTLE_DEPLOYMENT_AREA_HASH_TABLE>`;
    const dep = parseDeployment(xml);
    expect(dep.zones).toHaveLength(2);
    const [a, b] = dep.zones;
    expect([a.x, a.y, a.w, a.h, a.o, a.alliance]).toEqual([0, 900, 2000, 200, 3.142, 0]);
    expect([b.x, b.y, b.w, b.h, b.o, b.alliance]).toEqual([0, -900, 2000, 200, 0, 1]);
    // serialize normalises number formatting ("0.000000" -> "0") but keeps the
    // single-quote style and every value; a re-parse sees identical zones
    const out = serializeDeployment(dep);
    expect(out).toContain(`<centre x='0' y='900'/>`);
    expect(out).toContain(`<orientation radians='3.142'/>`);
    expect(parseDeployment(out).zones).toEqual(dep.zones.map(z => ({ ...z, seg: expect.any(String) })));
  });

  it("normalises European decimal commas in either quote style before parsing", () => {
    const xml = `<deployment scale='1,5' other="2,25">
<BATTLE_DEPLOYMENT_AREAS>
<ALLIANCE id='0'>
<deployment_area><centre x="10" y="-20"/><width metres="30"/><height metres="40"/><orientation radians="0"/></deployment_area>
</ALLIANCE>
</BATTLE_DEPLOYMENT_AREAS>
</deployment>`;
    const dep = parseDeployment(xml);
    // the commas became dots in the retained raw text
    const out = serializeDeployment(dep);
    expect(out).toContain("scale='1.5'");
    expect(out).toContain('other="2.25"');
    expect(dep.zones).toHaveLength(1);
    expect(dep.zones[0].x).toBe(10);
  });

  it("normalises negative comma values like id='-12,5'", () => {
    const dep = parseDeployment(`<a id='-12,5'></a>`);
    expect(dep.segs[0].raw).toBe(`<a id='-12.5'></a>`);
  });

  it("defaults missing x/y/width/height/orientation to 0", () => {
    const xml = `<deployment_area><centre/></deployment_area>`;
    const dep = parseDeployment(xml);
    expect(dep.zones).toHaveLength(1);
    const z = dep.zones[0];
    expect([z.x, z.y, z.w, z.h, z.o]).toEqual([0, 0, 0, 0, 0]);
  });

  it("still accepts the legacy <region x=..> tag", () => {
    const xml = `<deployment_area><region x="1" y="2"/></deployment_area>`;
    const dep = parseDeployment(xml);
    expect([dep.zones[0].x, dep.zones[0].y]).toEqual([1, 2]);
  });

  it("reports nBlocks 1 when there is no BATTLE_DEPLOYMENT_AREAS element", () => {
    const xml = `<deployment><deployment_area><centre x="1" y="2"/></deployment_area></deployment>`;
    const dep = parseDeployment(xml);
    expect(dep.nBlocks).toBe(1);
    expect(dep.zones[0].block).toBe(0);
    expect(dep.zones[0].alliance).toBe(0);
  });

  it("yields no zones and a single raw seg equal to the whole text when no deployment_area exists", () => {
    const xml = `<deployment><nothing/></deployment>`;
    const dep = parseDeployment(xml);
    expect(dep.zones).toEqual([]);
    expect(dep.segs).toEqual([{ raw: xml }]);
    expect(dep.nBlocks).toBe(1);
    expect(serializeDeployment(dep)).toBe(xml);
  });
});

describe("serializeDeployment", () => {
  it("rewrites x/y/width/height of a mutated zone with +v.toFixed(1) formatting", () => {
    const dep = parseDeployment(DEPLOY_XML);
    const z = dep.zones[0];
    z.x = 12;        // integer stays integer: "12"
    z.y = 12.34;     // rounds to one decimal: "12.3"
    z.w = -7.5;      // -> "-7.5"
    z.h = 150.0;     // -> "150"
    const out = serializeDeployment(dep);
    expect(out).toContain(`<centre x="12" y="12.3"/><width metres="-7.5"/><height metres="150"/>`);
    // other zones and surrounding text untouched
    expect(out).toContain(`<centre x="200" y="400"/>`);
    expect(out).toContain(`<centre x="-100" y="-300"/><width metres="250"/><height metres="120"/><orientation radians="0.5"/>`);
    expect(out.startsWith("<BATTLE_DEPLOYMENT_AREA_HASH_TABLE>")).toBe(true);
    expect(out.endsWith("</BATTLE_DEPLOYMENT_AREA_HASH_TABLE>")).toBe(true);
  });

  it("rewrites orientation with 3-decimal formatting when zone.o is mutated", () => {
    const dep = parseDeployment(DEPLOY_XML);
    dep.zones[2].o = 1.7554;
    const out = serializeDeployment(dep);
    expect(out).toContain(`<orientation radians="1.755"/>`);
    expect(out).not.toContain(`radians="0.5"`);
  });

  it("ignores the changed flag entirely", () => {
    const dep = parseDeployment(DEPLOY_XML);
    dep.zones[0].x = 999;
    dep.changed = false;   // still serialized with the new value
    expect(serializeDeployment(dep)).toContain(`x="999"`);
    dep.zones[0].x = -200; // restore; changed=true must not alter output
    dep.changed = true;
    expect(serializeDeployment(dep)).toBe(DEPLOY_XML);
  });
});

describe("autoShiftZones", () => {
  const mk = (x: number, y: number, w: number, h: number, o = 0, block = 0, alliance = 0): Zone =>
    ({ x, y, w, h, o, block, alliance, seg: "" } as Zone);

  it("pushes a centred group straight down the battle axis to headroom from the edge", () => {
    const z = [mk(0, -400, 300, 150)];
    expect(autoShiftZones(z, 2048, 200)).toBe(349);   // (1024-200-75) - 400
    expect([z[0].x, z[0].y]).toEqual([0, -749]);
    expect([z[0].x0, z[0].y0]).toEqual([0, -400]);    // bases captured
  });

  it("pushes an off-axis zone along its own ray and stops at the first edge it meets", () => {
    const z = [mk(600, -400, 300, 150)];
    autoShiftZones(z, 2048, 200);
    // x edge binds: right side lands on 1024-200 exactly; y stays inside its bound
    expect(z[0].x + 150).toBeCloseTo(824, 0);
    expect(z[0].x + 150).toBeLessThanOrEqual(824.05);
    expect(z[0].y - 75).toBeGreaterThanOrEqual(-824.05);
    expect(z[0].y).toBeLessThan(-400);   // moved outward in y too
  });

  it("(block, alliance) groups shift independently: a deep zone elsewhere no longer clamps", () => {
    const deep = mk(0, -700, 100, 100, 0, 0, 0);
    const shallow = mk(0, -100, 100, 100, 0, 1, 0);
    autoShiftZones([deep, shallow], 2048, 200);
    // each reaches its own edge-minus-headroom instead of sharing the deep zone's tiny shift
    expect(deep.y).toBe(-774);
    expect(shallow.y).toBe(-774);
  });

  it("moves a group rigidly: relative zone offsets are preserved", () => {
    const a = mk(0, -600, 100, 100), b = mk(100, -400, 100, 100);
    autoShiftZones([a, b], 2048, 200);
    expect(b.x - a.x).toBeCloseTo(100, 5);
    expect(b.y - a.y).toBeCloseTo(200, 5);
    expect(a.y).toBe(-774);   // deepest zone of the group lands on the bound
  });

  it("accounts for rotation via the bounding box (o=90deg swaps w and h)", () => {
    const straight = [mk(0, -400, 300, 150)], rotated = [mk(0, -400, 300, 150, Math.PI / 2)];
    autoShiftZones(straight, 2048, 100);
    autoShiftZones(rotated, 2048, 100);
    expect(straight[0].y - rotated[0].y).toBeCloseTo(-75, 5);   // hy 75 vs 150
  });

  it("is absolute from the captured bases, not cumulative, and clamps to 0", () => {
    const z = [mk(0, -400, 300, 150)];
    autoShiftZones(z, 2048, 200);
    autoShiftZones(z, 2048, 200);
    expect(z[0].y).toBe(-749);
    autoShiftZones(z, 2048, 9999);   // headroom beyond the map -> shift 0 -> back to base
    expect([z[0].x, z[0].y]).toEqual([0, -400]);
  });

  it("near-centre groups fall back to the y axis instead of flinging along a noise ray", () => {
    const z = [mk(10, 0, 100, 50)];
    expect(autoShiftZones(z, 2048, 250)).toBe(749);   // 1024-250-25, y0=0 counts as positive
    expect([z[0].x, z[0].y]).toEqual([10, 749]);
  });

  it("returns 0 for an empty zone list", () => {
    expect(autoShiftZones([], 2048, 100)).toBe(0);
  });

  it("scales a block's push back so opposing zones never overlap (converging rays)", () => {
    // both alliances on the same side: both groups push -y, the shallow one
    // would otherwise plough through the deep one
    const a = mk(0, -300, 200, 100, 0, 0, 0);
    const b = mk(0, -600, 200, 100, 0, 0, 1);
    autoShiftZones([a, b], 2048, 200);
    expect(zonesOverlap(a, b)).toBe(false);
    expect(a.y).toBeLessThan(-300);                          // still pushed outward
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(100); // >= sum of half-heights
  });

  it("stacked same-alliance zones (2v2 per-army areas) are de-stacked, queued along the ray", () => {
    const a = mk(0, -600, 300, 150, 0, 0, 0);
    const b = mk(0, -600, 300, 150, 0, 0, 0);   // identical twin, same alliance
    autoShiftZones([a, b], 2048, 200);
    expect(zonesOverlap(a, b)).toBe(false);
    // one twin at the headroom line (1024-200-75), the other queued right behind, touching
    expect(Math.min(a.y, b.y)).toBe(-749);
    expect(Math.max(a.y, b.y)).toBe(-599);
  });

  it("a real-shaped 2v2 block: both alliances' stacked strips separate, push, never overlap", () => {
    const zones = [
      mk(0, 900, 2000, 200, 0, 0, 0), mk(0, 900, 2000, 200, 0, 0, 0),
      mk(0, -900, 2000, 200, 0, 0, 1), mk(0, -900, 2000, 200, 0, 0, 1),
    ];
    autoShiftZones(zones, 8192, 200);
    for (let i = 0; i < zones.length; i++)
      for (let j = i + 1; j < zones.length; j++)
        expect(zonesOverlap(zones[i], zones[j])).toBe(false);
    for (const z of zones) expect(zoneInBounds(z, 4096)).toBe(true);
    // the front strip of each side reaches the headroom line
    expect(Math.max(...zones.map(z => z.y))).toBe(3796);   // 4096-200-100
    expect(Math.min(...zones.map(z => z.y))).toBe(-3796);
  });

  it("a zone whose rotated corners exceed the map at base is shrunk just enough to fit", () => {
    // 45deg strip near the edge: corners poke ~17m past a 1024 half
    const big = mk(0, 900, 300, 100, Math.PI / 4);
    const ok = mk(0, -500, 300, 100, Math.PI / 4);   // same shape, fits fine
    autoShiftZones([big, ok], 2048, 200);
    expect(zoneInBounds(big, 1024)).toBe(true);
    expect(big.w).toBeLessThan(300);                 // only the offender shrank
    expect(big.w).toBeGreaterThan(250);              // and only a bit (f ~ 0.877)
    expect([ok.w, ok.h]).toEqual([300, 100]);
    expect(zoneInBounds(ok, 1024)).toBe(true);
  });

  it("shrink stays feasible even when the factor is tiny (no minimum-size clamp)", () => {
    // centre 2m from the edge: f=0.01 -> 4x4; a min-10 clamp would overhang by 3m
    const z = [mk(498, 0, 400, 400, 0)];
    autoShiftZones(z, 1000, 0);
    expect(zoneInBounds(z[0], 500)).toBe(true);
  });

  it("shrink never grows a sub-minimum authored dimension", () => {
    // w=0 strip overhanging only on y: growing w to a floor would mint an x-overhang
    const z = [mk(498, 200, 0, 800, 0)];
    autoShiftZones(z, 1000, 0);
    expect(z[0].w).toBe(0);
    expect(zoneInBounds(z[0], 500)).toBe(true);
  });

  it("shrinking happens once: recomputes keep the shrunken size and stay put", () => {
    const z = [mk(0, 900, 300, 100, Math.PI / 4)];
    autoShiftZones(z, 2048, 200);
    const snap = [z[0].x, z[0].y, z[0].w, z[0].h];
    autoShiftZones(z, 2048, 50);
    autoShiftZones(z, 2048, 200);
    expect([z[0].x, z[0].y, z[0].w, z[0].h]).toEqual(snap);
  });

  it("headroom 0: quantisation never pushes a corner past the hard edge", () => {
    // exact push 389.96 used to round UP to 390.0, landing the corner at 500.04
    const z = [mk(100.04, 0, 20, 20)];
    autoShiftZones(z, 1000, 0);
    expect(zoneInBounds(z[0], 500)).toBe(true);
  });

  it("recomputing with the same headroom right after the first call moves nothing", () => {
    // de-stack shifts the group centroid across the near-centre threshold: the
    // push direction must come from the de-stacked bases on the FIRST call too
    const zs = [mk(60, 0, 100, 100, 0, 0, 0), mk(60, 0, 100, 100, 0, 0, 0)];
    autoShiftZones(zs, 1000, 200);
    const first = zs.map(z => [z.x, z.y]);
    autoShiftZones(zs, 1000, 200);
    expect(zs.map(z => [z.x, z.y])).toEqual(first);
  });

  it("walker escapes diagonally when blockers seal all four ray-frame cardinals", () => {
    const zs = [
      mk(0, 100, 40, 40, 0, 0, 1), mk(0, 100, 40, 40, 0, 0, 1),   // stacked pair, ray (0,1)
      mk(0, -215, 60, 570, 0, 0, 2), mk(0, 315, 60, 370, 0, 0, 2), // blockers below/above
      mk(-265, 100, 470, 60, 0, 0, 2), mk(265, 100, 470, 60, 0, 0, 2), // and either side
    ];
    autoShiftZones(zs, 1000, 25);
    expect(zonesOverlap(zs[0], zs[1])).toBe(false);   // only the diagonals were open
    for (const z of zs) expect(zoneInBounds(z, 500)).toBe(true);
  });

  it("cross-alliance base overlap is separated too, and never overlaps after the shift", () => {
    const a = mk(0, -300, 200, 100, 0, 0, 0);
    const b = mk(0, -350, 200, 100, 0, 0, 1);   // cross-alliance, overlapping at base
    autoShiftZones([a, b], 2048, 200);
    expect(zonesOverlap(a, b)).toBe(false);
    expect(zoneInBounds(a, 1024)).toBe(true);
    expect(zoneInBounds(b, 1024)).toBe(true);
  });
});

describe("zoneInBounds", () => {
  const mk = (x: number, y: number, w: number, h: number, o = 0): Zone =>
    ({ x, y, w, h, o, block: 0, alliance: 0, seg: "" } as Zone);

  it("accepts a zone fully inside; touching the boundary is allowed", () => {
    expect(zoneInBounds(mk(0, 0, 200, 200), 1024)).toBe(true);
    expect(zoneInBounds(mk(0, 924, 200, 200), 1024)).toBe(true);   // top edge exactly on 1024
  });

  it("rejects a zone with any corner outside, including corners pushed out by rotation", () => {
    expect(zoneInBounds(mk(0, 950, 200, 200), 1024)).toBe(false);              // edge past the bound
    expect(zoneInBounds(mk(0, 900, 300, 100, Math.PI / 4), 1024)).toBe(false); // rotated corner pokes out
    expect(zoneInBounds(mk(0, 900, 300, 100, 0), 1024)).toBe(true);            // same zone unrotated fits
  });
});

describe("zonesOverlap", () => {
  const mk = (x: number, y: number, w: number, h: number, o = 0): Zone =>
    ({ x, y, w, h, o, block: 0, alliance: 0, seg: "" } as Zone);

  it("detects axis-aligned overlap and clears separated rects", () => {
    expect(zonesOverlap(mk(0, 0, 100, 100), mk(50, 0, 100, 100))).toBe(true);
    expect(zonesOverlap(mk(0, 0, 100, 100), mk(200, 0, 100, 100))).toBe(false);
  });

  it("touching edges do not count as overlap", () => {
    expect(zonesOverlap(mk(0, 0, 100, 100), mk(100, 0, 100, 100))).toBe(false);
  });

  it("rotated: separates a diamond from a rect their AABBs would call overlapping", () => {
    const diamond = mk(0, 0, 100, 100, Math.PI / 4);   // vertices at ±70.7 on the axes
    expect(zonesOverlap(diamond, mk(65, 65, 20, 20))).toBe(false);   // outside the 45° edge
    expect(zonesOverlap(diamond, mk(40, 40, 20, 20))).toBe(true);    // inside it
  });
});
