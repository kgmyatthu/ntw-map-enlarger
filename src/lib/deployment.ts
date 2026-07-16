import type { Zone, DepSeg, Deployment } from "../types";

// ---------- deployment_areas.xml (text-preserving zone editor) ----------
export function parseDeployment(text: string): Deployment {
  // normalise European decimal commas inside attribute values (either quote style)
  text = text.replace(/(=')([\-0-9]+),([0-9]+)(')/g, "$1$2.$3$4")
             .replace(/(=")([\-0-9]+),([0-9]+)(")/g, "$1$2.$3$4");
  const segs: DepSeg[] = [];        // alternating raw text / zone segments
  const zones: Zone[] = [];
  const re = /<deployment_area[\s\S]*?<\/deployment_area>/g;
  let last = 0, m: RegExpExecArray | null;
  const blockStarts: number[] = [];
  const bre = /<BATTLE_DEPLOYMENT_AREAS>/g;
  let bm: RegExpExecArray | null;
  while ((bm = bre.exec(text))) blockStarts.push(bm.index);
  const alRe = /<ALLIANCE id=['"](\d+)['"]>/g;
  const alliances: { idx: number; id: number }[] = [];
  let am: RegExpExecArray | null;
  while ((am = alRe.exec(text))) alliances.push({ idx: am.index, id: +am[1] });
  while ((m = re.exec(text))) {
    segs.push({ raw: text.slice(last, m.index) });
    const seg = m[0];
    const g = (rx: RegExp) => { const r = rx.exec(seg); return r ? parseFloat(r[1]) : 0; };
    let blk = 0; for (let i = 0; i < blockStarts.length; i++) if (blockStarts[i] < m.index) blk = i;
    let al = 0; for (const a of alliances) if (a.idx < m.index) al = a.id;
    // real exports use <centre x='..'/> (either quote style); <region x=".."/> kept for older files
    const z: Zone = {
      x: g(/<(?:centre|region)[^>]*?x=['"]([\-0-9.]+)['"]/), y: g(/y=['"]([\-0-9.]+)['"]/),
      w: g(/width metres=['"]([\-0-9.]+)['"]/), h: g(/height metres=['"]([\-0-9.]+)['"]/),
      o: g(/orientation radians=['"]([\-0-9.]+)['"]/),
      block: blk, alliance: al, seg,
    };
    zones.push(z);
    segs.push({ zone: z });
    last = m.index + seg.length;
  }
  segs.push({ raw: text.slice(last) });
  const nBlocks = blockStarts.length || 1;
  return { segs, zones, nBlocks, changed: false };
}

export function serializeDeployment(dep: Deployment): string {
  let out = "";
  for (const s of dep.segs) {
    if (s.raw !== undefined) { out += s.raw; continue; }
    const z = s.zone;
    let seg = z.seg;
    // rewrite values in place, preserving each file's own quote style
    seg = seg.replace(/(x=['"])[\-0-9.]+(['"])/, `$1${+z.x.toFixed(1)}$2`);
    seg = seg.replace(/(y=['"])[\-0-9.]+(['"])/, `$1${+z.y.toFixed(1)}$2`);
    seg = seg.replace(/(width metres=['"])[\-0-9.]+(['"])/, `$1${+z.w.toFixed(1)}$2`);
    seg = seg.replace(/(height metres=['"])[\-0-9.]+(['"])/, `$1${+z.h.toFixed(1)}$2`);
    seg = seg.replace(/(orientation radians=['"])[\-0-9.]+(['"])/, `$1${+z.o.toFixed(3)}$2`);
    out += seg;
  }
  return out;
}

/** Corners of a zone's rotated rectangle in world space. */
function zoneCorners(z: Zone): [number, number][] {
  const c = Math.cos(z.o), s = Math.sin(z.o);
  return ([[-z.w / 2, -z.h / 2], [z.w / 2, -z.h / 2], [z.w / 2, z.h / 2], [-z.w / 2, z.h / 2]] as const)
    .map(([lx, ly]) => [z.x + lx * c - ly * s, z.y + lx * s + ly * c]);
}

/** True when two rotated zone rectangles overlap (separating-axis test); touching edges don't count. */
export function zonesOverlap(a: Zone, b: Zone): boolean {
  const pa = zoneCorners(a), pb = zoneCorners(b);
  for (const [p, q] of [[pa, pb], [pb, pa]] as const) {
    for (let i = 0; i < 2; i++) {                       // two adjacent edge normals cover a rect's axes
      const ax = p[i + 1][1] - p[i][1], ay = p[i][0] - p[i + 1][0];
      const proj = (pts: [number, number][]) => {
        let mn = Infinity, mx = -Infinity;
        for (const [x, y] of pts) { const d = x * ax + y * ay; if (d < mn) mn = d; if (d > mx) mx = d; }
        return [mn, mx];
      };
      const [amn, amx] = proj(p), [bmn, bmx] = proj(q);
      if (amx <= bmn || bmx <= amn) return false;       // separating axis found
    }
  }
  return true;
}

/** True when every corner of the zone's rotated rectangle lies within ±half on both axes. */
export function zoneInBounds(z: Zone, half: number): boolean {
  return zoneCorners(z).every(([x, y]) => Math.abs(x) <= half && Math.abs(y) <= half);
}

/** Rotated-box half-extents of a zone along world x and y. */
function halfExtents(z: Zone): [number, number] {
  return [
    Math.abs(z.w / 2 * Math.cos(z.o)) + Math.abs(z.h / 2 * Math.sin(z.o)),
    Math.abs(z.h / 2 * Math.cos(z.o)) + Math.abs(z.w / 2 * Math.sin(z.o)),
  ];
}

/** How far a point at p can travel along direction u before |p + t·u| exceeds bound. */
function axisLimit(p: number, u: number, bound: number): number {
  if (bound < 0) return 0;                      // zone bigger than the playable band: don't move
  if (u > 1e-9) return (bound - p) / u;
  if (u < -1e-9) return (-bound - p) / u;
  return Math.abs(p) <= bound ? Infinity : 0;   // not moving on this axis
}

/** 2D auto-shift: each (block, alliance) zone group is pushed rigidly outward
 * along its own centroid ray — as far as that group's geometry allows — until
 * its binding zone sits `headroom` m clear of the ±extent/2 map edge on BOTH
 * axes. Groups are independent, so one deep zone in another block/alliance no
 * longer clamps the rest of the map. Re-derives x/y from x0/y0 each call
 * (absolute, not cumulative). Returns the largest push applied (m). */
export function autoShiftZones(zones: Zone[], extent: number, headroom: number): number {
  const half = extent / 2 - headroom;
  const fresh = zones.some(z => z.y0 === undefined);
  for (const z of zones) if (z.y0 === undefined) { z.x0 = z.x; z.y0 = z.y; }   // capture bases once
  const groups = new Map<string, Zone[]>();
  for (const z of zones) {
    const k = z.block + ":" + z.alliance;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(z);
  }
  const dirOf = (g: Zone[]): [number, number] => {
    let cx = 0, cy = 0;
    for (const z of g) { cx += z.x0!; cy += z.y0!; }
    cx /= g.length; cy /= g.length;
    const r = Math.hypot(cx, cy);
    // near-centre group: its ray direction is noise, push along the battle (y) axis
    return r > extent / 20 ? [cx / r, cy / r] : [0, cy >= 0 ? 1 : -1];
  };
  const glist = [...groups.values()];
  // de-stack: presets stack per-army zones on the same spot, but zones may
  // never overlap in-game. Walk each base-overlapping zone away in 10 m steps
  // until it clears everything already placed in its block — trying down the
  // group ray, up it, then both perpendiculars, and never leaving the map
  // (ring-layout scenario maps have members whose ray points off the edge).
  // If no direction works the map is too crammed: keep the mapper's stack.
  // Runs once (fresh bases); recomputes keep the separated bases.
  if (fresh) {
    const at = (z: Zone) => ({ ...z, x: z.x0!, y: z.y0! });
    const hardHalf = extent / 2;
    const R = Math.SQRT1_2;
    // a zone bigger than the space at its spot (oblique strips on x1.5 maps)
    // can never be placed in bounds by moving alone: shrink JUST that zone,
    // uniformly, until its rotated box fits the hard map edge
    for (const z of zones) {
      const [hx, hy] = halfExtents(z);
      const f = Math.min(
        hx > 0 ? (hardHalf - Math.abs(z.x0!)) / hx : 1,
        hy > 0 ? (hardHalf - Math.abs(z.y0!)) / hy : 1,
      );
      if (f > 0 && f < 1) {   // f <= 0 means the centre itself is outside: mapper's own layout, leave it
        // floor only — a minimum-size clamp here can exceed the remaining gap
        // (or even grow a sub-minimum authored dimension) and break the bounds
        z.w = Math.floor(z.w * f * 10) / 10;
        z.h = Math.floor(z.h * f * 10) / 10;
      }
    }
    for (const blk of new Set(glist.map(g => g[0].block))) {
      // walkers must clear EVERY other zone's current base — checking only
      // already-processed ones lets a walker park on an unprocessed zone's spot
      const bzAll = zones.filter(z => z.block === blk);
      const clear = (z: Zone) => !bzAll.some(o => o !== z && zonesOverlap(at(z), at(o)));
      for (const g of glist.filter(q => q[0].block === blk)) {
        const [ux, uy] = dirOf(g);   // preliminary ray, only orders the walk directions
        for (const z of g) {
          if (clear(z)) continue;
          // ray-frame cardinals first, then its diagonals (blockers can seal all four cardinals)
          const dirs: [number, number][] = [
            [-ux, -uy], [ux, uy], [-uy, ux], [uy, -ux],
            [(-ux - uy) * R, (ux - uy) * R], [(-ux + uy) * R, (-ux - uy) * R],
            [(ux - uy) * R, (ux + uy) * R], [(ux + uy) * R, (-ux + uy) * R],
          ];
          const ox = z.x0!, oy = z.y0!;
          let done = false;
          for (const [dx, dy] of dirs) {
            z.x0 = ox; z.y0 = oy;
            // ponytail: 10 m nudges capped at a map length; minimal-translation
            // solving isn't worth it for deployment strips
            for (let k = 0; k < extent / 10 && !done; k++) {
              z.x0 = Math.round((z.x0! + dx * 10) * 10) / 10;
              z.y0 = Math.round((z.y0! + dy * 10) * 10) / 10;
              if (!zoneInBounds(at(z), hardHalf)) break;   // ran off the map: try the next direction
              if (clear(z)) done = true;
            }
            if (done) break;
          }
          if (!done) { z.x0 = ox; z.y0 = oy; }   // crammed: keep the mapper's stack
        }
      }
    }
  }
  // directions and push distances derive from the FINAL (de-stacked) bases, so
  // the first call computes exactly what every later recompute does
  interface Push { g: Zone[]; ux: number; uy: number; t: number; block: number }
  const pushes: Push[] = [];
  for (const g of glist) {
    const [ux, uy] = dirOf(g);
    let t = Infinity;
    for (const z of g) {
      const [hx, hy] = halfExtents(z);
      t = Math.min(t, axisLimit(z.x0!, ux, half - hx), axisLimit(z.y0!, uy, half - hy));
    }
    pushes.push({ g, ux, uy, t: isFinite(t) ? Math.max(0, t) : 0, block: g[0].block });
  }
  // quantise toward the base (never past the exact limit) so the 0.1 m grid
  // cannot push a corner over the boundary even at headroom 0; the 1e-6
  // absorbs float noise on exact-integer shifts
  const q = (v: number) => (v >= 0 ? Math.floor(v * 10 + 1e-6) : Math.ceil(v * 10 - 1e-6)) / 10;
  const apply = (p: Push, s: number) => {
    for (const z of p.g) {
      z.sdx = q(p.t * s * p.ux);
      z.sdy = q(p.t * s * p.uy);
      z.x = z.x0! + z.sdx;
      z.y = z.y0! + z.sdy;
    }
  };
  let maxPush = 0;
  for (const blk of new Set(pushes.map(p => p.block))) {
    const list = pushes.filter(p => p.block === blk);
    const bz = zones.filter(z => z.block === blk);
    // pairs still overlapping at the de-stacked bases could not be separated
    // within the map; exempt them so one crammed stack doesn't freeze the block
    for (const p of list) apply(p, 0);
    const pre = new Set<string>();
    for (let a = 0; a < bz.length; a++)
      for (let b = a + 1; b < bz.length; b++)
        if (zonesOverlap(bz[a], bz[b])) pre.add(a + ":" + b);
    // strict no-overlap veto for every separable pair: when group rays
    // converge, back the whole block's push off in 2% steps until clean
    let s = 1;
    for (let i = 50; i >= 0; i--) {
      s = i / 50;
      for (const p of list) apply(p, s);
      let bad = false;
      outer: for (let a = 0; a < bz.length; a++)
        for (let b = a + 1; b < bz.length; b++)
          if (!pre.has(a + ":" + b) && zonesOverlap(bz[a], bz[b])) { bad = true; break outer; }
      if (!bad) break;
    }
    for (const p of list) maxPush = Math.max(maxPush, Math.round(p.t * s));
  }
  return maxPush;
}
