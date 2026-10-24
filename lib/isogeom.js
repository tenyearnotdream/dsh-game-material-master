/**
 * 45° 地图编辑器（模块五 · iso）的**几何内核**：纯函数、不碰磁盘、不碰网络。
 *
 * 只有一种格网：**2:1 正交等距**（宽是高的两倍）。这是本模块可靠性的前提，
 * 也是旧模块五（已删除的 AI 地块生成）留下的研究结论。这里不做可切换格网：
 * 正方格俯视由模块六（map）负责，两套口径混在一个文件里迟早会互相污染。
 *
 * ## 坐标口径
 *
 * 世界坐标以格子 (0,0) 的**菱形中心**为原点：
 *
 *   cellCenter(r,c) = { x: (c - r) * stepX, y: (c + r) * stepY }
 *
 * 其中 `stepX = cell.width / 2`、`stepY = cell.width / 4` ——
 * **stepY 来自菱形高（= cellWidth/2）的一半，不是 cellHeight/4**。
 * 写成 cellHeight/4 会得到 24（正确 16），整张图就裂了。
 *
 * 因此计划里的 `x/y` 可以是负数；导出 / 相机用 `bounds.originX/originY` 平移。
 *
 * ## 命中测试（容易写成 floor 的地方）
 *
 * 菱形在 (r,c) 坐标里其实是一个**正方形**：对某点做线性反解得到实数 r/c 后，
 * 最近格 = `floor(v + 0.5)`。用 `floor(rReal)` 会在上半格整片偏一格 ——
 * 而且只在菱形的斜边上显形，看起来像「偶尔点不中」。
 *
 * ## 环绕
 *
 * 与模块六同款环面：格坐标允许为负、允许越界，读格取模；像素位置照线性公式算。
 * 视口某一维超过整张地图时收在**地图自己那一轮**，不按视口起点起算。
 */
/** 默认单元格：64×96。菱形高 32、上下各留 32 给高出地面的物件。 */
export const DEFAULT_ISO_CELL = { width: 64, height: 96 };
/** 单边最大格数（与模块六同一档；真正防 OOM 的是导出像素上限）。 */
export const MAX_ISO_DIM = 512;
export const MAX_ISO_CELLS = MAX_ISO_DIM * MAX_ISO_DIM;
/** 计划分块边长（格）。与模块六相同，只影响缓存粒度，不影响落盘格式。 */
export const ISO_CHUNK_SIZE = 8;
/** 一次计划最多回多少块（按面积折算：块数 × 块边长² = 一张最大地图）。 */
export const MAX_ISO_PLAN_CHUNKS = Math.ceil((MAX_ISO_DIM * MAX_ISO_DIM) / (ISO_CHUNK_SIZE * ISO_CHUNK_SIZE));
/** 物件数量硬上限：防止一篇文章式的项目把计划撑爆。 */
export const MAX_ISO_OBJECTS = 20_000;
/** 把任意输入收敛成一份合法单元格；**形状不合法不修**，交给 `assertCell` 抛。 */
export function normalizeIsoCell(input) {
    const raw = (input ?? {});
    const int = (value, fallback) => {
        const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
        return Number.isFinite(n) ? Math.round(n) : fallback;
    };
    return {
        width: int(raw.width, DEFAULT_ISO_CELL.width),
        height: int(raw.height, DEFAULT_ISO_CELL.height)
    };
}
/** 单元格是否合法；不合法抛 `Error`（文案要能直接告诉用户改成什么）。 */
export function assertIsoCell(cell) {
    if (!Number.isInteger(cell.width) || cell.width < 16 || cell.width > 512) {
        throw new Error(`格子宽必须是 16~512 的整数，收到 ${String(cell.width)}`);
    }
    if (cell.width % 4 !== 0) {
        throw new Error(`格子宽必须能被 4 整除（菱形半宽 / 半高要落在整数像素上），收到 ${cell.width}`);
    }
    if (!Number.isInteger(cell.height) || cell.height < 32 || cell.height > 768) {
        throw new Error(`格子高必须是 32~768 的整数，收到 ${String(cell.height)}`);
    }
    if (cell.height <= cell.width / 2) {
        throw new Error(`格子高（${cell.height}）必须大于菱形高（${cell.width / 2}），否则地块会被裁掉`);
    }
}
export function assertIsoMapSize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        throw new Error(`地图尺寸必须是正整数，收到 ${cols}×${rows}`);
    }
    if (cols > MAX_ISO_DIM || rows > MAX_ISO_DIM) {
        throw new Error(`地图单边最多 ${MAX_ISO_DIM} 格，收到 ${cols}×${rows}。请把地图改小或把格子调大。`);
    }
}
export function layoutOf(cell, cols, rows, wrap) {
    assertIsoCell(cell);
    assertIsoMapSize(cols, rows);
    return {
        cell: { width: cell.width, height: cell.height },
        cols,
        rows,
        wrap,
        stepX: cell.width / 2,
        stepY: cell.width / 4,
        diamondHeight: cell.width / 2
    };
}
// ── 环绕 ─────────────────────────────────────────────────────────────────
function mod(value, size) {
    const rest = value % size;
    return rest < 0 ? rest + size : rest;
}
export function wrapRow(layout, r) {
    return layout.wrap ? mod(r, layout.rows) : r;
}
export function wrapCol(layout, c) {
    return layout.wrap ? mod(c, layout.cols) : c;
}
export function wrapCell(layout, r, c) {
    return { r: wrapRow(layout, r), c: wrapCol(layout, c) };
}
// ── 格子 ↔ 像素 ──────────────────────────────────────────────────────────
/** 格子中心（= 菱形中心）。 */
export function cellCenter(layout, r, c) {
    return { x: (c - r) * layout.stepX, y: (c + r) * layout.stepY };
}
/**
 * 一张「整格贴图」贴在格子上时的左上角。
 *
 * 贴图内部菱形必须居中（内置素材与导入素材都按这个约定生成）：
 * 左上角 = 菱形中心 − 贴图尺寸的一半。
 */
export function cellTopLeft(layout, r, c, width, height) {
    const center = cellCenter(layout, r, c);
    return { x: center.x - width / 2, y: center.y - height / 2 };
}
export function normalizeFootprint(input) {
    const raw = (input ?? {});
    const int = (value, fallback) => {
        const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
        return Number.isFinite(n) ? Math.round(n) : fallback;
    };
    return { cols: Math.max(1, int(raw.cols, 1)), rows: Math.max(1, int(raw.rows, 1)) };
}
/**
 * 物件**底面中心**：占格各格菱形中心的包围盒中点。
 *
 * 推导：占格 r..r+rows-1、c..c+cols-1，中心坐标是线性的，
 * 所以平均下来 x 多出 `(cols−rows)/2` 个 stepX、y 多出 `(cols+rows−2)/2` 个 stepY。
 * 1×1 时正好退回格子中心；2×2 时落在四格正中（不是锚点格中心）。
 */
export function objectBase(layout, r, c, footprint) {
    return {
        x: (c - r + (footprint.cols - footprint.rows) / 2) * layout.stepX,
        y: (c + r + (footprint.cols + footprint.rows - 2) / 2) * layout.stepY
    };
}
/** 物件图片左上角：底面中心 − 图片尺寸 × 锚点。默认锚点 = 底边中点。 */
export function objectTopLeft(layout, r, c, footprint, imageWidth, imageHeight, anchor = { x: 0.5, y: 1 }) {
    const base = objectBase(layout, r, c, footprint);
    return { x: base.x - imageWidth * anchor.x, y: base.y - imageHeight * anchor.y };
}
/** 物件占到的每一格（**不取模**；调用方按 layout.wrap 决定是否 wrap）。 */
export function footprintCells(r, c, footprint) {
    const out = [];
    for (let dr = 0; dr < footprint.rows; dr++) {
        for (let dc = 0; dc < footprint.cols; dc++)
            out.push({ r: r + dr, c: c + dc });
    }
    return out;
}
/** 物件是否完全落在地图内（允许环绕时按取模判断，但占格必须能一一落回图内）。 */
export function footprintInside(layout, r, c, footprint) {
    // 物件是一张完整图，不跨环绕接缝：占格必须在 0..rows / 0..cols 内。
    // 允许 wrap 的话，贴边物件会被切成两半（一半在另一头），而图片只有一张。
    for (const cell of footprintCells(r, c, footprint)) {
        if (cell.r < 0 || cell.c < 0 || cell.r >= layout.rows || cell.c >= layout.cols)
            return false;
    }
    return true;
}
/**
 * 像素 → 格子，**不取模**。
 *
 * 反解公式见文件头。`floor(v + 0.5)` 对负数也对称（-0.5 落到 0），
 * 与客户端 `ISO_pointToCell` 逐字一致。
 */
export function pointToCellRaw(layout, x, y) {
    const cReal = (x / layout.stepX + y / layout.stepY) / 2;
    const rReal = (y / layout.stepY - x / layout.stepX) / 2;
    const c = Math.floor(cReal + 0.5);
    const r = Math.floor(rReal + 0.5);
    return { r, c, inMap: r >= 0 && c >= 0 && r < layout.rows && c < layout.cols };
}
/** 像素 → 格子。环绕时取模且 `inMap` 恒 true。 */
export function pointToCell(layout, x, y) {
    const raw = pointToCellRaw(layout, x, y);
    if (!layout.wrap)
        return raw;
    return { r: wrapRow(layout, raw.r), c: wrapCol(layout, raw.c), inMap: true };
}
/** 网格脚印的像素包围盒（只按整格贴图算；物件由调用方另外扩）。 */
export function groundBounds(layout) {
    const { cell } = layout;
    const corners = [
        [0, 0],
        [0, layout.cols - 1],
        [layout.rows - 1, 0],
        [layout.rows - 1, layout.cols - 1]
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [r, c] of corners) {
        const topLeft = cellTopLeft(layout, r, c, cell.width, cell.height);
        if (topLeft.x < minX)
            minX = topLeft.x;
        if (topLeft.y < minY)
            minY = topLeft.y;
        if (topLeft.x + cell.width > maxX)
            maxX = topLeft.x + cell.width;
        if (topLeft.y + cell.height > maxY)
            maxY = topLeft.y + cell.height;
    }
    const originX = Math.floor(minX);
    const originY = Math.floor(minY);
    return { originX, originY, width: Math.ceil(maxX) - originX, height: Math.ceil(maxY) - originY };
}
export function expandBounds(bounds, rect) {
    const left = rect.x;
    const top = rect.y;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (bounds === undefined || !(bounds.width > 0) || !(bounds.height > 0)) {
        const originX = Math.floor(left);
        const originY = Math.floor(top);
        return { originX, originY, width: Math.max(1, Math.ceil(right) - originX), height: Math.max(1, Math.ceil(bottom) - originY) };
    }
    const minX = Math.min(bounds.originX, Math.floor(left));
    const minY = Math.min(bounds.originY, Math.floor(top));
    const maxX = Math.max(bounds.originX + bounds.width, Math.ceil(right));
    const maxY = Math.max(bounds.originY + bounds.height, Math.ceil(bottom));
    return { originX: minX, originY: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}
export function chunkOf(r, c) {
    return { cx: Math.floor(c / ISO_CHUNK_SIZE), cy: Math.floor(r / ISO_CHUNK_SIZE) };
}
export function chunkKey(chunk) {
    return `${chunk.cx},${chunk.cy}`;
}
export function parseChunkKey(key) {
    const matched = /^(-?\d+),(-?\d+)$/.exec(key);
    if (matched === null)
        return undefined;
    const cx = Number(matched[1]);
    const cy = Number(matched[2]);
    if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy))
        return undefined;
    return { cx, cy };
}
export function rangeOfChunk(chunk) {
    return {
        r0: chunk.cy * ISO_CHUNK_SIZE,
        c0: chunk.cx * ISO_CHUNK_SIZE,
        r1: (chunk.cy + 1) * ISO_CHUNK_SIZE,
        c1: (chunk.cx + 1) * ISO_CHUNK_SIZE
    };
}
export function chunksInRange(range) {
    const out = [];
    if (range.r1 <= range.r0 || range.c1 <= range.c0)
        return out;
    const cx0 = Math.floor(range.c0 / ISO_CHUNK_SIZE);
    const cx1 = Math.floor((range.c1 - 1) / ISO_CHUNK_SIZE);
    const cy0 = Math.floor(range.r0 / ISO_CHUNK_SIZE);
    const cy1 = Math.floor((range.r1 - 1) / ISO_CHUNK_SIZE);
    for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++)
            out.push({ cx, cy });
    }
    return out;
}
export function canonicalChunk(chunk, cols, rows) {
    const nx = Math.max(1, Math.ceil(cols / ISO_CHUNK_SIZE));
    const ny = Math.max(1, Math.ceil(rows / ISO_CHUNK_SIZE));
    return { cx: mod(chunk.cx, nx), cy: mod(chunk.cy, ny) };
}
export function allChunks(cols, rows) {
    const out = [];
    const nx = Math.max(1, Math.ceil(cols / ISO_CHUNK_SIZE));
    const ny = Math.max(1, Math.ceil(rows / ISO_CHUNK_SIZE));
    for (let cy = 0; cy < ny; cy++)
        for (let cx = 0; cx < nx; cx++)
            out.push({ cx, cy });
    return out;
}
/**
 * 一批格子会弄脏哪些 chunk（规范 key）。
 *
 * 取 3×3 邻域：自动连接会改邻近格的外观，而邻居可能在隔壁 chunk。环绕时
 * `r=0` 的上一行邻居是 `rows-1`，必须落到 `rows-1` 所在的 chunk。
 */
export function dirtyChunksFor(cells, layout) {
    const keys = new Set();
    const push = (r, c) => {
        const cell = layout.wrap ? wrapCell(layout, r, c) : { r, c };
        if (cell.r < 0 || cell.c < 0 || cell.r >= layout.rows || cell.c >= layout.cols)
            return;
        keys.add(chunkKey(canonicalChunk(chunkOf(cell.r, cell.c), layout.cols, layout.rows)));
    };
    for (const cell of cells) {
        for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++)
                push(cell.r + dr, cell.c + dc);
    }
    return [...keys].sort();
}
function clampInt(value, low, high) {
    return Math.max(low, Math.min(high, value));
}
/**
 * 视口矩形覆盖到的格子范围。
 *
 * 等距下视口矩形反解出来是一个菱形；用四角反解的包围盒即可（再多给 padding）。
 * 环绕下每一维最多铺一整轮，且取**地图自己那一轮**（不能从视口左上角起算，
 * 否则贴边时会漏掉最后一列 / 最后一行）。
 */
export function viewCellRange(layout, view, padding = 2) {
    const corners = [
        { x: view.x, y: view.y },
        { x: view.x + view.width, y: view.y },
        { x: view.x, y: view.y + view.height },
        { x: view.x + view.width, y: view.y + view.height }
    ].map((point) => pointToCellRaw(layout, point.x, point.y));
    const r0 = Math.min(...corners.map((hit) => hit.r)) - padding;
    const c0 = Math.min(...corners.map((hit) => hit.c)) - padding;
    const r1 = Math.max(...corners.map((hit) => hit.r)) + 1 + padding;
    const c1 = Math.max(...corners.map((hit) => hit.c)) + 1 + padding;
    if (!layout.wrap) {
        return {
            r0: clampInt(r0, 0, layout.rows),
            c0: clampInt(c0, 0, layout.cols),
            r1: clampInt(r1, 0, layout.rows),
            c1: clampInt(c1, 0, layout.cols)
        };
    }
    const whole = (from, to, span) => (to - from > span ? [0, span] : [from, to]);
    const [rr0, rr1] = whole(r0, r1, layout.rows);
    const [cc0, cc1] = whole(c0, c1, layout.cols);
    return { r0: rr0, r1: rr1, c0: cc0, c1: cc1 };
}
export function clampRangeToMap(layout, range) {
    return {
        r0: clampInt(range.r0, 0, layout.rows),
        c0: clampInt(range.c0, 0, layout.cols),
        r1: clampInt(range.r1, 0, layout.rows),
        c1: clampInt(range.c1, 0, layout.cols)
    };
}
// ── 绘制顺序 ─────────────────────────────────────────────────────────────
/**
 * 深度键：值越小越先画。
 *
 * 同一图层内按「最靠前的占格 (r+c)」排；`r` / `c` 只做稳定 tie-break。
 * `layerIndex` 乘以一个大常数，保证层序永远优先于层内深度 ——
 * 这正是「地面层先铺完、物件层再按前后盖上去」的语义。
 */
export function isoDepthZ(layerIndex, r, c, footprint) {
    const depth = r + c + (footprint === undefined ? 0 : footprint.cols + footprint.rows - 2);
    return layerIndex * 1e12 + depth * 1e6 + r * 4096 + c;
}
/** 点在不在某个格子的菱形内（调试 / 自检用，命中测试不要用它做逐格扫描）。 */
export function insideCell(layout, r, c, x, y) {
    const center = cellCenter(layout, r, c);
    return Math.abs(x - center.x) / layout.stepX + Math.abs(y - center.y) / layout.stepY <= 1;
}
