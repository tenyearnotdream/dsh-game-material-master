/**
 * 45° 地图编辑器（模块五 · iso）的**绘制计划与光栅化**。
 *
 * 宿主是唯一渲染器：每个计划条目 = 「用哪块图、画在哪个像素、在第几层多深」。
 * 客户端只 `drawImage`，导出 PNG 执行**同一份计划**并按同一个 `z` 排序。
 *
 * 与模块六的三个关键差异（都是等距带来的）：
 *
 * 1. 格子是菱形，贴图按**菱形中心**摆放；
 * 2. 绘制顺序不能按 chunk / 行优先，必须按宿主算好的 `z`（前后遮挡）；
 * 3. 物件是一张完整图，不是按格切开的图块，可以高出一格。
 */

import { encodePng } from "./png.js";
import type { Bitmap } from "./bitmap.js";
import { cellIndex, type IsoDoc, type IsoObject } from "./isodoc.js";
import {
  cellCenter,
  cellTopLeft,
  chunkKey,
  chunkOf,
  expandBounds,
  groundBounds,
  isoDepthZ,
  layoutOf,
  objectTopLeft,
  parseChunkKey,
  wrapCell,
  type IsoBounds,
  type IsoCell,
  type IsoCellRange,
  type IsoFootprint,
  type IsoLayout
} from "./isogeom.js";
import { corner16Mask, nearestMask, type NeighborAt } from "./mapauto.js";
import { applyLoop, flatTiles, type FlatTile, type MapRect, type MapTile } from "./maptiles.js";
import type { IsoTileset } from "./isotiles.js";

/** 单张导出图的最大像素数（超过就明确拒绝，而不是把进程 OOM 掉）。 */
export const MAX_ISO_RENDER_PIXELS = 64_000_000;

/** 动画帧率：与模块六一致，1 帧/秒是默认档。 */
const DEFAULT_FPS = 1;

export interface IsoRenderContext {
  cell: IsoCell;
  layout: IsoLayout;
  tilesets: readonly IsoTileset[];
  /** 1-based 全局图块序号 → 展平后的图块。 */
  lookup: Map<number, FlatTile>;
}

export interface IsoPlanOp {
  l: number;
  r: number;
  c: number;
  t: number;
  x: number;
  y: number;
  a: number;
  /** 深度排序键；客户端只按它排序。 */
  z: number;
  cycle?: number[];
  fps?: number;
}

export interface IsoPlanChunk {
  key: string;
  ops: IsoPlanOp[];
}

export interface IsoPlanLegendEntry {
  index: number;
  tilesetId: string;
  rect: MapRect;
  kind: "ground" | "autotile" | "object";
}

export interface IsoPlanMarker {
  id: string;
  n: number;
  name: string;
  r: number;
  c: number;
  x: number;
  y: number;
  radius: number;
  font: number;
}

export interface IsoRenderPlan {
  chunks: IsoPlanChunk[];
  bounds: IsoBounds;
  legend: IsoPlanLegendEntry[];
  fps: number;
  fpsMax: number;
  frameCount: number;
  cycles: number[][];
  markers: IsoPlanMarker[];
  warnings: string[];
}

interface WarnSink {
  missing: Set<number>;
  missingTileset: Set<string>;
  autotileFallback: Map<string, { tilesetId: string; wanted: number; used: number; cells: number }>;
  autotileUnmasked: Set<string>;
  objectMissing: Set<string>;
}

interface PlanEnv {
  context: IsoRenderContext;
  doc: IsoDoc;
  layout: IsoLayout;
  baseIndex: Map<string, number>;
  tilesetById: Map<string, IsoTileset>;
  sink: WarnSink;
}

function tilesetBaseIndex(tilesets: readonly IsoTileset[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const flat of flatTiles(tilesets as any)) {
    if (!out.has(flat.tilesetId)) out.set(flat.tilesetId, flat.index);
  }
  return out;
}

export function isoRenderContext(project: { cell: IsoCell; wrap: boolean }, doc: IsoDoc, tilesets: readonly IsoTileset[]): IsoRenderContext {
  const layout = layoutOf(project.cell, doc.cols, doc.rows, project.wrap);
  return { cell: project.cell, layout, tilesets, lookup: new Map(flatTiles(tilesets as any).map((flat) => [flat.index, flat])) };
}

/** 物件的展示帧尺寸（第 0 帧的 rect；所有帧同尺寸）。 */
export function objectFrameRect(tileset: IsoTileset): MapRect | undefined {
  const first = tileset.tiles.find((tile) => (tile.frame ?? 0) === 0) ?? tileset.tiles[0];
  return first?.rect;
}

/** 计划包围盒：网格脚印 + 每个物件图片向上 / 左右溢出的部分。 */
export function planBounds(context: IsoRenderContext, doc: IsoDoc): IsoBounds {
  const layout = context.layout;
  let bounds: IsoBounds | undefined = groundBounds(layout);
  const byId = new Map(context.tilesets.map((tileset) => [tileset.id, tileset]));
  for (const object of doc.objects) {
    const tileset = byId.get(object.tilesetId);
    if (tileset === undefined || tileset.kind !== "object" || tileset.footprint === undefined) continue;
    const rect = objectFrameRect(tileset);
    if (rect === undefined) continue;
    const topLeft = objectTopLeft(layout, object.r, object.c, tileset.footprint, rect.width, rect.height, tileset.anchor);
    bounds = expandBounds(bounds, { x: topLeft.x, y: topLeft.y, width: rect.width, height: rect.height });
  }
  return bounds ?? { originX: 0, originY: 0, width: 1, height: 1 };
}

function cellOpsAt(env: PlanEnv, layerIndex: number, layerId: string, rr: number, cc: number): IsoPlanOp[] {
  const w = wrapCell(env.layout, rr, cc);
  if (w.r < 0 || w.c < 0 || w.r >= env.doc.rows || w.c >= env.doc.cols) return [];
  const data = env.doc.data[layerId];
  const value = data === undefined ? 0 : data[cellIndex(env.doc, w.r, w.c)];
  if (!(value > 0)) return [];
  const flat = env.context.lookup.get(value);
  if (flat === undefined) {
    env.sink.missing.add(value);
    return [];
  }
  const tileset = env.tilesetById.get(flat.tilesetId);
  const base = env.baseIndex.get(flat.tilesetId);
  if (tileset === undefined || base === undefined || tileset.kind === "object") {
    env.sink.missing.add(value);
    return [];
  }
  const local = value - base;
  if (local < 0 || local >= tileset.tiles.length) {
    env.sink.missing.add(value);
    return [];
  }
  const at: NeighborAt = (nr, nc) => {
    const cell = wrapCell(env.layout, nr, nc);
    if (cell.r < 0 || cell.c < 0 || cell.r >= env.doc.rows || cell.c >= env.doc.cols) return false;
    const raw = data === undefined ? 0 : data[cellIndex(env.doc, cell.r, cell.c)];
    if (!(raw > 0)) return false;
    const neighbor = env.context.lookup.get(raw);
    return neighbor !== undefined && neighbor.tilesetId === tileset.id;
  };
  const position = cellTopLeft(env.layout, rr, cc, tileset.cell.width, tileset.cell.height);
  const z = isoDepthZ(layerIndex, rr, cc);
  if (tileset.kind === "autotile") {
    const configured: number[] = [];
    for (const tile of tileset.tiles) if (typeof tile.mask === "number") configured.push(tile.mask);
    let used: number | undefined;
    if (configured.length === 0) {
      env.sink.autotileUnmasked.add(tileset.id);
      used = 0;
    } else {
      const wanted = corner16Mask(at, w.r, w.c);
      used = configured.includes(wanted) ? wanted : nearestMask(wanted, configured);
      if (used !== undefined && used !== wanted) {
        const key = `${tileset.id}|${wanted}|${used}`;
        const row = env.sink.autotileFallback.get(key);
        if (row === undefined) env.sink.autotileFallback.set(key, { tilesetId: tileset.id, wanted, used, cells: 1 });
        else row.cells++;
      }
    }
    if (used === undefined) used = 0;
    const found = tileset.tiles.findIndex((tile) => (tile.mask ?? -1) === used);
    if (found < 0) {
      env.sink.autotileUnmasked.add(tileset.id);
      return [];
    }
    return [{ l: layerIndex, r: w.r, c: w.c, t: base + found, x: Math.round(position.x), y: Math.round(position.y), a: 1, z }];
  }
  let cycle: number[] | undefined;
  if (tileset.animRows === true && tileset.frames > 1 && tileset.columns > 0) {
    const column = local % tileset.columns;
    const frames: number[] = [];
    for (let row = 0; row < tileset.frames; row++) {
      const index = row * tileset.columns + column;
      if (index >= tileset.tiles.length) break;
      frames.push(base + index);
    }
    if (frames.length > 1) cycle = applyLoop(frames, tileset.loop ?? "forward");
  }
  const op: IsoPlanOp = {
    l: layerIndex,
    r: w.r,
    c: w.c,
    t: cycle === undefined ? base + local : cycle[0],
    x: Math.round(position.x),
    y: Math.round(position.y),
    a: 1,
    z
  };
  if (cycle !== undefined) {
    op.cycle = cycle;
    if (tileset.fps !== undefined) op.fps = tileset.fps;
  }
  return [op];
}

function objectOp(env: PlanEnv, layerIndex: number, object: IsoObject): IsoPlanOp | undefined {
  const tileset = env.tilesetById.get(object.tilesetId);
  if (tileset === undefined || tileset.kind !== "object" || tileset.footprint === undefined) {
    env.sink.objectMissing.add(object.tilesetId);
    return undefined;
  }
  const base = env.baseIndex.get(tileset.id);
  const rect = objectFrameRect(tileset);
  if (base === undefined || rect === undefined) {
    env.sink.objectMissing.add(tileset.id);
    return undefined;
  }
  const first = tileset.tiles.find((tile) => (tile.frame ?? 0) === 0) ?? tileset.tiles[0];
  if (first === undefined) {
    env.sink.objectMissing.add(tileset.id);
    return undefined;
  }
  const firstIndex = base + tileset.tiles.indexOf(first);
  if (firstIndex < base || firstIndex >= base + tileset.tiles.length) {
    env.sink.objectMissing.add(tileset.id);
    return undefined;
  }
  let cycle: number[] | undefined;
  if (tileset.frames > 1) {
    const frames: number[] = [];
    for (let frame = 0; frame < tileset.frames; frame++) {
      const found = tileset.tiles.findIndex((tile) => (tile.frame ?? 0) === frame);
      if (found < 0) break;
      frames.push(base + found);
    }
    if (frames.length > 1) cycle = applyLoop(frames, tileset.loop ?? "forward");
  }
  const topLeft = objectTopLeft(env.layout, object.r, object.c, tileset.footprint, rect.width, rect.height, tileset.anchor);
  const op: IsoPlanOp = {
    l: layerIndex,
    r: object.r,
    c: object.c,
    t: cycle === undefined ? firstIndex : cycle[0],
    x: Math.round(topLeft.x),
    y: Math.round(topLeft.y),
    a: 1,
    z: isoDepthZ(layerIndex, object.r, object.c, tileset.footprint)
  };
  if (cycle !== undefined) {
    op.cycle = cycle;
    if (tileset.fps !== undefined) op.fps = tileset.fps;
  }
  return op;
}

function objectIntersectsRange(object: IsoObject, footprint: IsoFootprint, range: IsoCellRange): boolean {
  for (let dr = 0; dr < footprint.rows; dr++) {
    for (let dc = 0; dc < footprint.cols; dc++) {
      const r = object.r + dr;
      const c = object.c + dc;
      if (r >= range.r0 && r < range.r1 && c >= range.c0 && c < range.c1) return true;
    }
  }
  return false;
}

/**
 * 生成绘制计划。
 *
 * - `range` 缺省 = 整张地图（导出走这条，不环绕）；
 * - 给了就越界也算（环绕），同一格会在多个像素位置出现；
 * - `layers` 只算这些层号（单层预览）；`op.l` 仍是真实层号。
 */
export function buildIsoPlan(
  context: IsoRenderContext,
  doc: IsoDoc,
  opts: { range?: IsoCellRange; layers?: number[]; includeLegend?: boolean } = {}
): IsoRenderPlan {
  const layout = context.layout;
  const range: IsoCellRange = opts.range ?? { r0: 0, c0: 0, r1: doc.rows, c1: doc.cols };
  const keepLayers = opts.layers === undefined ? undefined : new Set(opts.layers);
  const legend: IsoPlanLegendEntry[] =
    opts.includeLegend === false
      ? []
      : flatTiles(context.tilesets as any).map((flat) => {
          const tileset = context.tilesets.find((entry) => entry.id === flat.tilesetId);
          return { index: flat.index, tilesetId: flat.tilesetId, rect: flat.tile.rect, kind: (tileset?.kind ?? "ground") as IsoPlanLegendEntry["kind"] };
        });
  const env: PlanEnv = {
    context,
    doc,
    layout,
    baseIndex: tilesetBaseIndex(context.tilesets),
    tilesetById: new Map(context.tilesets.map((tileset) => [tileset.id, tileset])),
    sink: { missing: new Set(), missingTileset: new Set(), autotileFallback: new Map(), autotileUnmasked: new Set(), objectMissing: new Set() }
  };
  const buckets = new Map<string, IsoPlanOp[]>();
  const push = (op: IsoPlanOp, r: number, c: number): void => {
    const key = chunkKey(chunkOf(r, c));
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [op]);
    else list.push(op);
  };
  for (let layerIndex = 0; layerIndex < doc.layers.length; layerIndex++) {
    if (keepLayers !== undefined && !keepLayers.has(layerIndex)) continue;
    const layer = doc.layers[layerIndex];
    if (layer === undefined) continue;
    if (layer.kind === "ground") {
      for (let rr = range.r0; rr < range.r1; rr++) {
        for (let cc = range.c0; cc < range.c1; cc++) {
          for (const op of cellOpsAt(env, layerIndex, layer.id, rr, cc)) push(op, rr, cc);
        }
      }
    } else {
      for (const object of doc.objects) {
        if (object.layerId !== layer.id) continue;
        const tileset = env.tilesetById.get(object.tilesetId);
        const footprint = tileset?.footprint ?? { cols: 1, rows: 1 };
        if (!objectIntersectsRange(object, footprint, range)) continue;
        const op = objectOp(env, layerIndex, object);
        if (op !== undefined) push(op, object.r, object.c);
      }
    }
  }

  const warnings: string[] = [];
  if (context.tilesets.length === 0) warnings.push("还没有素材：先导入一张素材图，或者用内置素材。");
  if (env.sink.missing.size > 0) warnings.push(`地图里用到了 ${env.sink.missing.size} 个找不到的图块序号（素材被删过或改过切分），这些格子没有画出来。`);
  for (const row of env.sink.autotileFallback.values()) {
    const name = env.tilesetById.get(row.tilesetId)?.name ?? row.tilesetId;
    warnings.push(`素材「${name}」没有第 ${row.wanted} 种接法，${row.cells} 个格子用了最接近的第 ${row.used} 种顶上。`);
  }
  for (const id of env.sink.autotileUnmasked) {
    const name = env.tilesetById.get(id)?.name ?? id;
    warnings.push(`素材「${name}」是自动连接，但没有可用的 16 块接法，画不出来。`);
  }
  for (const id of env.sink.objectMissing) {
    const name = env.tilesetById.get(id)?.name ?? id;
    warnings.push(`地图里引用了「${name}」的物件，但素材不见了或不是物件，这些物件没有画出来。`);
  }

  const chunks: IsoPlanChunk[] = [];
  const cycles: number[][] = [];
  const seenCycles = new Set<string>();
  let frameCount = 1;
  let fpsMax = DEFAULT_FPS;
  const ordered = [...buckets.entries()].sort((a, b) => {
    const pa = parseChunkKey(a[0]) ?? { cx: 0, cy: 0 };
    const pb = parseChunkKey(b[0]) ?? { cx: 0, cy: 0 };
    return pa.cy - pb.cy || pa.cx - pb.cx;
  });
  for (const [key, list] of ordered) {
    list.sort((a, b) => a.z - b.z || a.r - b.r || a.c - b.c);
    for (const op of list) {
      if (op.cycle === undefined) continue;
      if (op.cycle.length > frameCount) frameCount = op.cycle.length;
      if (typeof op.fps === "number" && op.fps > fpsMax) fpsMax = op.fps;
      const id = op.cycle.join(",");
      if (seenCycles.has(id)) continue;
      seenCycles.add(id);
      cycles.push(op.cycle);
    }
    chunks.push({ key, ops: list });
  }
  return {
    chunks,
    bounds: planBounds(context, doc),
    legend,
    fps: DEFAULT_FPS,
    fpsMax,
    frameCount,
    cycles,
    markers: buildIsoMarkers(context, doc, range),
    warnings
  };
}

/** 落在 range 里的标记（编号 = 数组下标 + 1，每次整份重发）。 */
export function buildIsoMarkers(context: IsoRenderContext, doc: IsoDoc, range: IsoCellRange): IsoPlanMarker[] {
  if (doc.markers.length === 0) return [];
  const layout = context.layout;
  const byCell = new Map<number, { n: number; marker: (typeof doc.markers)[number] }>();
  doc.markers.forEach((marker, index) => byCell.set(marker.r * doc.cols + marker.c, { n: index + 1, marker }));
  const radius = Math.max(5, Math.round(layout.cell.width * 0.18));
  const font = Math.max(8, Math.round(radius * 1.2));
  const out: IsoPlanMarker[] = [];
  for (let rr = range.r0; rr < range.r1; rr++) {
    for (let cc = range.c0; cc < range.c1; cc++) {
      const w = wrapCell(layout, rr, cc);
      if (w.r < 0 || w.c < 0 || w.r >= doc.rows || w.c >= doc.cols) continue;
      const hit = byCell.get(w.r * doc.cols + w.c);
      if (hit === undefined) continue;
      const center = cellCenter(layout, rr, cc);
      out.push({
        id: hit.marker.id,
        n: hit.n,
        name: hit.marker.name,
        r: w.r,
        c: w.c,
        x: Math.round(center.x),
        y: Math.round(center.y),
        radius,
        font
      });
    }
  }
  return out;
}

/** 物件占格的通行性（「区域」叠加与导出共用）。 */
export function passCellsOf(context: IsoRenderContext, doc: IsoDoc): Array<{ r: number; c: number; kind: number }> {
  const out = new Map<string, { r: number; c: number; kind: number }>();
  const layout = context.layout;
  for (const object of doc.objects) {
    const tileset = context.tilesets.find((entry) => entry.id === object.tilesetId);
    if (tileset === undefined || tileset.kind !== "object" || tileset.footprint === undefined) continue;
    const pass = tileset.pass ?? [];
    for (let dr = 0; dr < tileset.footprint.rows; dr++) {
      for (let dc = 0; dc < tileset.footprint.cols; dc++) {
        const wrapped = wrapCell(layout, object.r + dr, object.c + dc);
        if (wrapped.r < 0 || wrapped.c < 0 || wrapped.r >= doc.rows || wrapped.c >= doc.cols) continue;
        const kind = pass[dr * tileset.footprint.cols + dc] ?? 1;
        out.set(`${wrapped.r},${wrapped.c}`, { r: wrapped.r, c: wrapped.c, kind });
      }
    }
  }
  return [...out.values()];
}

// ── 光栅化 ───────────────────────────────────────────────────────────────

function blendPixel(dst: Buffer, index: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const sa = Math.min(1, a);
  const da = dst[index + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  const mix = (s: number, d: number) => Math.round((s * sa + d * da * (1 - sa)) / outA);
  dst[index] = mix(r, dst[index]);
  dst[index + 1] = mix(g, dst[index + 1]);
  dst[index + 2] = mix(b, dst[index + 2]);
  dst[index + 3] = Math.round(outA * 255);
}

function blitScaled(dst: Bitmap, source: Bitmap, rect: MapRect, dx: number, dy: number, scale: number, alpha: number): void {
  const x0 = Math.max(0, -dx);
  const y0 = Math.max(0, -dy);
  const x1 = Math.min(Math.ceil(rect.width * scale), Math.ceil((dst.width - dx) / 1));
  const y1 = Math.min(Math.ceil(rect.height * scale), Math.ceil((dst.height - dy) / 1));
  for (let sy = y0; sy < y1; sy++) {
    const srcY = rect.y + Math.floor(sy / scale);
    if (srcY < 0 || srcY >= source.height) continue;
    for (let sx = x0; sx < x1; sx++) {
      const srcX = rect.x + Math.floor(sx / scale);
      if (srcX < 0 || srcX >= source.width) continue;
      const si = (srcY * source.width + srcX) * 4;
      const sa = (source.rgba[si + 3] / 255) * alpha;
      if (sa <= 0) continue;
      const tx = dx + sx;
      const ty = dy + sy;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      blendPixel(dst.rgba, (ty * dst.width + tx) * 4, source.rgba[si], source.rgba[si + 1], source.rgba[si + 2], sa);
    }
  }
}

export interface IsoRasterOptions {
  scale?: number;
}

export interface IsoRasterResult {
  bitmap: Bitmap;
  bounds: IsoBounds;
  warnings: string[];
  drawn: number;
}

/**
 * 把计划光栅化成位图（导出 `map.png` 用）。
 *
 * **按 `z` 排序后绘制**，与客户端完全同一顺序。只画第 0 帧：
 * PNG 是静帧，动画信息留在 `map.json` 与计划里。
 */
export function rasterizeIso(
  context: IsoRenderContext,
  doc: IsoDoc,
  lookup: Map<string, Bitmap>,
  options: IsoRasterOptions = {}
): IsoRasterResult {
  const scale = Math.max(1, Math.round(options.scale ?? 1));
  const plan = buildIsoPlan(context, doc, { includeLegend: true });
  const width = Math.ceil(plan.bounds.width * scale);
  const height = Math.ceil(plan.bounds.height * scale);
  if (width < 1 || height < 1) throw new Error("这张地图还没有任何内容，先画点东西再导出。");
  if (width * height > MAX_ISO_RENDER_PIXELS) {
    throw new Error(
      `导出图会到 ${width}×${height}（${((width * height) / 1e6).toFixed(1)}M 像素），超过 ${MAX_ISO_RENDER_PIXELS / 1e6}M 上限。请把缩放调小，或把地图拆小。`
    );
  }
  const bitmap: Bitmap = { width, height, rgba: Buffer.alloc(width * height * 4) };
  const legend = new Map(plan.legend.map((entry) => [entry.index, entry]));
  const warnings = [...plan.warnings];
  const missingBitmaps = new Set<string>();
  const ops = plan.chunks.flatMap((chunk) => chunk.ops).sort((a, b) => a.z - b.z || a.r - b.r || a.c - b.c);
  let drawn = 0;
  for (const op of ops) {
    const entry = legend.get(op.t);
    if (entry === undefined) continue;
    const source = lookup.get(entry.tilesetId);
    if (source === undefined) {
      missingBitmaps.add(entry.tilesetId);
      continue;
    }
    blitScaled(
      bitmap,
      source,
      entry.rect,
      Math.round((op.x - plan.bounds.originX) * scale),
      Math.round((op.y - plan.bounds.originY) * scale),
      scale,
      op.a
    );
    drawn++;
  }
  for (const id of missingBitmaps) {
    const name = context.tilesets.find((tileset) => tileset.id === id)?.name ?? id;
    warnings.push(`素材「${name}」的图片没有解码出来，它上面的内容没有画进 PNG。`);
  }
  return { bitmap, bounds: plan.bounds, warnings, drawn };
}

export function isoBitmapToPng(bitmap: Bitmap): Buffer {
  return encodePng(bitmap.rgba, bitmap.width, bitmap.height);
}
