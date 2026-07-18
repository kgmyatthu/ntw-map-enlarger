import type { CSSProperties } from "react";

// ---------- bmd.tree_list codec ----------
export interface Tree {
  x: number;
  z: number;
  /** raw per-record payload after the two coord floats (4B LRDZ / 6B RIKI) */
  extra: Uint8Array;
  isNew: boolean;
}

export interface Species {
  name: string;
  /** 0x0e-prefixed UTF-16LE name block, byte-preserved */
  nameBytes: Uint8Array;
  trees: Tree[];
  /** unparsed bytes between the last record and the next species block */
  trailing: Uint8Array;
}

export interface TreeList {
  header: Uint8Array;
  species: Species[];
  stride: number;
  magic: string;
  origBytes: Uint8Array;
}

/** Tree list as held in viewer state: parsed from a concrete archive path. */
export interface LoadedTreeList extends TreeList {
  path: string;
}

// ---------- DDS heightmap ----------
export interface HeightMap {
  w: number;
  h: number;
  px: Float32Array;
}

// ---------- deployment_areas.xml ----------
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
  o: number;
  block: number;
  alliance: number;
  /** the original <deployment_area>…</deployment_area> text */
  seg: string;
  /** pre-auto-shift centre; present only on batch-processed deployments */
  x0?: number;
  y0?: number;
  /** auto-shift vector last applied (x = x0 + sdx, y = y0 + sdy) */
  sdx?: number;
  sdy?: number;
}

/** Alternating raw-text / zone segments, discriminated on `raw`. */
export type DepSeg =
  | { raw: string; zone?: undefined }
  | { raw?: undefined; zone: Zone };

export interface Deployment {
  segs: DepSeg[];
  zones: Zone[];
  nBlocks: number;
  changed: boolean;
}

/** Deployment as held in viewer state / bundles: parsed from a concrete archive path. */
export interface LoadedDeployment extends Deployment {
  path: string;
}

// ---------- batch bundles ----------
/** Values are ArrayBuffer-backed (zip extraction / TextEncoder), which Blob and JSZip require. */
export type FileStore = Map<string, Uint8Array<ArrayBuffer>>;

export interface Bundle {
  name: string;
  store: FileStore;
  /** PNG data URL of the untouched import (original size/trees/zones), for the side-by-side panel */
  origThumb: string;
  root: string;
  factor: 1.5 | 2;
  exported: boolean;
  /** PNG data URL thumbnail */
  thumb: string;
  nTrees: number;
  nZones: number;
  dep: LoadedDeployment | null;
  depPath: string | null;
  colourBytes: Uint8Array<ArrayBuffer> | null;
  extent: number;
  origScale: string | null;
  scaleSet?: string | null;
}

// ---------- undo ----------
export interface RemovedTree {
  kind: "tree";
  si: number;
  i: number;
  t: Tree;
}

export type UndoAction =
  | { type: "fill"; addedPer: number[] }
  | { type: "zone-move"; zi: number; x: number; y: number; w: number; h: number; o: number; x0: number | undefined; y0: number | undefined }
  | { type: "tree-add"; si: number; n: number }
  | { type: "erase"; removed: RemovedTree[] };

// ---------- UI literal unions ----------
export type Tool = "pan" | "place" | "brush" | "erase" | "zones";
export type FillAlgo = "cluster" | "colour" | "uniform" | "spaced";
export type LayerKey = "colour" | "alpha" | "height" | "trees" | "deploy";
export type LayerState = Record<LayerKey, boolean>;
export type ZoneField = "x" | "y" | "w" | "h";

export interface Entity {
  kind: "tree";
  idx: number;
}

// ---------- canvas view / drag ----------
export interface View {
  zoom: number;
  cx: number;
  cz: number;
}

/**
 * Mouse drag state — three shapes discriminated by presence of
 * `panning` / `zone` / `painting` (the code tests them with `?.`).
 */
export type DragState =
  | { panning: true; sx: number; sz: number; cx: number; cz: number; zone?: undefined; painting?: undefined }
  | { zone: number; mode?: "resize" | "rotate"; ox: number; oy: number; wx0: number; wz0: number; panning?: undefined; painting?: undefined }
  | { painting: true; last: [number, number]; panning?: undefined; zone?: undefined };

// ---------- styles ----------
/** The S style object: plain CSSProperties plus state-dependent factories. */
export interface Styles {
  app: CSSProperties;
  side: CSSProperties;
  h: CSSProperties;
  sub: CSSProperties;
  lbl: CSSProperties;
  row: CSSProperties;
  btn: (on: boolean) => CSSProperties;
  act: (en: boolean) => CSSProperties;
  ent: (on: boolean) => CSSProperties;
  num: CSSProperties;
  status: CSSProperties;
}
