#!/usr/bin/env node
/**
 * 45° 地图编辑器（模块五 · iso）· 网关契约自检。
 *
 * typert 按 schema 校验 payload；schema 里没声明的键会被**静默丢掉**。
 * 这里逐键解析一遍，防止「界面点了没反应 / 参数保存了但没生效」。
 */
import { readFileSync } from "node:fs";

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

const WIRE = await import("../lib/wire.js");
const LINKS = await import("../lib/links.js");
const source = readFileSync(new URL("../src/wire.ts", import.meta.url), "utf8");

section("1) 方法表 / 模块枚举");
check("wire 方法总数为 183", WIRE.METHODS.length === 183, String(WIRE.METHODS.length));
const names = new Set(WIRE.METHODS.map((method) => method.method));
for (const method of ["listIsoProjects", "createIsoProject", "getIsoProject", "saveIsoProject", "deleteIsoProject", "importIsoTileset", "importIsoSampleTileset", "saveIsoTileset", "removeIsoTileset", "saveIsoDoc", "applyIsoOps", "isoUndo", "isoRedo", "isoPlan", "runIsoGenerate", "runIsoPreview", "runIsoExport", "cancelIsoJob", "setIsoApproved", "revealIsoProject"]) {
  check(`注册了 ${method}`, names.has(method));
}
check("不再注册 tile 方法", ![...names].some((method) => /^(list|create|get|save|delete|run|set|cancel|reveal)Tile/.test(method)));
check("模块顺序为 sprite,image,sequence,rig,iso,map,music,sfx", LINKS.STUDIO_MODULES.join(",") === "sprite,image,sequence,rig,iso,map,music,sfx", LINKS.STUDIO_MODULES.join(","));
check("阶段为 assets,paint,export", LINKS.ISO_STAGES.join(",") === "assets,paint,export", LINKS.ISO_STAGES.join(","));
check("深链接放行 module=iso", LINKS.parseIntentQuery("dsh-gmm=1&module=iso&job=gabc1234&stage=paint")?.module === "iso");

section("2) payload schema 逐键不丢");
function schema(method) {
  const found = WIRE.METHODS.find((entry) => entry.method === method);
  if (found === undefined || found.payload === undefined) throw new Error(`没有 payload schema：${method}`);
  return found.payload;
}
function parseCase(method, payload, keys) {
  const result = schema(method).safeParse(payload);
  check(`${method} payload 合法`, result.success, result.success ? "" : JSON.stringify(result.error?.issues ?? []));
  if (result.success) {
    const missing = keys.filter((key) => !(key in result.data));
    check(`${method} 的关键字段没有被 schema 吞掉`, missing.length === 0, missing.join("、"));
  }
}
parseCase("createIsoProject", { name: "x", cell: { width: 64, height: 96 }, cols: 8, rows: 8, wrap: true }, ["name", "cell", "cols", "rows", "wrap"]);
parseCase("saveIsoProject", { projectId: "gabc1234", name: "y", wrap: false }, ["projectId", "name", "wrap"]);
parseCase("importIsoTileset", {
  projectId: "gabc1234", name: "草地", data: "AAAA", kind: "object",
  sourceCell: { width: 64, height: 96 }, animRows: true, frames: 2, fps: 4,
  loop: "pingpong", clarity: "sharp", footprint: { cols: 2, rows: 2 },
  anchor: { x: 0.5, y: 1 }, pass: [0, 1, 1, 2], keyGreen: true
}, ["projectId", "name", "data", "kind", "sourceCell", "animRows", "frames", "fps", "loop", "clarity", "footprint", "anchor", "pass", "keyGreen"]);
parseCase("saveIsoTileset", { projectId: "gabc1234", tilesetId: "ts1", name: "n", fps: null, loop: "reverse" }, ["projectId", "tilesetId", "name", "fps", "loop"]);
parseCase("saveIsoDoc", { projectId: "gabc1234", name: "n", cols: 9, rows: 7, layers: [{ id: "l0", name: "x" }], addLayer: { name: "y", kind: "object" }, removeLayerId: "l2", moveLayer: { id: "l1", toIndex: 0 }, clearLayerId: "l1" }, ["projectId", "name", "cols", "rows", "layers", "addLayer", "removeLayerId", "moveLayer", "clearLayerId"]);
parseCase("applyIsoOps", { projectId: "gabc1234", ops: [{ kind: "paint" }], stroke: "s1", have: ["0,0"] }, ["projectId", "ops", "stroke", "have"]);
parseCase("isoPlan", { projectId: "gabc1234", view: { x: 0, y: 0, width: 100, height: 100 }, have: ["0,0"], layerIds: [0], pending: [{ kind: "paint" }], pass: true }, ["projectId", "view", "have", "layerIds", "pending", "pass"]);
parseCase("runIsoGenerate", { projectId: "gabc1234", kind: "maze", tiles: [1, 2], seed: 7, layerId: "l0" }, ["projectId", "kind", "tiles", "seed", "layerId"]);
parseCase("runIsoExport", { projectId: "gabc1234", scale: 2, formats: { png: true, json: true, tilesets: true, zip: false } }, ["projectId", "scale", "formats"]);
parseCase("setIsoApproved", { projectId: "gabc1234", stage: "paint", approved: true }, ["projectId", "stage", "approved"]);
parseCase("revealIsoProject", { projectId: "gabc1234", target: "export" }, ["projectId", "target"]);
parseCase("isoUndo", { projectId: "gabc1234", have: [] }, ["projectId", "have"]);

section("3) 源码 / 路由纪律");
check("AssetScope 含 iso-assets", /"iso-assets"/.test(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")));
check("模块枚举含 iso、不含 tile", /"rig", "iso", "map"/.test(source) && !/"tile"/.test(source));
check("不再有 Tile 方法 schema", !/const tileIdSchema|runTileItemsSchema/.test(source));
check("SERVABLE_ISO_DIRS 在 isogen 里（tilesets / preview / export）", /SERVABLE_ISO_DIRS = new Set\(\["tilesets", "preview", "export"\]\)/.test(readFileSync(new URL("../src/isogen.ts", import.meta.url), "utf8")));

console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${passed} 项检查，全部通过。`);
