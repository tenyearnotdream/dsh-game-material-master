/**
 * 45° 地图编辑器（模块五 · iso）的**内置示例素材**生成器。
 *
 * 纯程序化、确定性、零外部请求、零计费。每次生成同一份输入 → 逐字节一致，
 * 所以「恢复默认素材」不会因为时间 / 随机数变出另一套画风。
 *
 * 约定与 `isotiles` 完全一致：
 * - 地面：每格一张图，菱形在单元格里居中；
 * - 自动连接：严格 4×4 = 16 块，行优先 mask 0..15，N=1 / E=2 / S=4 / W=8；
 * - 物件：一张完整图，透明背景，底面中心在图片底边中点，可以高出单元格。
 */
import { encodePng } from "./png.js";
import { DEFAULT_ISO_CELL } from "./isogeom.js";
function makeBitmap(width, height) {
    return { width, height, rgba: Buffer.alloc(width * height * 4) };
}
function hash(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + seed * 1442695040888963407) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}
function setPixel(bitmap, x, y, color, alpha = 255) {
    if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height || alpha <= 0)
        return;
    const offset = (Math.floor(y) * bitmap.width + Math.floor(x)) * 4;
    const a = Math.min(1, alpha / 255);
    const inv = 1 - a;
    bitmap.rgba[offset] = Math.round(color.r * a + bitmap.rgba[offset] * inv);
    bitmap.rgba[offset + 1] = Math.round(color.g * a + bitmap.rgba[offset + 1] * inv);
    bitmap.rgba[offset + 2] = Math.round(color.b * a + bitmap.rgba[offset + 2] * inv);
    bitmap.rgba[offset + 3] = Math.max(bitmap.rgba[offset + 3], Math.round(a * 255));
}
function inDiamond(x, y, cell) {
    const cx = cell.width / 2;
    const cy = cell.height / 2;
    return Math.abs(x + 0.5 - cx) / (cell.width / 2) + Math.abs(y + 0.5 - cy) / (cell.width / 4) <= 1;
}
function fillDiamond(bitmap, cell, originX, originY, color, shade) {
    const cx = originX + cell.width / 2;
    const cy = originY + cell.height / 2;
    const halfW = cell.width / 2;
    const halfH = cell.width / 4;
    for (let y = Math.floor(cy - halfH); y <= Math.ceil(cy + halfH); y++) {
        for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
            const d = Math.abs(x + 0.5 - cx) / halfW + Math.abs(y + 0.5 - cy) / halfH;
            // 多铺 1%：相邻菱形共享的那条边必须两边都盖到，否则会留一条透明缝
            // （真机表现就是水面上每一格都有一圈深色网格线）。
            if (d > 1.01)
                continue;
            const edge = shade !== undefined && d > 0.9;
            setPixel(bitmap, x, y, edge ? shade : color, 255);
        }
    }
}
function fillTriangle(bitmap, points, color, alpha = 255) {
    const minX = Math.floor(Math.min(...points.map((point) => point[0])));
    const maxX = Math.ceil(Math.max(...points.map((point) => point[0])));
    const minY = Math.floor(Math.min(...points.map((point) => point[1])));
    const maxY = Math.ceil(Math.max(...points.map((point) => point[1])));
    const edge = (a, b, px, py) => (px - a[0]) * (b[1] - a[1]) - (py - a[1]) * (b[0] - a[0]);
    const [a, b, c] = points;
    const area = edge(a, b, c[0], c[1]);
    if (area === 0)
        return;
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            const e0 = edge(a, b, px, py);
            const e1 = edge(b, c, px, py);
            const e2 = edge(c, a, px, py);
            if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0))
                setPixel(bitmap, x, y, color, alpha);
        }
    }
}
function fillRect(bitmap, x, y, width, height, color, alpha = 255) {
    for (let yy = Math.floor(y); yy < Math.ceil(y + height); yy++) {
        for (let xx = Math.floor(x); xx < Math.ceil(x + width); xx++)
            setPixel(bitmap, xx, yy, color, alpha);
    }
}
function fillEllipse(bitmap, cx, cy, rx, ry, color, alpha = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
            const dx = (x + 0.5 - cx) / rx;
            const dy = (y + 0.5 - cy) / ry;
            if (dx * dx + dy * dy <= 1)
                setPixel(bitmap, x, y, color, alpha);
        }
    }
}
const COLORS = {
    grass: { r: 96, g: 168, b: 84 },
    grassDark: { r: 62, g: 124, b: 60 },
    grassLight: { r: 142, g: 198, b: 96 },
    dirt: { r: 166, g: 126, b: 82 },
    dirtDark: { r: 122, g: 88, b: 56 },
    stone: { r: 142, g: 146, b: 152 },
    stoneDark: { r: 96, g: 100, b: 108 },
    water: { r: 64, g: 128, b: 198 },
    waterDark: { r: 38, g: 92, b: 158 },
    sand: { r: 214, g: 192, b: 132 },
    sandDark: { r: 178, g: 154, b: 96 },
    trunk: { r: 112, g: 76, b: 48 },
    leaf: { r: 58, g: 132, b: 66 },
    leafDark: { r: 38, g: 96, b: 50 },
    roof: { r: 158, g: 78, b: 58 },
    roofDark: { r: 112, g: 52, b: 42 },
    wall: { r: 206, g: 194, b: 166 },
    wallDark: { r: 160, g: 148, b: 122 }
};
/** 一张地面图的单个格子（带一点确定性纹理，避免纯色看起来像塑料）。 */
function drawGroundTile(bitmap, cell, originX, originY, base, dark, seed) {
    // 地面是「一整片」而不是一块块铺的：**不要给每格加边线**，否则相邻两格各压一道
    // 深色边，拼起来就是一张网格。纹理也只在内部随机，不碰菱形边。
    fillDiamond(bitmap, cell, originX, originY, base);
    const cx = originX + cell.width / 2;
    const cy = originY + cell.height / 2;
    const count = Math.max(8, Math.round(cell.width * 0.7));
    for (let i = 0; i < count; i++) {
        const angle = (hash(i, seed, 1) % 10000) / 10000;
        const q = (hash(i, seed, 2) % 10000) / 10000;
        const dx = (q - 0.5) * cell.width * 0.7;
        const dy = (angle - 0.5) * cell.width * 0.34;
        const x = Math.floor(cx + dx + dy * 2);
        const y = Math.floor(cy + dy - dx * 0.5);
        if (!inDiamond(x, y, cell))
            continue;
        const light = (hash(i, seed, 3) & 1) === 0;
        setPixel(bitmap, x, y, light ? COLORS.grassLight : dark, 180);
    }
}
function drawWaterTile(bitmap, cell, originX, originY, frame) {
    /**
     * 内置水面用**整块同色**，只按帧轻微变色。
     *
     * 为什么不做条纹 / 波纹：单块图块要在所有格子上重复，任何「只有内部有、边缘没有」
     * 的纹理都会在相邻两格之间留下一条底色边；等距菱形上就连成一张深色网格线
     * （真机截图：「素材拼起来有缝」）。整块同色在任意拼接下都没有接缝。
     */
    const shade = frame % 2 === 0 ? { r: 64, g: 128, b: 198 } : { r: 74, g: 140, b: 208 };
    fillDiamond(bitmap, cell, originX, originY, shade);
}
function drawAutotileTile(bitmap, cell, originX, originY, mask) {
    fillDiamond(bitmap, cell, originX, originY, COLORS.sand, COLORS.sandDark);
    const cx = originX + cell.width / 2;
    const cy = originY + cell.height / 2;
    const top = [cx, cy - cell.width / 4];
    const right = [cx + cell.width / 2, cy];
    const bottom = [cx, cy + cell.width / 4];
    const left = [cx - cell.width / 2, cy];
    const center = [cx, cy];
    if ((mask & 1) !== 0)
        fillTriangle(bitmap, [top, right, center], COLORS.water);
    if ((mask & 2) !== 0)
        fillTriangle(bitmap, [right, bottom, center], COLORS.water);
    if ((mask & 4) !== 0)
        fillTriangle(bitmap, [bottom, left, center], COLORS.water);
    if ((mask & 8) !== 0)
        fillTriangle(bitmap, [left, top, center], COLORS.water);
    // 岸线：水与沙之间压一道深色，避免两种纯色直接相接。
    for (let y = Math.floor(cy - cell.width / 4); y <= Math.ceil(cy + cell.width / 4); y++) {
        for (let x = Math.floor(cx - cell.width / 2); x <= Math.ceil(cx + cell.width / 2); x++) {
            if (!inDiamond(x, y, cell))
                continue;
            const offset = (Math.floor(y) * bitmap.width + Math.floor(x)) * 4;
            if (bitmap.rgba[offset + 3] === 0)
                continue;
            const nearWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
                const nx = Math.floor(x) + dx;
                const ny = Math.floor(y) + dy;
                if (nx < 0 || ny < 0 || nx >= bitmap.width || ny >= bitmap.height)
                    return false;
                const no = (ny * bitmap.width + nx) * 4;
                return bitmap.rgba[no + 3] > 0 && bitmap.rgba[no + 2] > bitmap.rgba[no] + 20;
            });
            if (nearWater && bitmap.rgba[offset + 2] <= bitmap.rgba[offset] + 20)
                setPixel(bitmap, x, y, COLORS.sandDark, 200);
        }
    }
}
function drawTree(bitmap, cell, footprint) {
    const width = cell.width * footprint.cols;
    const height = Math.round(cell.height * 1.35);
    // bitmap 已由调用方按 width×height 建好
    const base = height;
    fillRect(bitmap, width / 2 - Math.max(3, Math.round(cell.width * 0.07)), base - Math.round(cell.width * 0.62), Math.max(6, Math.round(cell.width * 0.14)), Math.round(cell.width * 0.62), COLORS.trunk);
    fillEllipse(bitmap, width / 2, base - Math.round(cell.width * 0.78), cell.width * 0.34, cell.width * 0.26, COLORS.leafDark);
    fillEllipse(bitmap, width / 2 - cell.width * 0.16, base - Math.round(cell.width * 0.82), cell.width * 0.25, cell.width * 0.2, COLORS.leaf);
    fillEllipse(bitmap, width / 2 + cell.width * 0.16, base - Math.round(cell.width * 0.8), cell.width * 0.24, cell.width * 0.2, COLORS.leaf);
    fillEllipse(bitmap, width / 2, base - Math.round(cell.width * 0.98), cell.width * 0.28, cell.width * 0.22, COLORS.leaf);
    return new Array(footprint.cols * footprint.rows).fill(1);
}
function drawRock(bitmap, cell, footprint) {
    const width = cell.width * footprint.cols;
    const height = Math.round(cell.height * 0.72);
    fillEllipse(bitmap, width / 2, height - cell.width * 0.18, cell.width * 0.32, cell.width * 0.2, COLORS.stoneDark);
    fillEllipse(bitmap, width / 2 - cell.width * 0.05, height - cell.width * 0.22, cell.width * 0.26, cell.width * 0.17, COLORS.stone);
    fillRect(bitmap, width / 2 - cell.width * 0.22, height - cell.width * 0.16, cell.width * 0.44, cell.width * 0.08, COLORS.stoneDark);
    return new Array(footprint.cols * footprint.rows).fill(1);
}
function drawBush(bitmap, cell, footprint) {
    const width = cell.width * footprint.cols;
    const height = Math.round(cell.height * 0.62);
    fillEllipse(bitmap, width / 2, height - cell.width * 0.18, cell.width * 0.3, cell.width * 0.18, COLORS.leafDark);
    fillEllipse(bitmap, width / 2 - cell.width * 0.12, height - cell.width * 0.22, cell.width * 0.2, cell.width * 0.14, COLORS.leaf);
    fillEllipse(bitmap, width / 2 + cell.width * 0.12, height - cell.width * 0.22, cell.width * 0.18, cell.width * 0.13, COLORS.leaf);
    return new Array(footprint.cols * footprint.rows).fill(1);
}
function drawBarrel(bitmap, cell, footprint) {
    const width = cell.width * footprint.cols;
    const height = Math.round(cell.height * 0.6);
    fillRect(bitmap, width / 2 - cell.width * 0.18, height - cell.width * 0.42, cell.width * 0.36, cell.width * 0.42, COLORS.dirtDark);
    fillRect(bitmap, width / 2 - cell.width * 0.18, height - cell.width * 0.36, cell.width * 0.36, cell.width * 0.05, COLORS.stoneDark);
    fillRect(bitmap, width / 2 - cell.width * 0.18, height - cell.width * 0.22, cell.width * 0.36, cell.width * 0.05, COLORS.stoneDark);
    return new Array(footprint.cols * footprint.rows).fill(1);
}
function drawHouse(bitmap, cell, footprint) {
    const width = cell.width * footprint.cols;
    const height = Math.round(cell.height * 1.65);
    const wallW = width * 0.62;
    const wallH = height * 0.42;
    const left = (width - wallW) / 2;
    const wallTop = height - wallH;
    fillRect(bitmap, left, wallTop, wallW, wallH, COLORS.wall);
    fillRect(bitmap, left, wallTop + wallH - cell.width * 0.06, wallW, cell.width * 0.06, COLORS.wallDark);
    // 屋顶：一个梯形 + 深色檐口
    for (let y = 0; y < Math.round(wallH * 0.9); y++) {
        const t = y / Math.max(1, wallH * 0.9);
        const half = (wallW * (0.62 + 0.38 * t)) / 2;
        fillRect(bitmap, width / 2 - half, wallTop - Math.round(wallH * 0.9) + y, half * 2, 1, t > 0.82 ? COLORS.roofDark : COLORS.roof);
    }
    fillRect(bitmap, width / 2 - cell.width * 0.07, height - wallH - cell.width * 0.02, cell.width * 0.14, wallH * 0.5, COLORS.roofDark);
    fillRect(bitmap, left + wallW * 0.16, wallTop + wallH * 0.22, wallW * 0.16, wallH * 0.22, COLORS.waterDark);
    fillRect(bitmap, left + wallW * 0.68, wallTop + wallH * 0.22, wallW * 0.16, wallH * 0.22, COLORS.waterDark);
    return new Array(footprint.cols * footprint.rows).fill(1);
}
function sample(name, file, kind, cell, bitmap, extra) {
    return {
        name,
        file,
        kind,
        cell,
        builtin: true,
        bytes: encodePng(bitmap.rgba, bitmap.width, bitmap.height),
        ...extra
    };
}
/** 生成整套内置素材。同一 `cell` 两次生成逐字节一致。 */
export function renderIsoSamples(cell = DEFAULT_ISO_CELL) {
    const out = [];
    // 地面：静态 2 个变体；水面 2 个变体 × 2 帧。
    const groundDefs = [
        { name: "草地", file: "iso-grass.png", base: COLORS.grass, dark: COLORS.grassDark, frames: 1, animRows: false },
        { name: "泥土", file: "iso-dirt.png", base: COLORS.dirt, dark: COLORS.dirtDark, frames: 1, animRows: false },
        { name: "石地", file: "iso-stone.png", base: COLORS.stone, dark: COLORS.stoneDark, frames: 1, animRows: false },
        { name: "水面", file: "iso-water.png", base: COLORS.water, dark: COLORS.waterDark, frames: 2, animRows: true, water: true }
    ];
    for (const [index, def] of groundDefs.entries()) {
        const columns = 2;
        const bitmap = makeBitmap(cell.width * columns, cell.height * def.frames);
        for (let frame = 0; frame < def.frames; frame++) {
            for (let column = 0; column < columns; column++) {
                if (def.water === true)
                    drawWaterTile(bitmap, cell, column * cell.width, frame * cell.height, frame + column);
                else
                    drawGroundTile(bitmap, cell, column * cell.width, frame * cell.height, def.base, def.dark, index * 10 + column);
            }
        }
        out.push(sample(def.name, def.file, "ground", cell, bitmap, { frames: def.frames, animRows: def.animRows }));
    }
    // 自动连接：4×4，行优先 mask 0..15。
    {
        const bitmap = makeBitmap(cell.width * 4, cell.height * 4);
        for (let mask = 0; mask < 16; mask++) {
            drawAutotileTile(bitmap, cell, (mask % 4) * cell.width, Math.floor(mask / 4) * cell.height, mask);
        }
        out.push(sample("水岸", "iso-shore.png", "autotile", cell, bitmap, { frames: 1, animRows: false }));
    }
    // 物件：底面中心在图片底边中点。
    const objects = [
        { name: "松树", file: "iso-tree.png", footprint: { cols: 1, rows: 1 }, height: Math.round(cell.height * 1.35), draw: drawTree },
        { name: "石头", file: "iso-rock.png", footprint: { cols: 1, rows: 1 }, height: Math.round(cell.height * 0.72), draw: drawRock },
        { name: "灌木", file: "iso-bush.png", footprint: { cols: 1, rows: 1 }, height: Math.round(cell.height * 0.62), draw: drawBush },
        { name: "木桶", file: "iso-barrel.png", footprint: { cols: 1, rows: 1 }, height: Math.round(cell.height * 0.6), draw: drawBarrel },
        { name: "石屋", file: "iso-house.png", footprint: { cols: 2, rows: 2 }, height: Math.round(cell.height * 1.65), draw: drawHouse }
    ];
    for (const def of objects) {
        const width = cell.width * def.footprint.cols;
        const bitmap = makeBitmap(width, def.height);
        const pass = def.draw(bitmap, cell, def.footprint);
        out.push(sample(def.name, def.file, "object", cell, bitmap, { frames: 1, animRows: false, footprint: def.footprint, pass }));
    }
    return out;
}
