// ---------- XML enlarge edits + grid.fx shader patch (pure text transforms) ----------
export function scaleAttr(xml: string, attr: string, f: number): string {
  return xml.replace(new RegExp(`(${attr}=')([0-9.]+)(')`, "g"),
    (m: string, a: string, v: string, c: string) => `${a}${(parseFloat(v) * f).toFixed(6)}${c}`);
}

export function setScale(xml: string, scale: string): string {
  return xml.replace(/(scale=')([0-9.\-]+)(')/g, (m: string, a: string, v: string, c: string) => `${a}${scale}${c}`);
}

/** Sink the heightmap bias with the enlargement: b -> b - |b|*(f-1).
 * -5 at x1.5 -> -7.5; +5 at x1.5 -> 2.5; no bias attribute = no-op. */
export function shiftBias(xml: string, factor: number): string {
  return xml.replace(/(\bbias=')([0-9.\-]+)(')/g, (m: string, a: string, v: string, c: string) => {
    const b = parseFloat(v);
    return `${a}${(b - Math.abs(b) * (factor - 1)).toFixed(6)}${c}`;
  });
}

export function baseTerrainWidth(defTxt: string): number {
  const bw = /base_terrain_width='([0-9.]+)'/.exec(defTxt);
  return bw ? parseFloat(bw[1]) : 2048;
}

/** Terrain width from a height_map_N_settings.xml — the no-definition.xml fallback. */
export function worldWidth(txt: string): number {
  const m = /world_width='([0-9.]+)'/.exec(txt);
  return m ? parseFloat(m[1]) : 2048;
}

// grid.fx patch — the streak fix. The terrain shader computes colour/blend
// UVs as world_position.xz / terrain_size_meters + 0.5 with the CPU feeding
// 2048; scaling the divisor widens the window to match the enlarged map.
export function patchGridFx(txt: string, factor: 1.5 | 2): { txt: string | null; msg: string } {
  const A = "float2 tex_cm = r.world_position.xz/(terrain_size_meters);";
  const B = "float2 offset = 1.0f / (terrain_size_meters);";
  const nA = txt.split(A).length - 1;
  const nB = txt.split(B).length - 1;
  const F = factor === 1.5 ? "1.5f" : "2.0f";
  if (nA === 0 && /terrain_size_meters \* [12]\.[05]f/.test(txt)) {
    return { txt: null, msg: "Already patched — start from the original grid.fx to change factor." };
  }
  if (nA === 0) {
    return { txt: null, msg: "Pattern not found — different shader version? Send it to be inspected." };
  }
  let out = txt.split(A).join(`float2 tex_cm = r.world_position.xz/(terrain_size_meters * ${F});`);
  out = out.split(B).join(`float2 offset = 1.0f / (terrain_size_meters * ${F});`);
  return { txt: out, msg: `Patched ${nA} UV site${nA > 1 ? "s" : ""} + ${nB} offset → window ×${factor} (${Math.round(2048 * factor)} m). Install via PFM + delete shader cache.` };
}
