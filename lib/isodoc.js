/**
 * 45° 地图编辑器（模块五 · iso）的**文档模型与编辑操作**。
 *
 * 一张地图 = 若干图层。地面层的 `data` 每格存一个**全局图块序号**（1-based，0 = 空）；
 * 物件层不在 `data` 里存东西 —— 物件是「参考点 + 素材 + 图层」的独立源数据，
 * 占哪些格由 footprint 现算。这和模块六把「整图」单独存是同一个理由：
 * 一格只装得下一个序号，装不下「占 2×2 + 通行性」。
 *
 * 三条口径：
 *
 * 1. **宿主是唯一写者**：界面只发 op，不整份提交。
 * 2. **派生数据不落盘**：自动连接的 mask、物件占格、绘制顺序、bounds 全部现算。
 * 3. **操作是纯函数**：`applyIsoOps` 直接改传入的 doc，并返回逆操作。
 *
 * 撤销栈不在这里（在 `isogen`）：这里只负责「一笔怎么反做」。
 */
import { MAX_ISO_OBJECTS, assertIsoMapSize, footprintCells, footprintInside, wrapCell } from "./isogeom.js";
export function isoLayerKindOf(layer) {
    return layer === undefined ? undefined : layer.kind;
}
export function cellIndex(doc, r, c) {
    return r * doc.cols + c;
}
export function emptyData(cols, rows) {
    return new Array(cols * rows).fill(0);
}
function defaultLayers() {
    return [
        { id: "l0", name: "地面层", kind: "ground" },
        { id: "l1", name: "装饰层", kind: "object" },
        { id: "l2", name: "建筑层", kind: "object" }
    ];
}
export function createIsoDoc(id, name, cols, rows) {
    assertIsoMapSize(cols, rows);
    const now = new Date().toISOString();
    const layers = defaultLayers();
    const data = {};
    for (const layer of layers)
        data[layer.id] = emptyData(cols, rows);
    return { id, name, cols, rows, layers, data, objects: [], markers: [], createdAt: now, updatedAt: now };
}
/** 读盘 / 外部输入 → 合法文档。图层去重、数据裁齐、越界物件/标记丢掉。 */
export function normalizeIsoDoc(raw, fallbackId) {
    if (raw === null || typeof raw !== "object")
        return undefined;
    const input = raw;
    const cols = Math.max(1, Math.min(512, Math.round(Number(input.cols) || 32)));
    const rows = Math.max(1, Math.min(512, Math.round(Number(input.rows) || 32)));
    const rawLayers = Array.isArray(input.layers) ? input.layers : [];
    const used = new Set();
    const layers = [];
    for (const [index, item] of rawLayers.entries()) {
        const layer = item;
        const id = typeof layer?.id === "string" && layer.id !== "" ? layer.id : `l${index}`;
        const name = typeof layer?.name === "string" && layer.name !== "" ? layer.name : `图层 ${index + 1}`;
        const kind = layer?.kind === "object" ? "object" : "ground";
        let unique = id;
        if (used.has(unique)) {
            let bump = 0;
            while (used.has(`l${bump}`))
                bump++;
            unique = `l${bump}`;
        }
        used.add(unique);
        layers.push({ id: unique, name, kind });
    }
    if (layers.length === 0)
        layers.push(...defaultLayers());
    const layersData = (input.data ?? {});
    const data = {};
    for (const layer of layers) {
        const source = layersData[layer.id];
        const target = emptyData(cols, rows);
        if (Array.isArray(source)) {
            for (let i = 0; i < target.length; i++) {
                const value = Number(source[i]);
                target[i] = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
            }
        }
        data[layer.id] = target;
    }
    const now = new Date().toISOString();
    return {
        id: typeof input.id === "string" && input.id !== "" ? input.id : fallbackId,
        name: typeof input.name === "string" && input.name !== "" ? input.name : "未命名地图",
        cols,
        rows,
        layers,
        data,
        objects: normalizeObjects(input.objects, layers, cols, rows),
        markers: normalizeMarkers(input.markers, cols, rows),
        createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
        updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now
    };
}
function normalizeObjects(raw, layers, cols, rows) {
    if (!Array.isArray(raw))
        return [];
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const used = new Set();
    const out = [];
    let seq = 0;
    const nextId = () => {
        seq++;
        while (used.has(`o${seq}`))
            seq++;
        return `o${seq}`;
    };
    for (const item of raw) {
        const entry = item;
        const r = Math.round(Number(entry?.r));
        const c = Math.round(Number(entry?.c));
        if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0 || r >= rows || c >= cols)
            continue;
        const tilesetId = typeof entry?.tilesetId === "string" ? entry.tilesetId : "";
        const layerId = typeof entry?.layerId === "string" ? entry.layerId : "";
        if (tilesetId === "" || byId.get(layerId)?.kind !== "object")
            continue;
        const given = typeof entry?.id === "string" && entry.id !== "" ? entry.id : "";
        const id = given !== "" && !used.has(given) ? given : nextId();
        used.add(id);
        out.push({ id, tilesetId, layerId, r, c });
        if (out.length >= MAX_ISO_OBJECTS)
            break;
    }
    return out;
}
function normalizeMarkers(raw, cols, rows) {
    if (!Array.isArray(raw))
        return [];
    const used = new Set();
    const out = [];
    let seq = 0;
    const nextId = () => {
        seq++;
        while (used.has(`m${seq}`))
            seq++;
        return `m${seq}`;
    };
    for (const item of raw) {
        const marker = item;
        const r = Math.round(Number(marker?.r));
        const c = Math.round(Number(marker?.c));
        if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0 || r >= rows || c >= cols)
            continue;
        const given = typeof marker?.id === "string" && marker.id !== "" ? marker.id : "";
        const id = given !== "" && !used.has(given) ? given : nextId();
        used.add(id);
        out.push({ id, r, c, name: typeof marker?.name === "string" ? marker.name : "" });
    }
    return out;
}
export function cloneIsoDoc(doc) {
    const data = {};
    for (const [key, value] of Object.entries(doc.data))
        data[key] = [...value];
    return {
        ...doc,
        layers: doc.layers.map((layer) => ({ ...layer })),
        objects: doc.objects.map((object) => ({ ...object })),
        markers: doc.markers.map((marker) => ({ ...marker })),
        data
    };
}
// ── 结构操作 ─────────────────────────────────────────────────────────────
export function nextLayerId(doc) {
    let index = doc.layers.length;
    while (doc.layers.some((layer) => layer.id === `l${index}`))
        index++;
    return `l${index}`;
}
export function addLayer(doc, name, kind = "ground") {
    const layer = {
        id: nextLayerId(doc),
        name: name !== undefined && name !== "" ? name : `图层 ${doc.layers.length + 1}`,
        kind
    };
    doc.layers.push(layer);
    doc.data[layer.id] = emptyData(doc.cols, doc.rows);
    doc.updatedAt = new Date().toISOString();
    return layer;
}
export function removeLayer(doc, layerId) {
    if (doc.layers.length <= 1)
        return false;
    const index = doc.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0)
        return false;
    doc.layers.splice(index, 1);
    delete doc.data[layerId];
    doc.objects = doc.objects.filter((object) => object.layerId !== layerId);
    doc.updatedAt = new Date().toISOString();
    return true;
}
export function moveLayer(doc, layerId, toIndex) {
    const index = doc.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0)
        return false;
    const target = Math.min(doc.layers.length - 1, Math.max(0, Math.round(toIndex)));
    if (target === index)
        return false;
    const [layer] = doc.layers.splice(index, 1);
    doc.layers.splice(target, 0, layer);
    doc.updatedAt = new Date().toISOString();
    return true;
}
export function renameLayer(doc, layerId, name) {
    const layer = doc.layers.find((item) => item.id === layerId);
    if (layer === undefined)
        return false;
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed === "" || layer.name === trimmed)
        return false;
    layer.name = trimmed;
    doc.updatedAt = new Date().toISOString();
    return true;
}
export function clearLayer(doc, layerId) {
    const layer = doc.layers.find((item) => item.id === layerId);
    if (layer === undefined)
        return 0;
    if (layer.kind === "object") {
        const before = doc.objects.length;
        doc.objects = doc.objects.filter((object) => object.layerId !== layerId);
        doc.updatedAt = new Date().toISOString();
        return before - doc.objects.length;
    }
    const data = doc.data[layerId];
    if (data === undefined)
        return 0;
    let count = 0;
    for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0) {
            data[i] = 0;
            count++;
        }
    }
    doc.updatedAt = new Date().toISOString();
    return count;
}
export function resizeDoc(doc, cols, rows) {
    assertIsoMapSize(cols, rows);
    let dropped = 0;
    for (const layer of doc.layers) {
        const old = doc.data[layer.id] ?? [];
        const next = emptyData(cols, rows);
        for (let r = 0; r < Math.min(rows, doc.rows); r++) {
            for (let c = 0; c < Math.min(cols, doc.cols); c++) {
                const value = old[r * doc.cols + c] ?? 0;
                if (value > 0)
                    next[r * cols + c] = value;
                else if (r < rows && c < cols)
                    next[r * cols + c] = 0;
            }
        }
        for (let r = 0; r < doc.rows; r++) {
            for (let c = 0; c < doc.cols; c++) {
                if ((r >= rows || c >= cols) && (old[r * doc.cols + c] ?? 0) > 0)
                    dropped++;
            }
        }
        doc.data[layer.id] = next;
    }
    const beforeObjects = doc.objects.length;
    doc.objects = doc.objects.filter((object) => object.r < rows && object.c < cols);
    const droppedObjects = beforeObjects - doc.objects.length;
    const beforeMarkers = doc.markers.length;
    doc.markers = doc.markers.filter((marker) => marker.r < rows && marker.c < cols);
    const droppedMarkers = beforeMarkers - doc.markers.length;
    doc.cols = cols;
    doc.rows = rows;
    doc.updatedAt = new Date().toISOString();
    return { dropped, droppedMarkers, droppedObjects };
}
function markDirty(set, r, c) {
    set.set(`${r},${c}`, { r, c });
}
function layerOf(doc, layerId) {
    return doc.layers.find((layer) => layer.id === layerId);
}
function wrapPoint(layout, r, c) {
    const cell = layout.wrap ? wrapCell(layout, r, c) : { r, c };
    if (cell.r < 0 || cell.c < 0 || cell.r >= layout.rows || cell.c >= layout.cols)
        return undefined;
    return cell;
}
function objectOccupied(doc, layout, footprintOf) {
    const out = new Map();
    for (const object of doc.objects) {
        const fp = footprintOf(object.tilesetId) ?? { cols: 1, rows: 1 };
        for (const cell of footprintCells(object.r, object.c, fp)) {
            const wrapped = wrapPoint(layout, cell.r, cell.c);
            if (wrapped !== undefined)
                out.set(`${object.layerId}|${wrapped.r},${wrapped.c}`, object.id);
        }
    }
    return out;
}
function makeObjectId(doc) {
    let seq = doc.objects.length + 1;
    while (doc.objects.some((object) => object.id === `o${seq}`))
        seq++;
    return `o${seq}`;
}
function makeMarkerId(doc) {
    let seq = doc.markers.length + 1;
    while (doc.markers.some((marker) => marker.id === `m${seq}`))
        seq++;
    return `m${seq}`;
}
/** 应用一批 op。所有校验失败都写进 `skipped`，不抛。 */
export function applyIsoOps(doc, ops, layout, options = {}) {
    const changedCells = new Map();
    const skipped = [];
    const undo = [];
    const redo = [];
    let changed = 0;
    let touched = false;
    const footprintOf = options.footprintOf ?? (() => ({ cols: 1, rows: 1 }));
    const isObjectTileset = options.isObjectTileset ?? (() => true);
    const applyPaint = (layerId, cells, recordUndo) => {
        const layer = layerOf(doc, layerId);
        if (layer === undefined) {
            skipped.push(`没有这一层：${layerId}`);
            return;
        }
        if (layer.kind !== "ground") {
            skipped.push(`「${layer.name}」是物件层，只能用物件笔刷`);
            return;
        }
        const data = doc.data[layerId];
        if (data === undefined)
            return;
        const previous = [];
        const applied = [];
        for (const input of cells) {
            const cell = wrapPoint(layout, input.r, input.c);
            if (cell === undefined) {
                skipped.push(`${input.r},${input.c} 在地图外`);
                continue;
            }
            const tile = Math.max(0, Math.round(Number(input.tile) || 0));
            const index = cellIndex(doc, cell.r, cell.c);
            const before = data[index] ?? 0;
            if (before === tile) {
                applied.push({ r: cell.r, c: cell.c, tile });
                continue;
            }
            previous.push({ r: cell.r, c: cell.c, tile: before });
            data[index] = tile;
            applied.push({ r: cell.r, c: cell.c, tile });
            markDirty(changedCells, cell.r, cell.c);
            changed++;
        }
        if (recordUndo) {
            if (previous.length > 0)
                undo.push({ kind: "paint", layerId, cells: previous });
            if (applied.length > 0)
                redo.push({ kind: "paint", layerId, cells: applied });
        }
    };
    const applyObjectAdd = (op, recordUndo) => {
        const layer = layerOf(doc, op.layerId);
        if (layer === undefined || layer.kind !== "object") {
            skipped.push("物件只能放在物件层");
            return;
        }
        if (!isObjectTileset(op.tilesetId)) {
            skipped.push("这块素材不是物件");
            return;
        }
        const fp = footprintOf(op.tilesetId) ?? { cols: 1, rows: 1 };
        if (!footprintInside(layout, op.r, op.c, fp)) {
            skipped.push("物件放不下：占格超出了地图（贴边时挪一格）");
            return;
        }
        if (doc.objects.length >= MAX_ISO_OBJECTS) {
            skipped.push(`物件太多了（上限 ${MAX_ISO_OBJECTS} 个）`);
            return;
        }
        const occupied = objectOccupied(doc, layout, footprintOf);
        for (const cell of footprintCells(op.r, op.c, fp)) {
            const wrapped = wrapPoint(layout, cell.r, cell.c);
            if (wrapped === undefined)
                continue;
            if (occupied.has(`${op.layerId}|${wrapped.r},${wrapped.c}`)) {
                skipped.push("这里已经有物件了（同一层不能重叠）");
                return;
            }
        }
        let id = typeof op.id === "string" && op.id !== "" && !doc.objects.some((object) => object.id === op.id) ? op.id : makeObjectId(doc);
        const object = { id, tilesetId: op.tilesetId, layerId: op.layerId, r: op.r, c: op.c };
        doc.objects.push(object);
        for (const cell of footprintCells(op.r, op.c, fp))
            markDirty(changedCells, cell.r, cell.c);
        changed++;
        if (recordUndo) {
            undo.push({ kind: "object", op: "remove", id });
            redo.push({ kind: "object", op: "add", layerId: op.layerId, tilesetId: op.tilesetId, r: op.r, c: op.c, id });
        }
    };
    const applyObjectMove = (op, recordUndo) => {
        const object = doc.objects.find((entry) => entry.id === op.id);
        if (object === undefined) {
            skipped.push(`没有这个物件：${op.id}`);
            return;
        }
        const fp = footprintOf(object.tilesetId) ?? { cols: 1, rows: 1 };
        if (!footprintInside(layout, op.r, op.c, fp)) {
            skipped.push("物件放不下：占格超出了地图");
            return;
        }
        const occupied = objectOccupied(doc, layout, footprintOf);
        for (const cell of footprintCells(op.r, op.c, fp)) {
            const wrapped = wrapPoint(layout, cell.r, cell.c);
            if (wrapped === undefined)
                continue;
            const owner = occupied.get(`${object.layerId}|${wrapped.r},${wrapped.c}`);
            if (owner !== undefined && owner !== object.id) {
                skipped.push("目标位置已经有物件了");
                return;
            }
        }
        const before = { r: object.r, c: object.c };
        for (const cell of footprintCells(object.r, object.c, fp))
            markDirty(changedCells, cell.r, cell.c);
        object.r = op.r;
        object.c = op.c;
        for (const cell of footprintCells(op.r, op.c, fp))
            markDirty(changedCells, cell.r, cell.c);
        changed++;
        if (recordUndo) {
            undo.push({ kind: "object", op: "move", id: object.id, r: before.r, c: before.c });
            redo.push({ kind: "object", op: "move", id: object.id, r: op.r, c: op.c });
        }
    };
    const applyObjectRemove = (op, recordUndo) => {
        const index = doc.objects.findIndex((entry) => entry.id === op.id);
        if (index < 0) {
            skipped.push(`没有这个物件：${op.id}`);
            return;
        }
        const object = doc.objects[index];
        const fp = footprintOf(object.tilesetId) ?? { cols: 1, rows: 1 };
        for (const cell of footprintCells(object.r, object.c, fp))
            markDirty(changedCells, cell.r, cell.c);
        doc.objects.splice(index, 1);
        changed++;
        if (recordUndo) {
            undo.push({ kind: "object", op: "add", layerId: object.layerId, tilesetId: object.tilesetId, r: object.r, c: object.c, id: object.id });
            redo.push({ kind: "object", op: "remove", id: object.id });
        }
    };
    for (const raw of ops) {
        const op = raw;
        const kind = op.kind;
        if (kind === "paint") {
            const layerId = String(op.layerId ?? "");
            const cells = Array.isArray(op.cells) ? op.cells : [];
            applyPaint(layerId, cells.map((cell) => ({ r: Math.round(Number(cell?.r)), c: Math.round(Number(cell?.c)), tile: Math.round(Number(cell?.tile)) })).filter((cell) => Number.isFinite(cell.r) && Number.isFinite(cell.c)), true);
            continue;
        }
        if (kind === "fill") {
            const layerId = String(op.layerId ?? "");
            const layer = layerOf(doc, layerId);
            if (layer === undefined || layer.kind !== "ground") {
                skipped.push("油漆桶只能用在空地层");
                continue;
            }
            const hit = wrapPoint(layout, Math.round(Number(op.r)), Math.round(Number(op.c)));
            if (hit === undefined) {
                skipped.push("起点在地图外");
                continue;
            }
            const data = doc.data[layerId];
            if (data === undefined)
                continue;
            const tile = Math.max(0, Math.round(Number(op.tile) || 0));
            const from = data[cellIndex(doc, hit.r, hit.c)] ?? 0;
            if (from === tile)
                continue;
            const queue = [hit];
            const seen = new Set();
            const cells = [];
            while (queue.length > 0) {
                const at = queue.pop();
                const key = `${at.r},${at.c}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                if (at.r < 0 || at.c < 0 || at.r >= doc.rows || at.c >= doc.cols)
                    continue;
                if ((data[at.r * doc.cols + at.c] ?? 0) !== from)
                    continue;
                cells.push({ r: at.r, c: at.c, tile });
                queue.push({ r: at.r - 1, c: at.c }, { r: at.r + 1, c: at.c }, { r: at.r, c: at.c - 1 }, { r: at.r, c: at.c + 1 });
            }
            applyPaint(layerId, cells, true);
            continue;
        }
        if (kind === "rect") {
            const layerId = String(op.layerId ?? "");
            const layer = layerOf(doc, layerId);
            if (layer === undefined || layer.kind !== "ground") {
                skipped.push("矩形只能画在空地层");
                continue;
            }
            const r0 = Math.round(Number(op.r0));
            const c0 = Math.round(Number(op.c0));
            const r1 = Math.round(Number(op.r1));
            const c1 = Math.round(Number(op.c1));
            const tile = Math.max(0, Math.round(Number(op.tile) || 0));
            const filled = op.filled !== false;
            const cells = [];
            for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
                for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
                    if (!filled && r !== r0 && r !== r1 && c !== c0 && c !== c1)
                        continue;
                    cells.push({ r, c, tile });
                }
            }
            applyPaint(layerId, cells, true);
            continue;
        }
        if (kind === "replace") {
            const layerId = String(op.layerId ?? "");
            const layer = layerOf(doc, layerId);
            if (layer === undefined || layer.kind !== "ground") {
                skipped.push("替换只能用在空地层");
                continue;
            }
            const data = doc.data[layerId];
            if (data === undefined)
                continue;
            const from = Math.max(0, Math.round(Number(op.from) || 0));
            const to = Math.max(0, Math.round(Number(op.to) || 0));
            if (from === to)
                continue;
            const cells = [];
            for (let i = 0; i < data.length; i++) {
                if (data[i] === from)
                    cells.push({ r: Math.floor(i / doc.cols), c: i % doc.cols, tile: to });
            }
            applyPaint(layerId, cells, true);
            continue;
        }
        if (kind === "object") {
            const action = op.op;
            if (action === "add") {
                applyObjectAdd({
                    kind: "object",
                    op: "add",
                    layerId: String(op.layerId ?? ""),
                    tilesetId: String(op.tilesetId ?? ""),
                    r: Math.round(Number(op.r)),
                    c: Math.round(Number(op.c)),
                    id: typeof op.id === "string" ? op.id : undefined
                }, true);
            }
            else if (action === "move") {
                applyObjectMove({ kind: "object", op: "move", id: String(op.id ?? ""), r: Math.round(Number(op.r)), c: Math.round(Number(op.c)) }, true);
            }
            else if (action === "remove") {
                applyObjectRemove({ kind: "object", op: "remove", id: String(op.id ?? "") }, true);
            }
            else {
                skipped.push(`未知物件操作：${String(action)}`);
            }
            continue;
        }
        if (kind === "marker") {
            const action = op.op;
            if (action === "add") {
                const hit = wrapPoint(layout, Math.round(Number(op.r)), Math.round(Number(op.c)));
                if (hit === undefined) {
                    skipped.push("标记点在地图外");
                    continue;
                }
                if (doc.markers.some((marker) => marker.r === hit.r && marker.c === hit.c)) {
                    skipped.push("这一格已经有标记了（一格最多一个）");
                    continue;
                }
                const id = typeof op.id === "string" && op.id !== "" && !doc.markers.some((marker) => marker.id === op.id) ? op.id : makeMarkerId(doc);
                const name = typeof op.name === "string" ? op.name : "";
                doc.markers.push({ id, r: hit.r, c: hit.c, name });
                markDirty(changedCells, hit.r, hit.c);
                changed++;
                touched = true;
                undo.push({ kind: "marker", op: "remove", id });
                redo.push({ kind: "marker", op: "add", r: hit.r, c: hit.c, name, id });
                continue;
            }
            if (action === "remove") {
                const index = doc.markers.findIndex((marker) => marker.id === op.id);
                if (index < 0) {
                    skipped.push(`没有这个标记：${String(op.id)}`);
                    continue;
                }
                const marker = doc.markers[index];
                doc.markers.splice(index, 1);
                for (const entry of doc.markers)
                    markDirty(changedCells, entry.r, entry.c);
                markDirty(changedCells, marker.r, marker.c);
                changed++;
                touched = true;
                undo.push({ kind: "marker", op: "add", r: marker.r, c: marker.c, name: marker.name, id: marker.id });
                redo.push({ kind: "marker", op: "remove", id: marker.id });
                continue;
            }
            if (action === "move") {
                const marker = doc.markers.find((entry) => entry.id === op.id);
                if (marker === undefined) {
                    skipped.push(`没有这个标记：${String(op.id)}`);
                    continue;
                }
                const hit = wrapPoint(layout, Math.round(Number(op.r)), Math.round(Number(op.c)));
                if (hit === undefined) {
                    skipped.push("标记点在地图外");
                    continue;
                }
                if (doc.markers.some((entry) => entry.id !== marker.id && entry.r === hit.r && entry.c === hit.c)) {
                    skipped.push("目标格已经有标记了");
                    continue;
                }
                const before = { r: marker.r, c: marker.c };
                markDirty(changedCells, before.r, before.c);
                marker.r = hit.r;
                marker.c = hit.c;
                markDirty(changedCells, hit.r, hit.c);
                changed++;
                touched = true;
                undo.push({ kind: "marker", op: "move", id: marker.id, r: before.r, c: before.c });
                redo.push({ kind: "marker", op: "move", id: marker.id, r: hit.r, c: hit.c });
                continue;
            }
            if (action === "rename") {
                const marker = doc.markers.find((entry) => entry.id === op.id);
                if (marker === undefined) {
                    skipped.push(`没有这个标记：${String(op.id)}`);
                    continue;
                }
                const name = typeof op.name === "string" ? op.name : "";
                const before = marker.name;
                marker.name = name;
                touched = true;
                undo.push({ kind: "marker", op: "rename", id: marker.id, name: before });
                redo.push({ kind: "marker", op: "rename", id: marker.id, name });
                continue;
            }
            skipped.push(`未知标记操作：${String(action)}`);
            continue;
        }
        skipped.push(`未知操作：${String(kind)}`);
    }
    if (changed > 0 || touched)
        doc.updatedAt = new Date().toISOString();
    return { changed, skipped, dirty: [...changedCells.values()], touched, undo, redo };
}
/** 把 op 应用到文档（撤销 / 重做时也走这里，只是不再往回记历史）。 */
export function revertIsoOps(doc, ops, layout, options = {}) {
    return applyIsoOps(doc, ops, layout, options);
}
export function nextMarkerId(doc) {
    return makeMarkerId(doc);
}
export function filledCount(doc, layerId) {
    if (layerId !== undefined) {
        const layer = layerOf(doc, layerId);
        if (layer?.kind === "object")
            return doc.objects.filter((object) => object.layerId === layerId).length;
        const data = doc.data[layerId] ?? [];
        return data.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
    }
    let sum = 0;
    for (const layer of doc.layers)
        sum += filledCount(doc, layer.id);
    return sum;
}
export function objectCount(doc, layerId) {
    return layerId === undefined ? doc.objects.length : doc.objects.filter((object) => object.layerId === layerId).length;
}
export function isDocEmpty(doc) {
    if (doc.objects.length > 0 || doc.markers.length > 0)
        return false;
    return Object.values(doc.data).every((data) => data.every((value) => value === 0));
}
export function usedTileIndices(doc) {
    const out = new Set();
    for (const data of Object.values(doc.data)) {
        for (const value of data)
            if (value > 0)
                out.add(value);
    }
    return out;
}
/** 导出 / 选择范围：右下开区间，裁到地图内。 */
export function clampDocRange(doc, range) {
    return {
        r0: Math.max(0, Math.min(doc.rows, range.r0)),
        c0: Math.max(0, Math.min(doc.cols, range.c0)),
        r1: Math.max(0, Math.min(doc.rows, range.r1)),
        c1: Math.max(0, Math.min(doc.cols, range.c1))
    };
}
