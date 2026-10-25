#!/usr/bin/env node
/**
 * 地图编辑器（模块五 / 六）· Agent 读模型与检查图自检。**纯本地、不联网、不花钱。**
 *
 * 盯的是 Phase 0：
 *   · `mapInspect` / `isoInspect` 的逐格内容、图例、预算截断、标记；
 *   · `runMapRender` / `runIsoRender` 的本机 PNG、crop 尺寸、标记叠加、区域裁切；
 *   · `revision` 在写入 / 撤销 / dryRun 前后的变化；
 *   · `dryRun` / `ifRevision` 不写盘、不覆盖新状态；
 *   · map / iso 两种几何下都能用同一个工作流。
 *
 * 用法：node scripts/verify-map-agent.mjs
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "dsh-map-agent-"));
process.env.DSH_HOME = HOME;

let checks = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) checks++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

const G = await import("../lib/mapgen.js");
const I = await import("../lib/isogen.js");
const MAP_EXPORT = await import("../lib/mapexport.js");
const ISO_EXPORT = await import("../lib/isoexport.js");
const ISO_RENDER = await import("../lib/isorender.js");
const { decodeFile } = await import("../lib/bitmap.js");
const { encodePng } = await import("../lib/png.js");

function pixelsEqual(a, b, width, height, offsetX = 0, offsetY = 0) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ai = ((y + offsetY) * a.width + x + offsetX) * 4;
      const bi = (y * b.width + x) * 4;
      for (let k = 0; k < 4; k++) if (a.rgba[ai + k] !== b.rgba[bi + k]) return false;
    }
  }
  return true;
}

try {
  section("1) mapInspect：逐格 / 图例 / 预算");
  const map = await G.createMapProject("Agent 读模型", { grid: { tileWidth: 32, tileHeight: 32 }, cols: 8, rows: 8 });
  await G.importSampleTileset(map.id);
  const mapView = await G.mapView(await G.readMapProject(map.id));
  const layerId = mapView.layers[0].id;
  const grass = mapView.tilesets[0].palette[0].index;
  const road = mapView.tilesets[1].palette[0].index;

  const empty = await G.mapInspect(map.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 }, format: "both" });
  check("空地图的逐格文本全是空位", empty.layers[0].rows.every((row) => row === "····"), JSON.stringify(empty.layers[0].rows));
  check("空地图统计 filled = 0", empty.stats.filled === 0 && empty.stats.fillRate === 0, JSON.stringify(empty.stats));
  check("空地图 revision 与视图一致", empty.revision === mapView.revision, `${empty.revision} / ${mapView.revision}`);

  const beforeApply = await G.mapInspect(map.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 } });
  const patchCells = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) patchCells.push({ r, c, tile: grass });
  patchCells.push({ r: 4, c: 4, tile: road });
  const applied = await G.applyMapOps(map.id, [{ kind: "paint", layerId, cells: patchCells }], {});
  check("写入返回 revision", typeof applied.revision === "string" && applied.revision.length === 12, applied.revision);
  check("写入后 revision 变了", applied.revision !== beforeApply.revision, `${beforeApply.revision} → ${applied.revision}`);
  const afterApply = await G.mapInspect(map.id, { region: { r0: 0, c0: 0, r1: 6, c1: 6 } });
  check("逐格内容与写入一致（第一行 4 个草 + 空）", afterApply.layers[0].rows[0] === "0000··", afterApply.layers[0].rows[0]);
  check("逐格内容与写入一致（第 5 行第 5 列是路）", afterApply.layers[0].rows[4] === "····1·", afterApply.layers[0].rows[4]);
  check("图例带素材名与图块 id", afterApply.legend.some((entry) => entry.tilesetName.includes("草地") && entry.index === grass) && afterApply.legend.some((entry) => entry.index === road), JSON.stringify(afterApply.legend));
  check("统计 filled = 17", afterApply.stats.filled === 17, JSON.stringify(afterApply.stats.filled));

  const truncated = await G.mapInspect(map.id, { maxCells: 9 });
  check("超预算明确 truncated，不静默截断", truncated.truncated === true && truncated.nextRange !== null && truncated.layers.every((layer) => layer.rows === undefined), JSON.stringify({ truncated: truncated.truncated, next: truncated.nextRange }));

  section("2) dryRun / ifRevision");
  const dry = await G.applyMapOps(
    map.id,
    [{ kind: "paint", layerId, cells: patchCells.slice(0, 16).map((cell) => ({ ...cell, tile: road })) }],
    { dryRun: true, ifRevision: afterApply.revision }
  );
  check("dryRun 返回预演结果且标 dryRun", dry.dryRun === true && dry.changed === 16, JSON.stringify({ dryRun: dry.dryRun, changed: dry.changed }));
  const afterDry = await G.mapInspect(map.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 } });
  check("dryRun 不写盘（草还在）", afterDry.layers[0].rows[0] === "0000", afterDry.layers[0].rows[0]);
  check("dryRun 不改变 revision", afterDry.revision === afterApply.revision, `${afterDry.revision} / ${afterApply.revision}`);
  let staleError = "";
  try {
    await G.applyMapOps(map.id, [{ kind: "paint", layerId, cells: [{ r: 0, c: 0, tile: road }] }], { ifRevision: "000000000000", dryRun: true });
  } catch (error) {
    staleError = String(error?.message ?? error);
  }
  check("ifRevision 不一致时拒绝", staleError.includes("版本不一致"), staleError);

  section("3) mapRender：本机 PNG / 区域裁切 / 标记叠加");
  const full = await G.runMapRender(map.id, { scale: 1, background: "transparent" });
  check("render 返回本机绝对路径", full.localPath.startsWith(HOME) && (await stat(full.localPath)).isFile(), full.localPath);
  check("全图 render 尺寸 = 地图像素", full.width === 8 * 32 && full.height === 8 * 32, `${full.width}×${full.height}`);
  const region = await G.runMapRender(map.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 }, scale: 1, background: "transparent" });
  check("区域 render 尺寸 = 区域像素", region.width === 4 * 32 && region.height === 4 * 32, `${region.width}×${region.height}`);
  const fullBitmap = await decodeFile(full.localPath);
  const regionBitmap = await decodeFile(region.localPath);
  check("区域图 == 全图左上角同一块（逐像素）", pixelsEqual(fullBitmap, regionBitmap, regionBitmap.width, regionBitmap.height), `${regionBitmap.width}×${regionBitmap.height}`);

  const markerOp = await G.applyMapOps(map.id, [{ kind: "marker", op: "add", r: 2, c: 2, name: "宝箱" }], {});
  check("标记写入后 revision 再次变化", markerOp.revision !== applied.revision, String(markerOp.revision));
  const noMarker = await G.runMapRender(map.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 }, scale: 1, background: "transparent" });
  const withMarker = await G.runMapRender(map.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 }, scale: 1, background: "transparent", overlay: { markers: true } });
  check("markersDrawn = 1", withMarker.markersDrawn === 1, String(withMarker.markersDrawn));
  const a = await decodeFile(noMarker.localPath);
  const b = await decodeFile(withMarker.localPath);
  check("标记叠加确实改了像素", !pixelsEqual(a, b, a.width, a.height));
  const inspectedMarker = await G.mapInspect(map.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 } });
  check("inspect 带出标记与编号", inspectedMarker.markers.length === 1 && inspectedMarker.markers[0].n === 1 && inspectedMarker.markers[0].name === "宝箱", JSON.stringify(inspectedMarker.markers));

  await G.applyMapOps(map.id, [{ kind: "marker", op: "update", id: "m1", patch: { kind: "boss", color: "#ff3b30", note: "第二阶段", tags: ["story"] } }], {});
  const metaView = await G.mapView(await G.readMapProject(map.id));
  check("标记 kind / color / note / tags 进入视图", metaView.markers[0].kind === "boss" && metaView.markers[0].color === "#ff3b30" && metaView.markers[0].note === "第二阶段" && metaView.markers[0].tags[0] === "story", JSON.stringify(metaView.markers[0]));
  const mapProject = await G.readMapProject(map.id);
  const mapDoc = await G.readTheDoc(map.id);
  const mapJson = MAP_EXPORT.buildOwnJson(G.renderContextFor(mapProject, mapDoc), mapDoc, mapProject);
  check("导出 JSON 带标记语义并升到 @5", mapJson.format === "dsh-gem-map@5" && mapJson.markers[0].kind === "boss" && mapJson.markers[0].note === "第二阶段", `${mapJson.format} ${JSON.stringify(mapJson.markers[0])}`);
  const composeSource = join(HOME, "compose-source.png");
  const composeRgba = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    composeRgba[i * 4] = 180;
    composeRgba[i * 4 + 1] = 120;
    composeRgba[i * 4 + 2] = 40;
    composeRgba[i * 4 + 3] = 255;
  }
  await writeFile(composeSource, encodePng(composeRgba, 32, 32));
  const composed = await G.composeMapAsset({ projectId: map.id, name: "compose-check", files: [composeSource], shape: "plain" });
  check("composeMapAsset 返回本机 localPath / previewPath", composed.localPath.startsWith(HOME) && (await stat(composed.localPath)).isFile() && composed.previewPath === composed.localPath, `${composed.localPath}`);

  section("4) isoInspect / isoRender");
  const iso = await I.createIsoProject("Agent 45°", { cols: 8, rows: 8 });
  const isoSamples = await I.importIsoSampleTileset(iso.id);
  const isoView = await I.isoView(await I.readIsoProject(iso.id));
  const ground = isoView.tilesets.find((tileset) => tileset.kind === "ground");
  const isoLayer = isoView.layers.find((layer) => layer.kind === "ground").id;
  const grassIso = ground.palette[0].index;
  await I.applyIsoOps(iso.id, [{ kind: "paint", layerId: isoLayer, cells: [{ r: 0, c: 0, tile: grassIso }, { r: 1, c: 1, tile: grassIso }] }], {});
  const isoInspect = await I.isoInspect(iso.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 } });
  check("iso 逐格内容", isoInspect.layers.find((layer) => layer.kind === "ground").rows[0] === "0···", isoInspect.layers[0].rows?.[0]);
  check("iso 统计 filled = 2", isoInspect.stats.filled === 2, JSON.stringify(isoInspect.stats.filled));
  check("iso 图例带素材名", isoInspect.legend.some((entry) => entry.tilesetName === ground.name), JSON.stringify(isoInspect.legend));
  const objectTs = isoView.tilesets.find((tileset) => tileset.kind === "object");
  const objectLayer = isoView.layers.find((layer) => layer.kind === "object").id;
  await I.applyIsoOps(iso.id, [{ kind: "object", op: "add", layerId: objectLayer, tilesetId: objectTs.id, r: 5, c: 5 }], {});
  const isoDocBeforeDup = await I.readTheDoc(iso.id);
  const objectId = isoDocBeforeDup.objects.at(-1).id;
  const dupOut = await I.applyIsoOps(iso.id, [{ kind: "object", op: "duplicate", id: objectId, r: 6, c: 6 }], {});
  const isoDocAfterDup = await I.readTheDoc(iso.id);
  check("iso 物件 duplicate 新增一个同素材物件", dupOut.changed === 1 && isoDocAfterDup.objects.length === 2 && isoDocAfterDup.objects[1].r === 6 && isoDocAfterDup.objects[1].c === 6, JSON.stringify(isoDocAfterDup.objects));
  await I.applyIsoOps(iso.id, [{ kind: "marker", op: "add", r: 2, c: 2, name: "出生点", markerKind: "spawn", color: "#3fb950" }], {});
  const isoProject = await I.readIsoProject(iso.id);
  const isoDoc = await I.readTheDoc(iso.id);
  const isoJson = ISO_EXPORT.buildIsoJson(ISO_RENDER.isoRenderContext(isoProject, isoDoc, isoProject.tilesets), isoDoc, isoProject);
  check("iso 导出 JSON 带标记语义并升到 @2", isoJson.format === "dsh-gem-iso-map@2" && isoJson.markers[0].kind === "spawn" && isoJson.markers[0].color === "#3fb950", `${isoJson.format} ${JSON.stringify(isoJson.markers[0])}`);
  const isoRender = await I.runIsoRender(iso.id, { region: { r0: 0, c0: 0, r1: 4, c1: 4 }, scale: 1, background: "transparent", overlay: { grid: true } });
  check("iso render 返回本机绝对路径", isoRender.localPath.startsWith(HOME) && (await stat(isoRender.localPath)).isFile(), isoRender.localPath);
  check("iso render 至少画了 2 个 op", isoRender.drawn >= 2, String(isoRender.drawn));
  const isoTiles = isoSamples.tilesets;
  check("iso 物件素材仍可列出", isoTiles.some((tileset) => tileset.kind === "object"));

  section("5) 渲染清理");
  const many = [];
  for (let i = 0; i < 22; i++) many.push(await G.runMapRender(map.id, { name: `cleanup-${i}`, region: { r0: 0, c0: 0, r1: 2, c1: 2 } }));
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(join(G.mapProjectDir(map.id), "preview", "agent"))).filter((name) => name.endsWith(".png"));
  check("检查图只保留最近 20 张", files.length <= 20, String(files.length));
  check("最新一张仍在", files.includes(many[many.length - 1].file.split("/").pop()), files.join(","));
} catch (error) {
  failures.push(`异常：${error?.stack ?? error}`);
  console.log(`\n✗ 异常：${error?.stack ?? error}`);
}

console.log(`\n${failures.length === 0 ? "全部通过" : "有失败"}：${checks} 项通过${failures.length > 0 ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
await rm(HOME, { recursive: true, force: true });
