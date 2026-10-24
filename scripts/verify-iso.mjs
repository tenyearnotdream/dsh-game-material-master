#!/usr/bin/env node
/**
 * 45° 地图编辑器（模块五 · iso）· 几何内核自检。纯本地，不花钱。
 *
 * 盯的是「改一处静默错一片」的口径：
 *   · 2:1 等距的步进 / 中心 / 命中反解；
 *   · 物件底面中心与占格；
 *   · 环绕下的脏块；
 *   · 内置素材的确定性与 16 块自动连接；
 *   · 通行性数组与 op 校验。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "dsh-iso-geom-"));
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

const G = await import("../lib/isogeom.js");
const DOC = await import("../lib/isodoc.js");
const TILES = await import("../lib/isotiles.js");
const SAMPLE = await import("../lib/isosamplegen.js");
const AUTO = await import("../lib/mapauto.js");

section("1) 布局与 2:1 等距");
const cell = { width: 64, height: 96 };
const layout = G.layoutOf(cell, 16, 12, true);
check("stepX = 格子宽 / 2", layout.stepX === 32, String(layout.stepX));
check("stepY = 格子宽 / 4（不是格子高 / 4）", layout.stepY === 16, String(layout.stepY));
check("菱形高 = 格子宽 / 2", layout.diamondHeight === 32, String(layout.diamondHeight));
check("单元格宽必须能被 4 整除", (() => { try { G.assertIsoCell({ width: 65, height: 96 }); return false; } catch { return true; } })());
check("单元格高必须大于菱形高", (() => { try { G.assertIsoCell({ width: 64, height: 32 }); return false; } catch { return true; } })());

section("2) 中心 / 左上角 / 命中测试");
const center00 = G.cellCenter(layout, 0, 0);
const center10 = G.cellCenter(layout, 1, 0);
const center01 = G.cellCenter(layout, 0, 1);
check("cell(0,0) 中心在原点", center00.x === 0 && center00.y === 0, JSON.stringify(center00));
check("cell(1,0) 在左上方向", center10.x === -32 && center10.y === 16, JSON.stringify(center10));
check("cell(0,1) 在右上方向", center01.x === 32 && center01.y === 16, JSON.stringify(center01));
const topLeft = G.cellTopLeft(layout, 3, 4, 64, 96);
const center34 = G.cellCenter(layout, 3, 4);
check("整格贴图左上角 = 中心 − 尺寸一半", topLeft.x === center34.x - 32 && topLeft.y === center34.y - 48, JSON.stringify(topLeft));

let roundTrip = 0;
let total = 0;
for (let r = 0; r < layout.rows; r++) {
  for (let c = 0; c < layout.cols; c++) {
    const p = G.cellCenter(layout, r, c);
    const hit = G.pointToCellRaw(layout, p.x, p.y);
    total++;
    if (hit.r === r && hit.c === c && hit.inMap === true) roundTrip++;
  }
}
check("每格中心都能反解回自己", roundTrip === total, `${roundTrip}/${total}`);

const outsider = G.pointToCellRaw(layout, -10000, 10000);
check("图外点 inMap=false", outsider.inMap === false, JSON.stringify(outsider));
const wrapped = G.pointToCell(layout, -10000, 10000);
check("环绕时图外点折回图内且 inMap=true", wrapped.inMap === true && wrapped.r >= 0 && wrapped.c >= 0 && wrapped.r < layout.rows && wrapped.c < layout.cols, JSON.stringify(wrapped));

section("3) 物件底面中心");
const base11 = G.objectBase(layout, 5, 7, { cols: 1, rows: 1 });
const c57 = G.cellCenter(layout, 5, 7);
check("1×1 物件底面中心 = 格子中心", base11.x === c57.x && base11.y === c57.y, JSON.stringify(base11));
const base22 = G.objectBase(layout, 5, 7, { cols: 2, rows: 2 });
check("2×2 物件底面中心在四格正中", base22.x === c57.x && base22.y === c57.y + layout.stepY, JSON.stringify(base22));
const objTopLeft = G.objectTopLeft(layout, 5, 7, { cols: 2, rows: 2 }, 128, 160);
check("2×2 物件左上角 = 底面中心 − 宽/2、− 高", objTopLeft.x === base22.x - 64 && objTopLeft.y === base22.y - 160, JSON.stringify(objTopLeft));
check("物件占格完整在地图内才放得下", G.footprintInside(layout, 15, 11, { cols: 2, rows: 2 }) === false && G.footprintInside(layout, 10, 10, { cols: 2, rows: 2 }) === true);

section("4) 包围盒与脏块");
const bounds = G.groundBounds(layout);
check("包围盒包含整张网格", bounds.width > 0 && bounds.height > 0, JSON.stringify(bounds));
const dirty = G.dirtyChunksFor([{ r: 0, c: 5 }], layout);
check("画第 0 行会连带弄脏最后一行所在的块", dirty.includes("0,1"), dirty.join(","));
const cleanDirty = G.dirtyChunksFor([{ r: 5, c: 5 }], layout);
check("中间一格只影响邻近块（不碰最后一行）", !cleanDirty.includes("0,1"), cleanDirty.join(","));
check("z 随层号增大", G.isoDepthZ(1, 2, 3) > G.isoDepthZ(0, 2, 3));
check("同层内前排 z 更大", G.isoDepthZ(0, 3, 3) > G.isoDepthZ(0, 2, 2));

section("5) 内置素材");
const samplesA = SAMPLE.renderIsoSamples(cell);
const samplesB = SAMPLE.renderIsoSamples(cell);
check("内置素材数量", samplesA.length === 10, String(samplesA.length));
check("两次生成逐字节一致", samplesA.every((sample, index) => sample.bytes.equals(samplesB[index].bytes)));
const autotile = samplesA.find((sample) => sample.kind === "autotile");
check("自动连接是 4×4 = 16 块", autotile !== undefined && autotile.bytes.length > 0 && autotile.frames === 1);
const water = samplesA.find((sample) => sample.name === "水面");
check("水面有 2 帧", water !== undefined && water.frames === 2 && water.animRows === true);
const house = samplesA.find((sample) => sample.name === "石屋");
check("石屋占 2×2", house !== undefined && house.footprint.cols === 2 && house.footprint.rows === 2 && house.pass.length === 4);
{
  // 水面必须是**整块同色**：任何只在内部出现的纹理都会在相邻两格之间留一条底色边，
  // 拼起来就是一张深色网格线（真机反馈的「素材拼起来有缝」）。
  const { writeFile } = await import("node:fs/promises");
  const { decodeFile } = await import("../lib/bitmap.js");
  const file = join(HOME, "water-sample.png");
  await writeFile(file, water.bytes);
  const bitmap = await decodeFile(file);
  const colors = new Set();
  let semi = 0;
  for (let i = 0; i < bitmap.width * bitmap.height; i++) {
    const a = bitmap.rgba[i * 4 + 3];
    if (a === 0) continue;
    if (a !== 255) semi++;
    colors.add(`${bitmap.rgba[i * 4]},${bitmap.rgba[i * 4 + 1]},${bitmap.rgba[i * 4 + 2]}`);
  }
  check("水面没有半透明边（拼接不会露底色）", semi === 0, String(semi));
  check("水面是整块同色（只随帧变色，没有每格一圈的边）", colors.size <= 2, [...colors].join(" / "));
}

section("6) 素材切分 / 自动连接掩码");
const cols = 2;
const bitmap = { width: 64 * cols, height: 96, rgba: Buffer.alloc(64 * cols * 96 * 4) };
const tiles = TILES.rebuildIsoTiles({ kind: "ground", cell, imageWidth: bitmap.width, imageHeight: bitmap.height, frames: 1, animRows: false });
check("地面静态：2 列 → 2 块", tiles.length === 2, String(tiles.length));
const autoTiles = TILES.rebuildIsoTiles({ kind: "autotile", cell, imageWidth: 64 * 4, imageHeight: 96 * 4, frames: 1, animRows: false });
check("自动连接切出 16 块", autoTiles.length === 16, String(autoTiles.length));
check("自动连接 mask 0..15 行优先", autoTiles.every((tile, index) => tile.mask === index));
check("位序：N=1 E=2 S=4 W=8", AUTO.NB4_N === 1 && AUTO.NB4_E === 2 && AUTO.NB4_S === 4 && AUTO.NB4_W === 8);
const mask = AUTO.corner16Mask((r, c) => c === 1, 0, 0);
check("只连右邻居时 mask 含 E 位", (mask & AUTO.NB4_E) !== 0 && (mask & AUTO.NB4_N) === 0, String(mask));

section("7) 通行性 / op 校验");
const fp = { cols: 2, rows: 2 };
check("通行性长度必须等于占格数", (() => { try { TILES.parsePassCells([0, 1], fp); return false; } catch { return true; } })());
check("通行性只接受 0/1/2", (() => { try { TILES.parsePassCells([0, 3, 1, 1], fp); return false; } catch { return true; } })());
const doc = DOC.createIsoDoc("gtest", "测试", 8, 8);
const layout8 = G.layoutOf(cell, 8, 8, true);
const paint = DOC.applyIsoOps(doc, [{ kind: "paint", layerId: "l0", cells: [{ r: 1, c: 1, tile: 1 }] }], layout8);
check("地面 op 写入并标脏", paint.changed === 1 && paint.dirty.length === 1 && doc.data.l0[1 * 8 + 1] === 1);
const obj = DOC.applyIsoOps(doc, [{ kind: "object", op: "add", layerId: "l1", tilesetId: "ts1", r: 2, c: 2 }], layout8, { footprintOf: () => fp, isObjectTileset: () => true });
check("物件 op 新增成功", obj.changed === 1 && doc.objects.length === 1, JSON.stringify(obj.skipped));
const overlap = DOC.applyIsoOps(doc, [{ kind: "object", op: "add", layerId: "l1", tilesetId: "ts1", r: 3, c: 3 }], layout8, { footprintOf: () => fp, isObjectTileset: () => true });
check("同层物件不能重叠", overlap.changed === 0 && overlap.skipped.length > 0);
check("物件大小默认不写（= 100%）", TILES.parseIsoObjectScale(undefined) === undefined && TILES.parseIsoObjectScale(null) === undefined);
check("物件大小接受 0.1 ~ 4", TILES.parseIsoObjectScale(0.1) === 0.1 && TILES.parseIsoObjectScale(4) === 4 && TILES.parseIsoObjectScale(0.333) === 0.333);
check("物件大小越界 / 非数字明确报错（不静默夹住）", (() => { try { TILES.parseIsoObjectScale(9); return false; } catch { return true; } })() && (() => { try { TILES.parseIsoObjectScale("abc"); return false; } catch { return true; } })());
const undoObj = DOC.applyIsoOps(doc, obj.undo, layout8, { footprintOf: () => fp, isObjectTileset: () => true });
check("物件逆操作删掉它", undoObj.changed === 1 && doc.objects.length === 0);

await rm(HOME, { recursive: true, force: true });
console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${passed} 项检查，全部通过。`);
