#!/usr/bin/env node
/**
 * 45° 地图编辑器（模块五 · iso）· 数据层 / 流水线自检。纯本地，不花钱。
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = await mkdtemp(join(tmpdir(), "dsh-iso-pipe-"));
process.env.DSH_HOME = HOME;

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

const G = await import("../lib/isogen.js");
const GEO = await import("../lib/isogeom.js");
const DOC = await import("../lib/isodoc.js");
const RENDER = await import("../lib/isorender.js");
const BITMAP = await import("../lib/bitmap.js");

const cell = { width: 64, height: 96 };

section("1) 建项目 / 装内置素材");
const project = await G.createIsoProject("流水线自检", { cell, cols: 12, rows: 10, wrap: true });
check("项目 id 形如 g…", G.isValidIsoProjectId(project.id), project.id);
const sample = await G.importIsoSampleTileset(project.id);
check("内置素材装进来了", sample.tilesets.length === 10, String(sample.tilesets.length));
const refreshed = await G.importIsoSampleTileset(project.id);
check("再装一次原地刷新内置素材（不新增重复项）", refreshed.tilesets.length === 10 && refreshed.tilesets.every((tileset) => sample.tilesets.some((original) => original.id === tileset.id)), `${refreshed.tilesets.length}`);
const view = await G.isoView(await G.readIsoProject(project.id));
check("视图带格子 / 布局 / 素材 / 调色板", view.cell.width === 64 && view.layout.stepX === 32 && view.tilesets.length === 10, JSON.stringify(view.layout));
check("默认三层（地面 / 装饰 / 建筑）", view.layers.length === 3 && view.layers[0].kind === "ground" && view.layers[1].kind === "object");
const groundTs = view.tilesets.find((tileset) => tileset.kind === "ground");
const autoTs = view.tilesets.find((tileset) => tileset.kind === "autotile");
const objectTs = view.tilesets.find((tileset) => tileset.name === "石屋");
const ground = view.layers[0];
const decor = view.layers[1];
check("地面调色板有地面笔刷", groundTs.palette.length >= 1);
check("自动连接只有一个满接笔刷", autoTs.palette.length === 1);
check("石屋是 2×2 物件", objectTs.footprint.cols === 2 && objectTs.footprint.rows === 2);

section("2) 地面 / 自动连接 / 物件 / 标记");
const groundBrush = groundTs.palette[0].index;
const autoBrush = autoTs.palette[0].index;
const objectBrush = objectTs.palette[0].index;
let result = await G.applyIsoOps(project.id, [
  { kind: "paint", layerId: ground.id, cells: [
    { r: 1, c: 1, tile: groundBrush }, { r: 1, c: 2, tile: autoBrush }, { r: 2, c: 2, tile: autoBrush }
  ] },
  { kind: "object", op: "add", layerId: decor.id, tilesetId: objectTs.id, r: 4, c: 4 },
  { kind: "marker", op: "add", r: 2, c: 3, name: "宝箱" }
]);
check("一次提交三类 op", result.changed >= 4, JSON.stringify(result));
const doc1 = await G.readTheDoc(project.id);
check("地面数据写进去了", doc1.data[ground.id][1 * 12 + 1] === groundBrush);
check("物件写进 objects（不在 data 里）", doc1.objects.length === 1 && doc1.data[decor.id].every((value) => value === 0));
check("标记写进去了", doc1.markers.length === 1 && doc1.markers[0].name === "宝箱");

section("3) 计划 / 自动连接 / 动画 / z");
const plan = await G.isoPlan(project.id, { view: { x: -1000, y: -1000, width: 2000, height: 2000 } });
const ops = plan.chunks.flatMap((chunk) => chunk.ops);
check("计划里有地面 op 与物件 op", ops.some((op) => op.l === 0) && ops.some((op) => op.l === 1));
check("计划里的 z 已排序（chunk 内）", plan.chunks.every((chunk) => chunk.ops.every((op, index) => index === 0 || chunk.ops[index - 1].z <= op.z)));
check("计划带 legend / markers / bounds", plan.legend.length > 0 && plan.markers.length === 1 && plan.bounds.width > 0);
const autoOps = ops.filter((op) => op.r === 1 && op.c === 2);
check("自动连接格在下发 op 里", autoOps.length > 0, String(autoOps.length));
const water = view.tilesets.find((tileset) => tileset.name === "水面");
const waterBrush = water.palette[0].index;
await G.applyIsoOps(project.id, [{ kind: "paint", layerId: ground.id, cells: [{ r: 3, c: 3, tile: waterBrush }] }]);
const plan2 = await G.isoPlan(project.id, { view: { x: -1000, y: -1000, width: 2000, height: 2000 } });
const waterOp = plan2.chunks.flatMap((chunk) => chunk.ops).find((op) => op.r === 3 && op.c === 3);
check("水面 op 带循环帧与速度信息", waterOp !== undefined && Array.isArray(waterOp.cycle) && waterOp.cycle.length === 2, JSON.stringify(waterOp?.cycle));
check("frameCount 跟着变", plan2.frameCount === 2, String(plan2.frameCount));

section("4) 撤销 / 重做 / 一笔一撤销");
const beforeUndo = JSON.stringify((await G.readTheDoc(project.id)).data);
await G.isoUndo(project.id);
const afterUndo = JSON.stringify((await G.readTheDoc(project.id)).data);
check("撤销恢复了上一笔", beforeUndo !== afterUndo);
await G.isoRedo(project.id);
check("重做回到撤销前", JSON.stringify((await G.readTheDoc(project.id)).data) === beforeUndo);
const hist = G.historyState(project.id);
check("历史栈可撤销", hist.canUndo === true && hist.depth >= 1, JSON.stringify(hist));

section("5) 物件移动 / 删除 / 重叠拒绝");
const stone = view.tilesets.find((tileset) => tileset.name === "石头");
const stoneBrush = stone.palette[0].index;
void stoneBrush;
const overlap = await G.applyIsoOps(project.id, [{ kind: "object", op: "add", layerId: decor.id, tilesetId: objectTs.id, r: 5, c: 4 }]);
check("同层 2×2 物件重叠被拒绝", overlap.changed === 0 && overlap.skipped.length > 0);
const move = await G.applyIsoOps(project.id, [{ kind: "object", op: "move", id: doc1.objects[0].id, r: 6, c: 6 }]);
check("物件可以移动", move.changed === 1);
const moved = (await G.readTheDoc(project.id)).objects[0];
check("移动后的坐标正确", moved.r === 6 && moved.c === 6, JSON.stringify(moved));
const remove = await G.applyIsoOps(project.id, [{ kind: "object", op: "remove", id: moved.id }]);
check("物件可以删除", remove.changed === 1 && (await G.readTheDoc(project.id)).objects.length === 0);

section("6) 地面自动连接 / 环绕脏块");
const dirty = await G.applyIsoOps(project.id, [{ kind: "paint", layerId: ground.id, cells: [{ r: 0, c: 0, tile: autoBrush }] }]);
check("自动连接画一格会连带弄脏环绕邻居", dirty.dirtyChunks.includes("0,1"), dirty.dirtyChunks.join(","));

section("7) 一键生成确定性");
const p1 = await G.createIsoProject("生成A", { cell, cols: 8, rows: 8, wrap: true });
const p2 = await G.createIsoProject("生成B", { cell, cols: 8, rows: 8, wrap: true });
await G.importIsoSampleTileset(p1.id);
await G.importIsoSampleTileset(p2.id);
const v1 = await G.isoView(await G.readIsoProject(p1.id));
const brush1 = v1.tilesets.find((entry) => entry.name === "草地").palette[0].index;
const g1 = await G.runIsoGenerate(p1.id, { kind: "random", tiles: [brush1], seed: 42 });
const g2 = await G.runIsoGenerate(p2.id, { kind: "random", tiles: [brush1], seed: 42 });
const planA = await G.isoPlan(p1.id, { view: { x: -500, y: -500, width: 1000, height: 1000 } });
const planB = await G.isoPlan(p2.id, { view: { x: -500, y: -500, width: 1000, height: 1000 } });
check("同种子生成结果逐项一致", g1.changed === g2.changed && JSON.stringify(planA.chunks) === JSON.stringify(planB.chunks), `${g1.changed}/${g2.changed}`);
check("随机生成铺满整层", g1.changed === 64, String(g1.changed));

section("8) 导出 PNG / JSON / zip 与可复现");
const exportStarted = await G.runIsoExport(project.id, { scale: 1, formats: { png: true, json: true, tilesets: true } });
check("导出任务已启动", exportStarted.started === true, JSON.stringify(exportStarted));
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (G.isoBusy(project.id) !== true) break;
}
const view2 = await G.isoView(await G.readIsoProject(project.id));
check("导出产物清单有 PNG / JSON / zip", view2.exportFiles.includes("map.png") && view2.exportFiles.includes("map.json") && view2.exportFiles.some((file) => file.endsWith(".zip")), view2.exportFiles.join(","));
const dir = view2.exportPath;
const pngBytes = await readFile(join(dir, "map.png"));
const size = BITMAP.pngSize(pngBytes);
check("导出的 PNG 能读出尺寸", size !== undefined && size.width > 0 && size.height > 0, JSON.stringify(size));
const json = JSON.parse(await readFile(join(dir, "map.json"), "utf8"));
check("map.json 格式正确", json.format === "dsh-gem-iso-map@1" && json.projection === "isometric-2:1" && json.cell.width === 64, json.format);
check("map.json 带对象与标记源数据", Array.isArray(json.objects) && Array.isArray(json.markers));
const zip = await readFile(join(dir, view2.exportFiles.find((file) => file.endsWith(".zip"))));
check("zip 以 PK 开头", zip[0] === 0x50 && zip[1] === 0x4b);
const listing = execFileSync("unzip", ["-l", join(dir, view2.exportFiles.find((file) => file.endsWith(".zip")))], { encoding: "utf8" });
check("zip 里真有 map.png / map.json", /map\.png/.test(listing) && /map\.json/.test(listing));

const png1 = await readFile(join(dir, "map.png"));
const json1 = await readFile(join(dir, "map.json"));
await G.runIsoExport(project.id, { scale: 1, formats: { png: true, json: true, tilesets: true } });
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (G.isoBusy(project.id) !== true) break;
}
check("同文档两次导出 PNG 逐字节一致", (await readFile(join(dir, "map.png"))).equals(png1));
check("同文档两次导出 JSON 逐字节一致", (await readFile(join(dir, "map.json"))).equals(json1));

section("9) 删除素材会清掉引用");
const viewP1 = await G.isoView(await G.readIsoProject(p1.id));
const deleteTs = viewP1.tilesets.find((tileset) => tileset.name === "草地");
const del = await G.removeIsoTileset(p1.id, deleteTs.id);
check("删除素材报告清掉的格子", del.clearedCells >= 0, JSON.stringify(del));
const view3 = await G.isoView(await G.readIsoProject(p1.id));
check("删除后素材列表少一张", view3.tilesets.length === 9, String(view3.tilesets.length));

section("10) AI 生成素材：composeIsoAsset / 落盘 / 导入");
{
  const fixtureDir = join(HOME, "ai-fixtures");
  await (await import("node:fs/promises")).mkdir(fixtureDir, { recursive: true });
  /** 512×256、2:1 菱形，菱形外纯绿；用来模拟“模型画的一块地面”。 */
  const green = (() => {
    const w = 512, h = 256;
    const bitmap = { width: w, height: h, rgba: Buffer.alloc(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(x + 0.5 - w / 2) / (w / 2) + Math.abs(y + 0.5 - h / 2) / (h / 2);
        if (d <= 1) {
          bitmap.rgba[i] = 82; bitmap.rgba[i + 1] = 150; bitmap.rgba[i + 2] = 84; bitmap.rgba[i + 3] = 255;
        } else {
          bitmap.rgba[i + 1] = 255; bitmap.rgba[i + 3] = 255;
        }
      }
    }
    return bitmap;
  })();
  const groundFile = join(fixtureDir, "ground.png");
  await writeFile(groundFile, BITMAP.encodeBitmap(green));

  /** 512×512、绿底红方块；模拟一个物件。 */
  const object = (() => {
    const w = 512, h = 512;
    const bitmap = { width: w, height: h, rgba: Buffer.alloc(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inside = x > 128 && x < 384 && y > 80 && y < 470;
        if (inside) {
          bitmap.rgba[i] = 190; bitmap.rgba[i + 1] = 70; bitmap.rgba[i + 2] = 45; bitmap.rgba[i + 3] = 255;
        } else {
          bitmap.rgba[i + 1] = 255; bitmap.rgba[i + 3] = 255;
        }
      }
    }
    return bitmap;
  })();
  const objectFile = join(fixtureDir, "object.png");
  await writeFile(objectFile, BITMAP.encodeBitmap(object));

  const beforeTilesets = (await G.readIsoProject(project.id)).tilesets.length;
  const groundAi = await G.composeIsoAsset({ projectId: project.id, name: "AI 草地", files: [groundFile], kind: "ground" });
  check("AI 地面整理成 ai/ 文件", groundAi.file.startsWith("ai/") && groundAi.width === 256 && groundAi.height === 384, JSON.stringify(groundAi));
  check("AI 地面保留 4 倍分辨率", groundAi.scale === 4 && groundAi.frameCount === 1 && groundAi.animRows === false);
  check("AI 地面检测到绿幕", groundAi.keyed > 0.2, String(groundAi.keyed));
  const groundAiFile = join(G.isoProjectDir(project.id), groundAi.file);
  check("AI 地面文件真的存在", (await stat(groundAiFile)).size > 0);
  check("整理阶段不自动进素材列表", (await G.readIsoProject(project.id)).tilesets.length === beforeTilesets);

  const importedGround = await G.importIsoTileset(project.id, "AI 草地", (await readFile(groundAiFile)).toString("base64"), {
    kind: "ground",
    sourceCell: { width: cell.width * groundAi.scale, height: cell.height * groundAi.scale }
  });
  check("AI 地面能导入成 ground", importedGround.tilesets[0].kind === "ground" && importedGround.tilesets[0].tiles.length === 1);
  const groundAi2 = await G.composeIsoAsset({ projectId: project.id, name: "AI 水面", files: [groundFile, groundFile], kind: "ground" });
  check("AI 地面多帧 → animRows / 帧数", groundAi2.frameCount === 2 && groundAi2.animRows === true, JSON.stringify(groundAi2));
  const importedGround2 = await G.importIsoTileset(project.id, "AI 水面", (await readFile(join(G.isoProjectDir(project.id), groundAi2.file))).toString("base64"), {
    kind: "ground",
    animRows: true,
    sourceCell: { width: cell.width * groundAi2.scale, height: cell.height * groundAi2.scale }
  });
  check("AI 动画地面能导入成 2 帧", importedGround2.tilesets[0].frames === 2 && importedGround2.tilesets[0].animRows === true);

  const objectAi = await G.composeIsoAsset({
    projectId: project.id,
    name: "AI 树",
    files: [objectFile],
    kind: "object",
    footprint: { cols: 2, rows: 2 }
  });
  check("AI 物件按占格输出", objectAi.kind === "object" && objectAi.footprint.cols === 2 && objectAi.footprint.rows === 2 && objectAi.width === 2 * cell.width * objectAi.scale, JSON.stringify(objectAi));
  check("AI 物件检测到绿幕", objectAi.keyed > 0.2, String(objectAi.keyed));
  const importedObject = await G.importIsoTileset(project.id, "AI 树", (await readFile(join(G.isoProjectDir(project.id), objectAi.file))).toString("base64"), {
    kind: "object",
    footprint: { cols: 2, rows: 2 },
    keyGreen: false
  });
  check("AI 物件能导入成 object", importedObject.tilesets[0].kind === "object" && importedObject.tilesets[0].footprint.cols === 2);

  // 用户反馈：希望自己能调「图片相对于地格的大小」。物件导入时按 objectScale 重采样，
  // 1 = 宽度正好占满 footprint；这里钉住 50% 真的把存图缩了一半，而且回读不丢。
  const objectBase64 = (await readFile(join(G.isoProjectDir(project.id), objectAi.file))).toString("base64");
  const importedHalf = await G.importIsoTileset(project.id, "AI 小树", objectBase64, {
    kind: "object",
    footprint: { cols: 2, rows: 2 },
    objectScale: 0.5,
    keyGreen: false
  });
  check("物件大小 50% → 存图宽度 = 占格总宽 × 0.5", importedHalf.tilesets[0].imageWidth === 2 * cell.width * 0.5, String(importedHalf.tilesets[0].imageWidth));
  const importedHalfBrief = G.isoTilesetBrief(importedHalf.tilesets[0]);
  check("objectScale 回读 / 素材说明带大小", importedHalf.tilesets[0].objectScale === 0.5 && /大小 50%/.test(importedHalfBrief.reason), importedHalfBrief.reason);
  const reloadedProject = await G.readIsoProject(project.id);
  const reloadedHalf = reloadedProject?.tilesets.find((tileset) => tileset.name === "AI 小树");
  check("objectScale 落盘并回读（重开项目不丢）", reloadedHalf?.objectScale === 0.5 && reloadedHalf?.imageWidth === 64, JSON.stringify({ objectScale: reloadedHalf?.objectScale, imageWidth: reloadedHalf?.imageWidth }));
  let objectScaleRejected = false;
  try {
    await G.importIsoTileset(project.id, "AI 大树", objectBase64, { kind: "object", footprint: { cols: 2, rows: 2 }, objectScale: 9 });
  } catch {
    objectScaleRejected = true;
  }
  check("物件大小越界（900%）明确报错", objectScaleRejected);
}

await rm(HOME, { recursive: true, force: true });

console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${passed} 项检查，全部通过。`);
