/**
 * 45° 地图编辑器（模块五 · iso）的**导出**。
 *
 * 产物与模块六同形：`map.png`（宿主光栅化，与界面同一份计划）+ `map.json`
 * （`dsh-gem-iso-map@1`）+ 可选 `tilesets/**` + 多产物时一个 zip + `manifest.json`。
 *
 * 三条口径：
 * 1. `map.json` 写**语义序号**与物件/标记源数据，不写解析后的贴图；
 * 2. PNG 与界面执行同一份 `z` 排序计划；
 * 3. 每次导出先清空 `export/<安全名>/`，zip 时间戳写死（同文档两次导出逐字节一致）。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeFile, type Bitmap } from "./bitmap.js";
import type { IsoDoc } from "./isodoc.js";
import type { IsoTileset } from "./isotiles.js";
import { buildIsoPlan, isoBitmapToPng, passCellsOf, planBounds, rasterizeIso, type IsoRenderContext } from "./isorender.js";
import { safeFileName } from "./mapexport.js";
import { zipEntries, type ZipEntry } from "./zip.js";
import type { IsoBounds } from "./isogeom.js";

export const OWN_ISO_JSON_FORMAT = "dsh-gem-iso-map@1";

/** 带标记语义字段时使用；没有新字段的老文档仍然写 @1。 */
export const OWN_ISO_JSON_FORMAT_META = "dsh-gem-iso-map@2";

export interface IsoExportFormats {
  png?: boolean;
  json?: boolean;
  tilesets?: boolean;
  zip?: boolean;
  scale?: number;
}

export interface IsoExportedFile {
  path: string;
  bytes: number;
  kind: string;
}

export interface IsoExportManifest {
  files: IsoExportedFile[];
  warnings: string[];
  bounds: IsoBounds;
  mapPng?: string;
  mapJson?: string;
  mapZip?: string;
}

export interface IsoExportInput {
  project: { id: string; name: string };
  doc: IsoDoc;
  context: IsoRenderContext;
  dir: string;
  formats?: IsoExportFormats;
  /** 已解码的素材（tilesetId → 位图）；不给就按 `tilesetPath` 解一遍。 */
  lookup?: Map<string, Bitmap>;
  /** 素材相对路径 → 本机绝对路径。 */
  tilesetPath: (file: string) => string;
}

/** `dsh-gem-iso-map@1` 的内容。 */
export function buildIsoJson(context: IsoRenderContext, doc: IsoDoc, project: { id: string; name: string }): object {
  const legend = buildIsoPlan(context, doc, { includeLegend: true }).legend;
  const hasMarkerMeta = doc.markers.some(
    (marker) => marker.kind !== undefined || marker.color !== undefined || marker.note !== undefined || marker.tags !== undefined
  );
  return {
    format: hasMarkerMeta ? OWN_ISO_JSON_FORMAT_META : OWN_ISO_JSON_FORMAT,
    projection: "isometric-2:1",
    cell: { width: context.cell.width, height: context.cell.height },
    grid: { stepX: context.layout.stepX, stepY: context.layout.stepY, wrap: context.layout.wrap },
    cols: doc.cols,
    rows: doc.rows,
    project: { id: project.id, name: project.name },
    tilesets: context.tilesets.map((tileset) => ({
      id: tileset.id,
      name: tileset.name,
      image: tileset.file,
      kind: tileset.kind,
      cell: tileset.cell,
      frames: tileset.frames,
      footprint: tileset.footprint,
      anchor: tileset.anchor,
      objectScale: tileset.kind === "object" ? tileset.objectScale : undefined,
      pass: tileset.kind === "object" ? tileset.pass : undefined,
      loop: tileset.loop,
      fps: tileset.fps,
      tileCount: tileset.tiles.length
    })),
    legend: legend.map((entry) => ({ index: entry.index, tilesetId: entry.tilesetId, kind: entry.kind, rect: entry.rect })),
    layers: doc.layers.map((layer) => ({ id: layer.id, name: layer.name, kind: layer.kind })),
    ground: doc.layers
      .filter((layer) => layer.kind === "ground")
      .map((layer) => ({ layerId: layer.id, data: doc.data[layer.id] ?? [] })),
    objects: doc.objects.map((object) => ({ id: object.id, layerId: object.layerId, tilesetId: object.tilesetId, r: object.r, c: object.c })),
    markers: doc.markers.map((marker, index) => ({
      n: index + 1,
      name: marker.name,
      r: marker.r,
      c: marker.c,
      ...(marker.kind === undefined ? {} : { kind: marker.kind }),
      ...(marker.color === undefined ? {} : { color: marker.color }),
      ...(marker.note === undefined ? {} : { note: marker.note }),
      ...(marker.tags === undefined ? {} : { tags: marker.tags })
    })),
    pass: passCellsOf(context, doc)
  };
}

async function decodeTilesets(input: IsoExportInput): Promise<Map<string, Bitmap>> {
  const out = new Map<string, Bitmap>();
  for (const tileset of input.context.tilesets) {
    if (tileset.file === "") continue;
    const bitmap = await decodeFile(input.tilesetPath(tileset.file)).catch(() => undefined);
    if (bitmap !== undefined) out.set(tileset.id, bitmap);
  }
  return out;
}

function tilesetExportPath(file: string): string {
  const name = file.split(/[\\/]/u).pop() ?? "";
  return `tilesets/${name}`;
}

export async function exportIsoMap(input: IsoExportInput): Promise<IsoExportManifest> {
  const { dir, context, doc } = input;
  const formats = input.formats ?? {};
  const wantPng = formats.png !== false;
  const wantJson = formats.json !== false;
  const wantTilesets = formats.tilesets === true;
  const scale = Math.max(1, Math.round(formats.scale ?? 1));
  const files: IsoExportedFile[] = [];
  const warnings: string[] = [];
  const manifest: IsoExportManifest = { files, warnings, bounds: planBounds(context, doc) };
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const write = async (path: string, content: Buffer | string, kind: string): Promise<void> => {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    await writeFile(file, data);
    files.push({ path, bytes: data.length, kind });
  };
  const writeJson = (path: string, value: unknown): Promise<void> => write(path, `${JSON.stringify(value, null, 2)}\n`, "json");
  const content: string[] = [];

  if (wantPng) {
    const lookup = input.lookup ?? (await decodeTilesets(input));
    const raster = rasterizeIso(context, doc, lookup, { scale });
    manifest.bounds = raster.bounds;
    warnings.push(...raster.warnings);
    if (raster.drawn === 0) warnings.push("这张地图所有图层都是空的，导出的 PNG 是全透明的。");
    await write("map.png", isoBitmapToPng(raster.bitmap), "image");
    manifest.mapPng = "map.png";
    content.push("map.png");
  }

  if (wantTilesets) {
    for (const tileset of context.tilesets) {
      if (tileset.file === "") continue;
      const relative = tilesetExportPath(tileset.file);
      try {
        await write(relative, await readFile(input.tilesetPath(tileset.file)), "image");
        content.push(relative);
      } catch (error) {
        warnings.push(`素材「${tileset.name}」的原图没能放进包里（${error instanceof Error ? error.message : String(error)}）。`);
      }
    }
  }

  if (wantJson) {
    await writeJson("map.json", buildIsoJson(context, doc, input.project));
    manifest.mapJson = "map.json";
    content.push("map.json");
  }

  const wantZip = formats.zip === true || (formats.zip !== false && content.length > 1);
  if (wantZip && content.length > 0) {
    const entries: ZipEntry[] = [];
    for (const path of content) entries.push({ path, data: await readFile(join(dir, path)) });
    const zipName = `${safeFileName(doc.name, doc.id)}.zip`;
    await write(zipName, zipEntries(entries), "archive");
    manifest.mapZip = zipName;
  }

  await writeJson("manifest.json", { ...manifest, files: [...manifest.files, { path: "manifest.json", bytes: 0, kind: "json" }] });
  return manifest;
}

/** 兼容旧调用：只算导出用的包围盒。 */
export function isoExportBounds(context: IsoRenderContext, doc: IsoDoc): IsoBounds {
  return planBounds(context, doc);
}

/** 导出时给界面 / 工具看的素材说明（当前未用，保留一个明确入口）。 */
export function tilesetFileName(tileset: IsoTileset): string {
  return tilesetExportPath(tileset.file);
}
