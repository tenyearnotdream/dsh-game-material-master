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
import { decodeFile } from "./bitmap.js";
import { buildIsoPlan, isoBitmapToPng, passCellsOf, planBounds, rasterizeIso } from "./isorender.js";
import { safeFileName } from "./mapexport.js";
import { zipEntries } from "./zip.js";
export const OWN_ISO_JSON_FORMAT = "dsh-gem-iso-map@1";
/** `dsh-gem-iso-map@1` 的内容。 */
export function buildIsoJson(context, doc, project) {
    const legend = buildIsoPlan(context, doc, { includeLegend: true }).legend;
    return {
        format: OWN_ISO_JSON_FORMAT,
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
        markers: doc.markers.map((marker, index) => ({ n: index + 1, name: marker.name, r: marker.r, c: marker.c })),
        pass: passCellsOf(context, doc)
    };
}
async function decodeTilesets(input) {
    const out = new Map();
    for (const tileset of input.context.tilesets) {
        if (tileset.file === "")
            continue;
        const bitmap = await decodeFile(input.tilesetPath(tileset.file)).catch(() => undefined);
        if (bitmap !== undefined)
            out.set(tileset.id, bitmap);
    }
    return out;
}
function tilesetExportPath(file) {
    const name = file.split(/[\\/]/u).pop() ?? "";
    return `tilesets/${name}`;
}
export async function exportIsoMap(input) {
    const { dir, context, doc } = input;
    const formats = input.formats ?? {};
    const wantPng = formats.png !== false;
    const wantJson = formats.json !== false;
    const wantTilesets = formats.tilesets === true;
    const scale = Math.max(1, Math.round(formats.scale ?? 1));
    const files = [];
    const warnings = [];
    const manifest = { files, warnings, bounds: planBounds(context, doc) };
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const write = async (path, content, kind) => {
        const file = join(dir, path);
        await mkdir(dirname(file), { recursive: true });
        const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        await writeFile(file, data);
        files.push({ path, bytes: data.length, kind });
    };
    const writeJson = (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`, "json");
    const content = [];
    if (wantPng) {
        const lookup = input.lookup ?? (await decodeTilesets(input));
        const raster = rasterizeIso(context, doc, lookup, { scale });
        manifest.bounds = raster.bounds;
        warnings.push(...raster.warnings);
        if (raster.drawn === 0)
            warnings.push("这张地图所有图层都是空的，导出的 PNG 是全透明的。");
        await write("map.png", isoBitmapToPng(raster.bitmap), "image");
        manifest.mapPng = "map.png";
        content.push("map.png");
    }
    if (wantTilesets) {
        for (const tileset of context.tilesets) {
            if (tileset.file === "")
                continue;
            const relative = tilesetExportPath(tileset.file);
            try {
                await write(relative, await readFile(input.tilesetPath(tileset.file)), "image");
                content.push(relative);
            }
            catch (error) {
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
        const entries = [];
        for (const path of content)
            entries.push({ path, data: await readFile(join(dir, path)) });
        const zipName = `${safeFileName(doc.name, doc.id)}.zip`;
        await write(zipName, zipEntries(entries), "archive");
        manifest.mapZip = zipName;
    }
    await writeJson("manifest.json", { ...manifest, files: [...manifest.files, { path: "manifest.json", bytes: 0, kind: "json" }] });
    return manifest;
}
/** 兼容旧调用：只算导出用的包围盒。 */
export function isoExportBounds(context, doc) {
    return planBounds(context, doc);
}
/** 导出时给界面 / 工具看的素材说明（当前未用，保留一个明确入口）。 */
export function tilesetFileName(tileset) {
    return tilesetExportPath(tileset.file);
}
