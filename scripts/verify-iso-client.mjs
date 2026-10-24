#!/usr/bin/env node
/**
 * 45° 地图编辑器（模块五 · iso）· 浏览器半区契约自检。
 *
 * 纯本地、不花钱。这里做两件事：
 *   1. **黄金对照**：把 `src/client.ts` 里客户端复刻的 ISO_* 坐标函数抽出来，
 *      拿宿主 `isogeom` / `mapdoc` 的真实现逐点比对；
 *   2. **静态纪律**：计划只按宿主给的 z 排序、带 pending/have、没有旧 tile 组件、
 *      CSS 类都有样式、远程方法表与宿主一致。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
const built = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const GEO = await import("../lib/isogeom.js");
const DOC = await import("../lib/mapdoc.js");

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

section("1) 客户端坐标函数 vs 宿主真实现");
const start = source.indexOf("function ISO_pointToCellRaw");
const end = source.indexOf("function IsoModule", start);
check("能从 src/client.ts 抽出 ISO_* 函数", start > 0 && end > start, `${start}..${end}`);
const scaleConsts = /const ISO_OBJECT_SCALE_MIN = ([\d.]+);\s*\n\s*const ISO_OBJECT_SCALE_MAX = ([\d.]+);/.exec(source);
check("物件大小的上下限是 0.1~4（与宿主同一口径）", scaleConsts !== null && Number(scaleConsts[1]) === 0.1 && Number(scaleConsts[2]) === 4, scaleConsts === null ? "没找到" : `${scaleConsts[1]}~${scaleConsts[2]}`);
const factory = new Function(
  `const ISO_OBJECT_SCALE_MIN = ${scaleConsts === null ? "0.1" : scaleConsts[1]};\nconst ISO_OBJECT_SCALE_MAX = ${scaleConsts === null ? "4" : scaleConsts[2]};\n${source.slice(start, end)}\nreturn { ISO_pointToCellRaw, ISO_pointToCell, ISO_cellCenter, ISO_cellTopLeft, ISO_lineCells, ISO_addPreviewScene };`
);
const C = factory();
const cell = { width: 64, height: 96 };
for (const wrap of [true, false]) {
  const layout = GEO.layoutOf(cell, 12, 9, wrap);
  let cellCenters = 0;
  let cellCentersTotal = 0;
  let hit = 0;
  let hitTotal = 0;
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const hostCenter = GEO.cellCenter(layout, r, c);
      const clientCenter = C.ISO_cellCenter(layout, r, c);
      cellCentersTotal++;
      if (hostCenter.x === clientCenter.x && hostCenter.y === clientCenter.y) cellCenters++;
      const points = [
        [hostCenter.x, hostCenter.y],
        [hostCenter.x - layout.stepX + 0.25, hostCenter.y],
        [hostCenter.x, hostCenter.y + layout.stepY - 0.25]
      ];
      for (const [x, y] of points) {
        hitTotal++;
        const a = GEO.pointToCell(layout, x, y);
        const b = C.ISO_pointToCell(layout, x, y);
        if (a.r === b.r && a.c === b.c && a.inMap === b.inMap) hit++;
      }
    }
  }
  const label = wrap ? "环绕" : "非环绕";
  check(`${label}：cellCenter 逐点一致`, cellCenters === cellCentersTotal, `${cellCenters}/${cellCentersTotal}`);
  check(`${label}：pointToCell 逐点一致`, hit === hitTotal, `${hit}/${hitTotal}`);
  const hostTopLeft = GEO.cellTopLeft(layout, 3, 4, 64, 96);
  const clientTopLeft = C.ISO_cellTopLeft(layout, 3, 4, 64, 96);
  check(`${label}：cellTopLeft 一致`, hostTopLeft.x === clientTopLeft.x && hostTopLeft.y === clientTopLeft.y);
  for (const [r0, c0, r1, c1] of [[0, 0, 8, 5], [10, 10, 1, 1], [3, 7, 3, 7]]) {
    const a = DOC.lineCells(r0, c0, r1, c1);
    const b = C.ISO_lineCells(r0, c0, r1, c1);
    check(`${label}：lineCells(${r0},${c0}→${r1},${c1}) 一致`, JSON.stringify(a) === JSON.stringify(b));
  }
}

section("2) 「新增素材」预览场景 vs 宿主摆放");
{
  /**
   * 预览里地格 / 图片的相对位置必须和宿主 `isogeom` 的摆放逐点一致，
   * 否则用户照着预览摆好的物件，画到地图上就偏一截（而且不报错）。
   */
  const previewCell = { width: 64, height: 96 };
  const previewLayout = GEO.layoutOf(previewCell, 12, 9, true);
  const footprint = { cols: 2, rows: 2 };
  const base = GEO.objectBase(previewLayout, 5, 7, footprint);
  const scene = C.ISO_addPreviewScene({
    cell: previewCell,
    object: true,
    cols: footprint.cols,
    rows: footprint.rows,
    scale: 1,
    anchor: { x: 0.5, y: 1 },
    frames: 1,
    naturalWidth: 128,
    naturalHeight: 160,
    sourceW: 64,
    sourceH: 96
  });
  check("预览菱形半宽 / 半高 = 宿主 stepX / stepY", scene.halfW === previewLayout.stepX && scene.halfH === previewLayout.stepY, `${scene.halfW}/${scene.halfH} vs ${previewLayout.stepX}/${previewLayout.stepY}`);
  let aligned = 0;
  for (let dr = 0; dr < footprint.rows; dr++) {
    for (let dc = 0; dc < footprint.cols; dc++) {
      const host = GEO.cellCenter(previewLayout, 5 + dr, 7 + dc);
      const mine = scene.cells[dr * footprint.cols + dc];
      if (Math.abs(mine.x - (host.x - base.x)) < 1e-9 && Math.abs(mine.y - (host.y - base.y)) < 1e-9) aligned++;
    }
  }
  check("预览里每个占格的中心 = 宿主格中心 − 物件底面中心", aligned === footprint.cols * footprint.rows, `${aligned}/${footprint.cols * footprint.rows}`);
  const hostTop = GEO.objectTopLeft(previewLayout, 5, 7, footprint, scene.image.width, scene.image.height, { x: 0.5, y: 1 });
  check("预览图片左上角（相对底面中心）= 宿主 objectTopLeft − 底面中心", scene.image.x === hostTop.x - base.x && scene.image.y === hostTop.y - base.y, `${scene.image.x},${scene.image.y} vs ${hostTop.x - base.x},${hostTop.y - base.y}`);
  check("物件大小 1 = 图片宽度正好是占格总宽", scene.image.width === footprint.cols * previewCell.width, String(scene.image.width));
  const wide = C.ISO_addPreviewScene({ cell: previewCell, object: true, cols: 1, rows: 1, scale: 2, anchor: { x: 0.5, y: 1 }, frames: 1, naturalWidth: 128, naturalHeight: 160, sourceW: 64, sourceH: 96 });
  check("物件大小 2 = 图片宽度翻倍（用户可自己调）", wide.image.width === 2 * previewCell.width && wide.cells.length === 1, String(wide.image.width));
  const groundScene = C.ISO_addPreviewScene({ cell: previewCell, object: false, cols: 1, rows: 1, scale: 1, anchor: { x: 0.5, y: 1 }, frames: 1, naturalWidth: 128, naturalHeight: 192, sourceW: 64, sourceH: 96 });
  check("地面：128×192 的图按 64×96 切出 2×2 格", groundScene.cols === 2 && groundScene.rows === 2 && groundScene.cells.length === 4, `${groundScene.cols}×${groundScene.rows}`);
  check("地面：每格的菱形中心在格中心", groundScene.cells[0].x === 32 && groundScene.cells[0].y === 48 && groundScene.cells[3].x === 96 && groundScene.cells[3].y === 144, JSON.stringify(groundScene.cells));
}

section("3) 浏览器束里的 iso 组件与坐标把手");
check("注册了 IsoModule", built.includes("function IsoModule"));
check("__test 导出 IsoModule", built.includes("StudioPanel, IsoModule"));
check("__test 导出 ISO_pointToCell / ISO_cellCenter / ISO_cellTopLeft / ISO_lineCells",
  ["ISO_pointToCell", "ISO_cellCenter", "ISO_cellTopLeft", "ISO_lineCells"].every((name) => built.includes(name)));
check("旧的 TileModule 已经移除", !built.includes("function TileModule"));
check("旧的 TileExperimentalDialog 已经移除", !built.includes("TileExperimentalDialog"));

section("4) 计划纪律");
check("客户端按宿主 z 排序，不按 chunk 顺序直接画",
  /list\.sort\(\(a, b\) => a\.z - b\.z/.test(source));
check("计划查询带 have", /api\.isoPlan\(\{[\s\S]{0,400}?have/.test(source));
check("计划查询带 pending", /api\.isoPlan\(\{[\s\S]{0,500}?pending/.test(source));
check("编辑后用 dropKeys 删缓存", /dropKeys/.test(source) && /planRef\.current\.delete/.test(source));
check("预览查询在 pending 时清空 have（否则拖一路看不见）", /pending\.length > 0 \? \[\] : \[\.\.\.planRef\.current\.keys\(\)\]/.test(source));
check("没有客户端自己算自动连接 / 变体", !/a2QuadrantShapes|corner16Mask|nearestMask/.test(source.slice(source.indexOf("function IsoModule"), source.indexOf("function ImageModule"))));

section("5) 界面结构 / 样式 / 文案");
const isoStart = source.indexOf("function IsoModule");
const isoEnd = source.indexOf("function ImageModule", isoStart);
const isoSource = source.slice(isoStart, isoEnd);
for (const cls of ["SPR_isoRoot", "SPR_isoSide", "SPR_isoPalette", "SPR_isoTools", "SPR_isoStage", "SPR_isoCanvas", "SPR_isoCard", "SPR_isoDlg", "SPR_isoLayerRow", "SPR_isoMarkerRow"]) {
  check(`样式 ${cls} 有规则`, source.includes(`.${cls}{`) || source.includes(`.${cls}\{`), "");
}
check("12 个工具格（撤销到设置）", (isoSource.match(/toolButton\(/g) ?? []).length >= 10);
check("调色板可选、可 Shift/Ctrl 多选", /event\.shiftKey === true \|\| event\.ctrlKey === true/.test(isoSource));
check("物件幽灵占格", /fp\.rows/.test(isoSource) && /fp\.cols/.test(isoSource));
check("标记圆圈画法来自宿主计划", /planMarkers/.test(isoSource) && /marker\.radius/.test(isoSource));
check("导出卡有 PNG / JSON / 素材原图三项", /exportFormats\.png/.test(isoSource) && /exportFormats\.json/.test(isoSource) && /exportFormats\.tilesets/.test(isoSource));
check("文案走 T()", /T\("还没有 45° 地图项目。"\)/.test(isoSource));
check("没有把旧 tile 词条带回来", !/地图地块生成/.test(isoSource));
check("素材卡有 AI 生成素材按钮", /data-testid": "iso-ai-open"/.test(isoSource) && /T\("AI 生成素材"\)/.test(isoSource));
check("AI 对话框字段完整（提示词 / 名字 / 帧数 / 方式 / 用途 / 占格）", ["iso-ai-prompt", "iso-ai-name", "iso-ai-mode", "iso-ai-kind", "iso-ai-ok"].every((id) => isoSource.includes(id)));
check("AI 提示词讲清 ground / object / 自动连接不支持", /buildIsoAssetRequestPrompt/.test(source) && /首版只有两种/.test(source) && /4×4/.test(source));
check("AI 回链落点会打开新增素材并预填", /openIsoAiAssetDraft/.test(isoSource) && /intent\.dialog === "add"/.test(isoSource) && /setAddDraft\(/.test(isoSource));
check("深链接接受 ground / object", /OPEN_ISO_SHAPES/.test(source) && /OPEN_ISO_SHAPES\.has\(shape\)/.test(source));
check("小窗口时提示词 textarea 不被 flex 压扁", /\.SPR_isoDlg textarea\.SPR_isoInput\{[^}]*min-height:120px[^}]*flex:0 0 auto/.test(source));
check("「新增素材」预览画的是真正的 2:1 菱形地格（不是矩形网格）",
  /SPR_isoPreviewCell/.test(source) && /SPR_isoPreviewCell/.test(built) && /const halfW = cell\.width \/ 2;/.test(source) && /const halfH = cell\.width \/ 4;/.test(source) && !/SPR_isoPreviewGrid/.test(source));
check("预览地格由 SVG 的 viewBox 等比缩放（地图像素与显示像素分开）", /className: "SPR_isoPreviewSvg"/.test(isoSource) && /viewBox: addPreviewScene\.viewBox/.test(isoSource) && /preserveAspectRatio: "xMidYMid meet"/.test(isoSource));
check("预览地格可拖动并写回锚点", /beginAddPreviewDrag/.test(isoSource) && /onPointerDown: beginAddPreviewDrag/.test(isoSource) && /addDraft\.anchor/.test(isoSource));
check("物件大小可自己调（滑杆 + 百分比 + 导入时发送 objectScale）",
  /"data-testid": "iso-add-scale"/.test(isoSource) && /iso-add-scale-value/.test(isoSource) && /objectScale: addDraft\.kind === "object"/.test(isoSource));
{
  // 用户要求「一边调一边预览」：滑杆必须紧跟预览图，而不是压在表单最下面。
  const scaleAt = isoSource.indexOf('"data-testid": "iso-add-scale"');
  const nameAt = isoSource.indexOf('T("叫什么")');
  check("物件大小滑杆在预览图正下方", scaleAt > 0 && nameAt > 0 && scaleAt < nameAt && /SPR_isoPreviewSizeRow/.test(isoSource), `${scaleAt} < ${nameAt}`);
}
check("导入时把锚点发给宿主", /anchor: addDraft\.kind === "object"/.test(isoSource));

section("6) 远程方法表");
for (const method of ["listIsoProjects", "createIsoProject", "getIsoProject", "saveIsoProject", "deleteIsoProject", "importIsoTileset", "importIsoSampleTileset", "composeIsoAsset", "saveIsoTileset", "removeIsoTileset", "saveIsoDoc", "applyIsoOps", "isoUndo", "isoRedo", "isoPlan", "runIsoGenerate", "runIsoPreview", "runIsoExport", "cancelIsoJob", "setIsoApproved", "revealIsoProject"]) {
  check(`客户端方法表包含 ${method}`, new RegExp(`\\["${method}", (true|false)\\]`).test(source));
}
check("客户端方法表不再包含 tile 方法", !/runTileItems|listTileProjects/.test(source));

console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${passed} 项检查，全部通过。`);
