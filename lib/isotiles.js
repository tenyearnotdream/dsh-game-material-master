/**
 * 45° 地图编辑器（模块五 · iso）的**素材模型与切分**。
 *
 * 三种用法，几何都由本文件定：
 *
 * | kind | 图片排布 | 切出来是什么 |
 * |---|---|---|
 * | `ground` | 网格，每格一块 | 静态时每块一个笔刷；`animRows` 时每列一个笔刷、每行一帧 |
 * | `autotile` | 严格 4×4 = 16 块 | 按 N=1 / E=2 / S=4 / W=8 的 mask 0..15（行优先） |
 * | `object` | 一张完整图（多帧竖排） | 每帧一个整图 rect；占格 / 锚点 / 通行性单独记 |
 *
 * ## 为什么不复用 `MapTileset.shape` 的 a2quad / stamp
 *
 * 模块六的 A2 是「2×2 小格拼一个逻辑块」，整图是「把一张画切成 N×M 格」。
 * 等距物件不能被切成格子：它是一张完整图，必须按底面中心整张摆放，否则
 * 高处（屋顶 / 树冠）会被切碎。所以物件在这里是**自己的切分**，只借用
 * `MapTile` 的 `rect` 与全局序号思路。
 *
 * 地面 / 自动连接则直接复用 `maptiles.buildTiles`：形状顺序、序号顺序、
 * 按矩形 id 保留人工元数据这些约定，两边没有理由各写一份。
 */
import { buildTiles, parseAssetFps, parseAssetLoop, parseClarity, tileIdFor, flatTiles } from "./maptiles.js";
import { normalizeFootprint } from "./isogeom.js";
export const ISO_TILESET_KINDS = ["ground", "autotile", "object"];
export function isIsoTilesetKind(value) {
    return value === "ground" || value === "autotile" || value === "object";
}
/** 界面 / 工具面传上来的用法收口：不合法**明确报错**，不静默改成别的值。 */
export function parseIsoTilesetKind(value) {
    if (value === undefined || value === null || value === "")
        return "ground";
    if (!isIsoTilesetKind(value))
        throw new Error(`未知素材用法：${String(value)}（可选 ground / autotile / object）`);
    return value;
}
/** 物件大小的上下限（界面与宿主共用同一口径）。 */
export const ISO_OBJECT_SCALE_MIN = 0.1;
export const ISO_OBJECT_SCALE_MAX = 4;
/**
 * 「新增素材」里物件大小的收口：`1` = 图片宽度正好占满占格。
 *
 * 不合法**明确报错**（别静默夹成边界值 —— 用户会以为自己的输入生效了）。
 */
export function parseIsoObjectScale(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) {
        throw new Error(`物件大小必须是 ${ISO_OBJECT_SCALE_MIN * 100}%~${ISO_OBJECT_SCALE_MAX * 100}% 之间的数字，收到 ${String(value)}`);
    }
    if (n < ISO_OBJECT_SCALE_MIN || n > ISO_OBJECT_SCALE_MAX) {
        throw new Error(`物件大小必须在 ${ISO_OBJECT_SCALE_MIN * 100}%~${ISO_OBJECT_SCALE_MAX * 100}% 之间，收到 ${Math.round(n * 100)}%`);
    }
    return Math.round(n * 1000) / 1000;
}
/** 由 kind 推 buildTiles 用的形状。 */
export function shapeOfKind(kind) {
    return kind === "autotile" ? "corner16" : "plain";
}
/** 自动连接的位序（与模块六 / AsLib 同一套：N=1 E=2 S=4 W=8）。 */
export const ISO_AUTOTILE_MASKS = Array.from({ length: 16 }, (_unused, index) => index);
/** 自动连接必须是 4×4 = 16 块；不是就明确拒绝，不猜顺序。 */
export const ISO_AUTOTILE_COUNT = 16;
export function parseIsoAnchor(value) {
    if (value === undefined || value === null)
        return undefined;
    const raw = value;
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        throw new Error(`物件锚点不合法：${JSON.stringify(value)}（x / y 应为 0~1）`);
    }
    return { x, y };
}
/** 通行性数组收口：长度必须等于占格数；不合法明确报错，不静默补齐。 */
export function parsePassCells(value, footprint) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value))
        throw new Error("逐格通行性必须是数组");
    const expected = footprint.cols * footprint.rows;
    if (value.length !== expected) {
        throw new Error(`逐格通行性应有 ${expected} 项（${footprint.cols}×${footprint.rows}），收到 ${value.length}`);
    }
    return value.map((entry, index) => {
        const n = Number(entry);
        if (n !== 0 && n !== 1 && n !== 2)
            throw new Error(`第 ${index + 1} 格通行性只能是 0 / 1 / 2，收到 ${String(entry)}`);
        return n;
    });
}
/** 默认全部「可通过·角色在上面」。 */
export function defaultPass(footprint) {
    return new Array(footprint.cols * footprint.rows).fill(1);
}
/**
 * 物件切分：一张完整图，多帧竖排。
 *
 * 每帧的 rect = 整张图宽 × 一帧高。帧高必须整除图片高；不整除就明确拒绝
 * （按「大概几帧」去凑会让每一帧都错位，而且不报错）。
 */
export function buildObjectTiles(input, previous = []) {
    const frames = Math.max(1, Math.round(input.frames));
    if (!Number.isInteger(input.imageHeight / frames) || input.imageHeight % frames !== 0) {
        throw new Error(`物件图高 ${input.imageHeight} 不能被帧数 ${frames} 整除`);
    }
    const frameHeight = input.imageHeight / frames;
    const previousById = new Map(previous.map((tile) => [tile.id, tile]));
    const out = [];
    for (let frame = 0; frame < frames; frame++) {
        const rect = { x: 0, y: frame * frameHeight, width: input.imageWidth, height: frameHeight };
        const id = tileIdFor(rect);
        const old = previousById.get(id);
        const tile = old === undefined ? { id, rect, name: id } : { ...old };
        tile.id = id;
        tile.rect = rect;
        if (typeof tile.name !== "string" || tile.name === "")
            tile.name = id;
        delete tile.shape;
        delete tile.variant;
        delete tile.mask;
        delete tile.stamp;
        tile.frame = frame;
        out.push(tile);
    }
    return out;
}
/** 自动连接：4×4 行优先，第 i 块的 mask = i。 */
function assignAutotileMasks(tiles) {
    for (let index = 0; index < tiles.length; index++) {
        if (tiles[index] !== undefined)
            tiles[index].mask = index;
    }
}
/**
 * 由几何字段重建 `tiles`（读盘自愈 / 改格后重切共用）。
 *
 * 与模块六 `buildTiles` 一样，按矩形 id 保留旧 tile 的人工字段；
 * 几何派生字段（rect / frame / mask）必须覆盖，否则块号会与矩形对不上。
 */
export function rebuildIsoTiles(input, previous = []) {
    if (input.kind === "object") {
        return buildObjectTiles({ imageWidth: input.imageWidth, imageHeight: input.imageHeight, frames: input.frames }, previous);
    }
    const shape = shapeOfKind(input.kind);
    const tiles = buildTiles({
        shape,
        cell: { width: input.cell.width, height: input.cell.height },
        imageWidth: input.imageWidth,
        imageHeight: input.imageHeight,
        animRows: input.kind === "ground" && input.animRows === true
    }, previous);
    if (input.kind === "autotile")
        assignAutotileMasks(tiles);
    return tiles;
}
/**
 * 由几何字段推「调色板笔刷 / 帧数」。
 *
 * - 静态地面：每个格子都是独立笔刷；
 * - 动画地面（animRows）：每列一个笔刷，行 = 帧；
 * - 自动连接：一个笔刷（满接图块）；
 * - 物件：一个笔刷（第 0 帧整图）。
 */
export function paletteOf(tileset, allTilesets = [tileset]) {
    // ⚠️ 必须用**全项目**的展平表：只传这一张素材的话，序号会从 1 重新开始，
    // 第二张素材的笔刷就会画成第一张的图（不报错，只是画错）。
    const flat = flatTiles(allTilesets).filter((item) => item.tilesetId === tileset.id);
    if (tileset.kind === "autotile") {
        const full = tileset.tiles.find((tile) => tile.mask === 15) ?? tileset.tiles[tileset.tiles.length - 1];
        const entry = flat.find((item) => item.tile === full);
        return entry === undefined ? [] : [{ index: entry.index, rect: entry.tile.rect }];
    }
    if (tileset.kind === "object") {
        const first = tileset.tiles.find((tile) => (tile.frame ?? 0) === 0) ?? tileset.tiles[0];
        const entry = flat.find((item) => item.tile === first);
        return entry === undefined ? [] : [{ index: entry.index, rect: entry.tile.rect }];
    }
    if (tileset.animRows === true && tileset.frames > 1) {
        const first = flat.filter((item) => (item.tile.frame ?? 0) === 0);
        return first.map((item) => ({ index: item.index, rect: item.tile.rect }));
    }
    return flat.map((item) => ({ index: item.index, rect: item.tile.rect }));
}
/** 素材说明（界面列表上的一行小字）。 */
export function isoReason(tileset) {
    if (tileset.kind === "object") {
        const fp = tileset.footprint ?? { cols: 1, rows: 1 };
        const scale = tileset.objectScale;
        const size = scale !== undefined && Math.abs(scale - 1) > 0.0005 ? `、大小 ${Math.round(scale * 100)}%` : "";
        return `物件：占 ${fp.cols}×${fp.rows} 格${size}${tileset.frames > 1 ? `、${tileset.frames} 帧` : ""}`;
    }
    if (tileset.kind === "autotile")
        return `自动连接：4×4 = 16 块（${tileset.cell.width}×${tileset.cell.height}）`;
    return `地面：${tileset.columns} 列${tileset.frames > 1 ? ` × ${tileset.frames} 帧` : ""}（${tileset.cell.width}×${tileset.cell.height}）`;
}
export function briefOf(tileset, rev, allTilesets = [tileset]) {
    return {
        id: tileset.id,
        name: tileset.name,
        file: tileset.file,
        imageWidth: tileset.imageWidth,
        imageHeight: tileset.imageHeight,
        cell: tileset.cell,
        kind: tileset.kind,
        columns: tileset.columns,
        frames: tileset.frames,
        variants: tileset.variants,
        animRows: tileset.animRows,
        footprint: tileset.footprint,
        anchor: tileset.anchor,
        objectScale: tileset.objectScale,
        loop: tileset.loop,
        fps: tileset.fps,
        clarity: tileset.clarity,
        builtin: tileset.builtin === true ? true : undefined,
        rev,
        tileCount: tileset.tiles.length,
        reason: isoReason(tileset),
        palette: paletteOf(tileset, allTilesets)
    };
}
/** 读盘 / 外部输入 → 合法用法字段。不合法时明确报错。 */
export function normalizeAssetFrames(value, fallback = 1) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 64)
        throw new Error(`帧数必须是 1~64 的整数，收到 ${String(value)}`);
    return n;
}
export function normalizeAssetClarity(value) {
    return parseClarity(value);
}
export function normalizeAssetFps(value) {
    return parseAssetFps(value);
}
export function normalizeAssetLoop(value) {
    return parseAssetLoop(value);
}
/** 只用一次：导出 JSON 的图块表需要它。 */
export function flatOf(tilesets) {
    return flatTiles(tilesets);
}
export { normalizeFootprint };
