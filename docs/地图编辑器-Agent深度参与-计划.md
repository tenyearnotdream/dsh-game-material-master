# 地图编辑器 · Agent 深度参与计划

> 状态：计划稿（尚未实现）  
> 适用模块：模块五「45° 地图编辑器」`iso` / 模块六「俯视地图编辑器」`map`  
> 基线版本：`0.10.2`  
> 相关文档：[45° 地图编辑器设计文档](45度地图编辑器-设计文档.md) · [俯视地图编辑器设计文档](地图编辑器-设计文档.md) · [ENGINEERING.md](ENGINEERING.md)

> **实施进度（2026-10-25）**：Phase 0 已落地；Phase 1 已落地「`dryRun` / `ifRevision`、标记 `kind/color/note/tags` + `marker update`、`import*({path})`、`upload.options`、`compose*` 返回 `localPath/previewPath`、整图 `stampMove/Rotate`、45° 物件 `duplicate`」。未落地：图形原语（line/ellipse/polygon / 地面区域复制）、整图 `stampDuplicate`、区域、检查点、diff、按像素 `view` 渲染、`regions` 叠加。本文其余部分是完整目标设计；实际契约以 §6 的落地差异说明为准。

**落地差异（相对下方目标设计）**

- `mapInspect` / `isoInspect` 已按 §6.1 实现；`region` 为右下开区间（`r1` / `c1` 不含），默认预算 4096 格。
- `mapRender` / `isoRender` 已按 §6.2 实现同步检查图，但只接受 `region`（暂不接受像素 `view`）；`overlay.outlines` 可用；`overlay.regions` 字段已进 schema、暂不绘制；标记只画编号，不把中文名烧进图。
- 标记语义字段已落盘、进 `map.json` / `iso map.json`；有语义字段时格式分别为 `dsh-gem-map@5` / `dsh-gem-iso-map@2`，没有时仍写 `@4` / `@1`。
- `composeMapAsset` / `composeIsoAsset` 的 `previewPath` 目前指向整理后的素材图本身（还不是单独的总览图）。
- `importMapTileset` / `importIsoTileset` 增加 `path`，宿主自己读盘；`upload` 的 `options` 已透传（map / iso 的 tileset）。

**阅读顺序**：§1 结论 → §2 目标 → §3 现状与缺口 → §4 原则 → §5 能力地图 → §6 接口 → §7 工作流 → §8 分期 → §9 验收 → §10 风险 → §11 待决策。

## 一、一句话结论

两套编辑器现在已经有完整的**本地写入链路**（素材、编辑、一键生成、导出）和**宿主唯一渲染器**，但 Agent 仍然更像一个「会调写入接口的脚本」：它画得动，却看不清自己画成了什么；能改格子，却拿不到一份稳定的语义状态；能加标记，却没法表达「这是什么位置」；能一次提交很多 op，却没有版本、对比和可回退的中间结果。

本计划把 Agent 补成编辑器的**一等使用者**，围绕一个闭环设计：

```text
读状态（inspect）→ 出方案（ops / blueprint）→ 批量执行（apply）
      ↑                                      ↓
      └──── 看效果图（render + read_image）← 校验（stats / diff / review）
```

实现上全部是**加法**：不改现有 UI 的几何口径、不新建第二套渲染器、不让 Agent 在客户端算坐标、不把 AI 生图搬进地图模块。两套编辑器共享同一套 Agent 协议，只在几何、物件、整图等差异处分开。

## 二、目标与非目标

### 2.1 目标

1. **每个环节都可参与**：建项目 / 改网格与图层、找素材、生成素材、铺地形、放物件与建筑、标记特殊位置、看中间效果、导出、验收。
2. **每个环节都可观测**：任何一次写入后，Agent 能拿到紧凑的状态摘要和一张可以用 `read_image` 打开的效果图。
3. **每个环节都可迭代**：有 `revision` 防止旧状态覆盖新状态，有命名检查点与差异对比，能安全地「改一版、看一眼、再改」。
4. **两套编辑器同构**：`map*` 与 `iso*` 的方法形状尽量一致；差异只体现在 `cell` / `objects` / `stamps` / `pass` 等数据上。
5. **不牺牲现有产品约束**：宿主仍是唯一写者与几何权威；AI 素材仍由用户在「新增素材」确认；本地渲染零计费；界面与 Agent 读写同一份数据。

### 2.2 非目标

- 不做 3D 透视、六边形网格、多张地图并存、运行时游戏引擎。
- 不把地图模块改成「提示词进、地图出」的黑盒；Agent 仍然通过明确的 op 和可审查的结果工作。
- 不在 `map` / `iso` 里重新实现生图或视频生成；生成继续走图片 / 序列帧模块，地图模块只负责整理与导入。
- 不让 Agent 直接改 `map.json` / `project.json`，也不新增一条绕过宿主的写盘路径。
- 不在首版做「AI 自动生成 4×4 完美自动连接」；现有 `composeMapAsset` 的「一块无缝砖」策略保持不变。
- 不把标记烧进导出 PNG；标记是源数据，效果图里的标记只用于检查。

## 三、现状盘点（0.10.2）

### 3.1 已经能做什么

| 环节 | `map`（俯视） | `iso`（45°） | Agent 现状 |
|---|---|---|---|
| 项目 | `listMapProjects` / `createMapProject` / `getMapProject` / `saveMapProject` / `deleteMapProject` | `listIsoProjects` / `createIsoProject` / `getIsoProject` / `saveIsoProject` / `deleteIsoProject` | 可建、可改、可删，返回视图 |
| 素材 | `importMapTileset`（base64）/ `importSampleTileset` / `composeMapAsset` / `recomposeMapTileset` / `saveMapTileset` / `removeMapTileset` | `importIsoTileset`（base64）/ `importIsoSampleTileset` / `composeIsoAsset` / `saveIsoTileset` / `removeIsoTileset` | 可导入、可整理 AI 图、可改表现层；可视化与交接路径不足 |
| 画布结构 | `saveMapDoc`（尺寸 / 图层 / 环绕） | `saveIsoDoc`（尺寸 / 图层） | 可改名、换序、增删、清层 |
| 编辑 | `applyMapOps`：`paint` / `fill` / `rect` / `replace` / `marker` / `stampPlace` / `stampRemove` | `applyIsoOps`：`paint` / `fill` / `rect` / `replace` / `object(add/move/remove)` / `marker` | 可批量画；撤销重做可用；表达力有限 |
| 生成 | `runMapGenerate`：random / maze / continent | `runIsoGenerate`：random / maze / continent | 同种子可复现，但只能整层生成 |
| 渲染计划 | `mapPlan`（按视口、chunk、`have`、`pending`） | `isoPlan`（按视口、chunk、`z` 排序） | 面向界面增量绘制，不是给 Agent 读的状态模型 |
| 预览 / 导出 | `runMapPreview` / `runMapExport` | `runIsoPreview` / `runIsoExport` | 预览异步、只回 `started`；导出产物路径可用 |
| 验收 | `review` / `status` / `approve` / `setMapApproved` | 同左（`setIsoApproved`） | 能验收，但验收包缺少标记 / 物件 / 本地图片路径 |
| 提示 | `reviewMode`、`nextActions`、工具手册 | 同左 | 有流程，但没有「读 → 画 → 看」的 Agent 工作流 |

### 3.2 关键缺口

#### G1 · 缺少语义读模型

`getMapProject` / `getIsoProject` 返回的是**界面视图**：尺寸、图层统计、素材调色板、标记表、导出清单；`iso` 另有物件表。它不返回「某一层每一格现在是什么」。

Agent 想回答这些问题时没有稳定入口：

- 地图中央 8×8 区域现在铺的是水还是草？
- 哪些格子是空的？哪些格子引用了不存在的图块？
- 这一片建筑压住了哪几格？通行性是什么？
- 我刚画的这条路，和上一版相比改了哪些格？

现有替代品都不合适：

- **`mapPlan` / `isoPlan`** 是给客户端增量绘制的 chunk 计划，带 `visibleKeys`、`have`、`truncated`，按视口变化；它不是语义状态，而且只包含可见块。
- **`getMapProject.tilesets[].palette`** 只告诉 Agent「有哪些笔刷」，不告诉它「已经画了什么」。
- **直接读 `map.json`** 会绕过宿主的归一化与校验，而且文件里是 1-based 全局序号，Agent 还得自己反推素材 / 图块；这条路不应成为产品契约。

结论：需要一套**按区域、按预算、可读可机读**的 `mapInspect` / `isoInspect`。

#### G2 · 看不到效果图

`runMapPreview` / `runIsoPreview` 是后台任务，返回 `{started, reason}`；真正写出的 `preview/map.png` 只能在后续 `get*Project` 的 `preview` 数组里看到**相对路径**，或在 `status` / `review` 的 `previewUrls` 里看到**绝对 URL**。

这带来三个问题：

1. **Agent 拿不到本机绝对路径**。当前环境里 Agent 用 `read_image` 看的是文件，不是 URL；要么再想办法把 URL 下载到临时文件，要么只能把链接贴给用户看，自己并没有「看见」。
2. **预览是全图、固定 1×、无叠加**。想检查一个 8×8 角落、放大看接缝、看标记位置、看通行区域，都没有入口。
3. **预览图不含标记**。设计上 `map.png` 不画标记（标记是源数据，由引擎渲染），`rasterize` / `rasterizeIso` 也确实只画图块与物件。Agent 加完标记后无法从效果图确认位置。

结论：需要同步、按区域、可叠加、返回本地路径的 `mapRender` / `isoRender`，并让它与导出共用同一份计划。

#### G3 · 标记太薄

当前标记只有 `{ id, r, c, name }`：

- 没有类型（出生点 / 出口 / 宝箱 / Boss / 事件 / 资源点 / NPC / 自定义）。
- 没有颜色、备注、标签。
- 只有「一格一个标记」，没有区域。
- `map` 的验收包不带 `markers`；`iso` 的验收包不带 `markers` 与 `objectList`。
- 标记能导出进 `map.json`，但导出 PNG 不画；Agent 只能读 JSON 里的坐标。

Agent 真正需要的是「**这个位置是什么**」而不只是「这里有个圈」。结论：扩展标记语义（P1），再补区域（P2）。

#### G4 · 排布表达力不足

现有 op 是「逐格」的：`paint` 给 cells，`rect` / `fill` / `replace` 给矩形或替换规则。对 Agent 来说：

- 画一条斜路、一个圆形广场、一个多边形湖泊，要么自己逐格算（等于把几何搬进模型），要么发一个巨大的 `cells` 数组（token 成本高、容易漏格）。
- 地图上的整图（`stampPlace`）只能放和删，不能移动 / 旋转 / 复制已有实例。
- 45° 物件不能复制；摆放一组树要逐个 `add`。
- 没有 `dryRun`，Agent 不确定一批 op 会不会被 `skipped` 时只能先提交。
- 没有 `ifRevision`，并发编辑时可能把旧状态覆盖回去。
- 没有 `line` / `ellipse` / `polygon` / `duplicate` 这些「宿主算几何、Agent 只描述意图」的原语。

结论：扩展 `applyMapOps` / `applyIsoOps`，新增宿主展开的图形原语与事务选项；所有新 op 必须复用现有 `applyOps` / `applyDocOps` 的校验、脏块、撤销逻辑。

#### G5 · 素材交接不顺

- `importMapTileset` / `importIsoTileset` 的主入口要 `data: base64`；Agent 得先读文件、base64、塞进工具参数，容易撞上下文和请求体上限。
- `upload` 支持 `module=map|iso, kind=tileset`，但 `map` 只走默认自动识别，`iso` 固定按 `ground` 切；不能顺带传 `cell` / `shape` / `kind` / `footprint` / `objectScale` / `pass`。Agent 想导一张物件图，仍然要回到 `importIsoTileset` 手拼 base64。
- `composeMapAsset` / `composeIsoAsset` 收绝对路径，但返回体只有相对 `file`，没有本机 `localPath`；Agent 想把整理结果再喂给下一步（检查、预览、导入）还得自己拼路径。
- 素材只有 `palette[].index` 与 `rect`，没有一张「带编号的素材总览图」。Agent 选笔刷序号时只能信数字，不能看。
- AI 生成链路是「图片 / 序列帧模块生成 → `compose*` 整理 → 用户确认导入」；这条链路本身是对的，但中间的「整理结果长什么样」Agent 看不到。

结论：补齐**路径导入 + 选项透传 + 本机路径返回 + 素材总览图**；不改变「属性在新增时定死、AI 素材由用户确认」的产品规则。

#### G6 · 没有版本与中间结果

- 每次 `apply*` 只回 `changed` / `skipped` / `dirtyChunks` / `dropKeys` / `canUndo`，没有 `revision`。
- 预览与导出是异步的，Agent 往往先 `wait` 再重新 `get*Project`；如果期间用户又改了一笔，Agent 无法知道自己看的是哪一版。
- 有撤销 / 重做，但没有命名检查点；「这个方案先存一下，再试另一个」只能靠导出 JSON。
- 没有 diff；Agent 改完一大片后，很难核对「只改了预期的那些格」。

结论：引入 `revision`（P0）、检查点与 diff（P2）。不把派生结果落盘成第二份地图数据；检查点只存**文档源数据**。

#### G7 · 验收包与工具手册没跟上

- `review` 的 `map` 分支给 `stages` / `tilesets` / `layers` / `filled` / `previewUrls`，没有 `markers`。
- `iso` 分支给 `objects` 数量，没有 `objectList`，也没有 `markers`。
- 工具手册的 `map` / `iso` 主题列了方法，但没有「先 inspect 再 render、用 read_image 看、不要用 mapPlan 读状态」这类 Agent 工作流。
- 新方法如果只进 wire、不进 `TOOL_METHODS` / 手册，Agent 调不到或不知道；`verify-tools` 的方法覆盖检查会拦。

结论：验收包与手册是本计划的一部分，不是实现后的文档补充。

## 四、设计原则

| 原则 | 含义 | 为什么必须 |
|---|---|---|
| **宿主唯一写者 / 几何权威** | Agent 只发 cell / region / op；坐标换算、裁剪、旋转、自动连接、z 排序全在宿主 | 编辑器已经因为「两边各算一遍」踩过「预览好看、导出位移」；不能为了 Agent 再开一条 |
| **一份计划，三种用途** | 界面绘制、导出 PNG、Agent 效果图都从 `buildPlan` / `buildIsoPlan` 出发 | 保证「Agent 看到的就是导出的」，而不是再写一个截图器 |
| **读模型与绘制计划分离** | `inspect` 给语义（层 / 格 / 图块 / 标记），`plan` 给像素 op；Agent 默认用前者 | chunk 计划是界面增量缓存协议，不是状态查询 API |
| **有界输出** | `maxCells` / `maxPixels` / `include` / `region`；超限明确报错或返回 `truncated` + 建议区域，绝不静默截断 | 512×512×多层可以轻松把上下文和内存打爆 |
| **本地路径给模型，URL 给用户** | 渲染 / 素材 / 检查点返回 `localPath`；同时保留 `url` / `openUrl` | Agent 用 `read_image` 看文件；用户点链接进界面 |
| **所有写入可回滚** | 新 op 走现有 `applyOps` / `applyDocOps`，返回 `revision`，支持 `dryRun` / `ifRevision` | 深度参与意味着更多自动写入，必须能撤销、能防旧覆盖 |
| **计费边界不移动** | 地图渲染、检查点、diff、素材整理全部本地免费；生图 / 视频继续由图片 / 序列帧模块计费 | 不能因为「Agent 方便」让地图模块偷偷产生费用 |
| **加法优先** | 现有方法签名与返回字段保持兼容；新字段可选；导出格式按需升版 | 界面、老项目、现有自检都依赖当前契约 |
| **界面与Agent同源** | 新读模型也被界面复用；标记类型、颜色、区域在界面上可见 | 否则又会出现「Agent 能标、用户看不懂」的双轨 |

## 五、目标能力地图

| 环节 | 现状 | 本次计划 | Agent 最终能做什么 |
|---|---|---|---|
| 项目 / 网格 | 可建、可改尺寸 / 图层 | 返回 `revision`；`inspect` 给出当前尺寸与图层统计 | 知道自己在一张多大的图上改，改结构后能确认影响 |
| 素材导入 | base64 为主；`upload` 选项少 | `path` 导入、`upload.options`、素材总览图、本机路径 | 一条命令导入自己的素材，并看见切出来的块 |
| 素材生成 | 图片 / 序列帧 → `compose*` → 用户确认 | `compose*` 返回 `localPath` / `previewPath`；可选由用户明确授权的自动导入 | 生成 → 整理 → 自己先看一遍 → 再交给用户确认或按授权导入 |
| 地形铺排 | paint / fill / rect / replace | 增加 line / polyline / ellipse / polygon / duplicate；`dryRun` | 用「一条路 / 一个湖 / 一片广场」描述意图，宿主展开成格子 |
| 自动连接 | 宿主自动，Agent 只需给代表序号 | `inspect` 显示图块语义；`render` 可看接缝 | 选对笔刷、检查自动连接结果 |
| 物件 / 建筑 | iso 可 add/move/remove；map 整图可 place/remove | iso 增加 duplicate；map 增加 stampMove / stampRotate / stampDuplicate | 摆一组树、挪一栋房、转一张整图，不用重放 |
| 标记 | 名字 + 坐标 | `kind` / `color` / `note` / `tags`；批量 update；效果图叠加 | 标出出生点、宝箱、Boss、出口，并让用户看懂 |
| 区域 | 无 | P2：矩形 / 多边形 / 格子集合区域 | 标出「出生区」「禁建区」「Boss 战场」 |
| 读状态 | 只有视图与 chunk 计划 | `mapInspect` / `isoInspect`，支持区域、文本网格、统计 | 精确回答「这一片是什么」 |
| 看效果 | 全图异步预览、无标记、只有 URL | `mapRender` / `isoRender`，同步、区域、缩放、叠加、本地路径 | 画完就能看，必要时放大到一格 |
| 中间结果 | 撤销 / 重做 + 导出 | `revision`、命名检查点、diff | 改坏了能回、能对比、能只重做变的那部分 |
| 验收 | review 包信息不全 | 验收包补 markers / objects / previewPaths / revision | 自己先验一遍，再让用户点通过 |
| 导出 | PNG + JSON + zip | 导出清单带 revision；标记 / 区域进 JSON | 交付可追溯，能说清「这是哪一版地图」 |

## 六、接口方案

下面所有方法都通过现有唯一工具入口调用：

```js
game_material({ action: "call", method: "<方法名>", payload: { … } })
```

新增方法必须同时进入 `src/wire.ts`、`src/index.ts`、`src/tools.ts` 的 `METHOD_MODULE`、`src/toolguides.ts`，缺一处就是「做了但 Agent 调不到 / 不知道」。

**方法总表**

| 阶段 | `map` | `iso` | 类型 |
|---|---|---|---|
| P0 | `mapInspect` / `mapRender` | `isoInspect` / `isoRender` | 新增 |
| P0 | `getMapProject` / `status` / `review` 增加 `revision` / `previewPath(s)` | 同左 | 增强 |
| P1 | `applyMapOps` 增加 `line` / `polyline` / `ellipse` / `polygon` / `duplicate` / `stampMove` / `stampRotate` / `stampDuplicate` / `marker update` | `applyIsoOps` 增加 `line` / `polyline` / `ellipse` / `polygon` / `duplicate` / `object duplicate` / `marker update` | 增强 |
| P1 | `importMapTileset` 增加 `path`；`upload` 增加 `options` | `importIsoTileset` 增加 `path`；`upload` 增加 `options` | 增强 |
| P1 | `composeMapAsset` 返回 `localPath` / `previewPath` | `composeIsoAsset` 返回 `localPath` / `previewPath` | 增强 |
| P2 | `saveMapCheckpoint` / `listMapCheckpoints` / `restoreMapCheckpoint` / `deleteMapCheckpoint` / `mapDiff` | `saveIsoCheckpoint` / `listIsoCheckpoints` / `restoreIsoCheckpoint` / `deleteIsoCheckpoint` / `isoDiff` | 新增 |
| P2 | `mapTilesetSheet` / 区域数据与 op | `isoTilesetSheet` / 区域数据与 op | 新增 |
| P3 | 可选的 `mapApplyBlueprint` | 可选的 `isoApplyBlueprint` | 可选 |

### 6.1 语义读模型：`mapInspect` / `isoInspect`

**目的**：给 Agent 一份可读、可机读、可控大小的地图状态，而不是渲染计划。

**payload**

```jsonc
{
  "projectId": "m…",
  "region": { "r0": 0, "c0": 0, "r1": 16, "c1": 16 }, // 可选，右下开区间；省略 = 全图
  "layerIds": ["l0", "l1"],                           // 可选；默认全部层
  "include": ["layers", "markers", "objects", "stamps", "pass", "stats", "legend"],
  "format": "both",                                    // text | json | both
  "maxCells": 4096,                                    // 默认 64×64 预算，上限 65536
  "maxItems": 200                                      // markers / objects 的列表上限
}
```

**返回**

```jsonc
{
  "module": "map",
  "projectId": "m…",
  "revision": "a1b2c3d4e5f6",
  "cols": 32,
  "rows": 32,
  "grid": { "tileWidth": 32, "tileHeight": 32, "wrap": true },
  "range": { "r0": 0, "c0": 0, "r1": 15, "c1": 15 },
  "truncated": false,
  "nextRange": null,
  "legend": [
    {
      "symbol": "a",
      "index": 33,
      "tilesetId": "ts…",
      "tilesetName": "草地",
      "tileId": "t0_4",
      "rect": { "x": 0, "y": 128, "width": 32, "height": 32 },
      "shape": "a2quad",
      "mask": 15,
      "variant": 0,
      "frame": 0
    }
  ],
  "layers": [
    {
      "id": "l0",
      "name": "地理层",
      "kind": "ground",
      "filled": 256,
      "rows": ["aaaaaaaa…", "………………"]
    }
  ],
  "markers": [
    { "id": "m1", "n": 1, "r": 3, "c": 4, "name": "宝箱", "kind": "chest", "color": "#f0c040", "note": "", "tags": [] }
  ],
  "objects": [],
  "stats": {
    "filled": 256,
    "empty": 768,
    "fillRate": 0.25,
    "byLayer": [{ "id": "l0", "filled": 256 }],
    "tileHistogram": [{ "index": 33, "count": 256 }],
    "markersByKind": [{ "kind": "chest", "count": 1 }]
  },
  "warnings": [],
  "text": "地理层\n  aaaaaaaa…\n  …………\n图例：a=草地/33"
}
```

**契约**

1. `layers[].rows` 的每个字符对应 `legend[].symbol`；空 cell 固定用 `·`，不会把 `·` 分配给图块。符号只用于显示，写入仍然用 `index`。
2. `format:"text"` 时只返回 `text` + `legend` + `stats`，不返回逐层数组；`format:"json"` 时不拼 `text`。`both` 两者都给。
3. `region` 越界时按地图边界夹住；环绕（`wrap`）开启时，`region` 允许越界并按取模读取，但返回的 `range` 是**请求范围**，每行标注原始 r/c，避免 Agent 误以为是规范坐标。
4. `maxCells` 超限时**不截断内容**：返回 `truncated:true`、`nextRange`（建议的 64×64 起点）、只给 `stats` 与 `warnings`，让 Agent 改小区域重查。
5. `markers` / `objects` / `stamps` 超过 `maxItems` 时截断列表并给 `truncatedItems`；统计仍然基于全量。
6. `revision` 来自「文档 + 素材元数据 + 素材文件 mtime」的短哈希，不落盘；同一状态多次调用必须相同。
7. `isoInspect` 额外返回 `cell`、`objects`（含 `footprint`、`layerId`、`tilesetId`、`r/c`、占格）、`pass`；`layers` 中 `kind:"object"` 的层没有 `data` 网格，用 `objects` 表达。
8. `mapInspect` 额外返回 `stamps`（整图实例、占格、旋转、逐格通行性）与 `pass`；`isoInspect` 的 `pass` 来自物件 `pass[]`。
9. 读取的是宿主内存里的**当前文档**（包含尚未防抖落盘的编辑），不要要求先 `flush`；`inspect` / `render` 本身不写盘、不改文档。
10. 所有 `skipped` / `warnings` 沿用现有中文风格；不抛「看起来成功」的错。

**为什么不是 `mapPlan`**

`mapPlan` 回的是 `chunks[].ops`，带像素坐标、图块序号、`cycle`，而且只回 `visibleKeys - have`；它适合界面增量绘制，不适合 Agent 回答「这一格是什么」。`inspect` 不依赖视口，不返回像素坐标，也不触发缓存。

### 6.2 效果图：`mapRender` / `isoRender`

**目的**：让 Agent 在任意中间步骤拿到一张能直接 `read_image` 的 PNG，并且这张图和导出使用同一份绘制计划。

**payload**

```jsonc
{
  "projectId": "m…",
  "region": { "r0": 4, "c0": 4, "r1": 11, "c1": 11 }, // 与 view 二选一；推荐 region
  "view": { "x": 0, "y": 0, "width": 640, "height": 480 }, // 可选，像素视口，给高级用法
  "scale": 2,                                          // 1~4 整数，最近邻
  "layerIds": ["l0", "l1"],
  "frame": 0,                                          // 静态检查用第几帧，默认 0
  "background": "transparent",                         // transparent | checker | white | dark
  "overlay": {
    "markers": "labels",                               // false | true | "labels"
    "grid": true,
    "axes": true,
    "pass": true,
    "objects": true,
    "regions": true,
    "outlines": [
      { "r": 5, "c": 6, "color": "#ff3b30", "label": "入口" }
    ]
  },
  "maxPixels": 16000000,
  "name": "inspect-1"
}
```

**返回**

```jsonc
{
  "module": "map",
  "projectId": "m…",
  "revision": "a1b2c3d4e5f6",
  "file": "preview/agent/inspect-1-a1b2c3d4.png",
  "localPath": "/…/map-jobs/m…/preview/agent/inspect-1-a1b2c3d4.png",
  "url": "http://…/dsh-game-material-master/map-assets/m…/preview/agent/inspect-1-a1b2c3d4.png",
  "width": 512,
  "height": 512,
  "crop": { "x": 128, "y": 128, "width": 256, "height": 256 },
  "scale": 2,
  "range": { "r0": 4, "c0": 4, "r1": 11, "c1": 11 },
  "drawn": 64,
  "markersDrawn": 2,
  "objectsDrawn": 3,
  "warnings": [],
  "truncated": false,
  "stale": false,
  "elapsedMs": 42
}
```

**契约**

1. **同步**执行。本地渲染加 PNG 编码通常够快；超过 `maxPixels` 时明确报错并建议 `region` / `scale`，不退化成后台任务。
2. **不写阶段、不触发验收**。`render` 只产出检查图；阶段通过仍然走 `setMapApproved` / `approve`。
3. **一份计划**：`mapRender` 必须复用 `buildPlan` 的 `range`，`isoRender` 必须复用 `buildIsoPlan` 的 `range` 与 `z` 排序；只允许在光栅化之后做「按 crop 裁」，不允许另写一套坐标换算。
4. **标记从计划来**：`buildPlan` / `buildIsoPlan` 已经算出标记圆心、半径、字号；叠加层只 `arc` / `fillText`，颜色按 `kind` 查表。不得在渲染里重新推 `r/c → 像素`。
5. **网格 / 坐标轴**：地图按 cell 边界画线；45° 按菱形边画线。行号 / 列号画在图片边缘，不压在地图内容上。
6. **通行性叠加**：`pass` 用很淡的半透明色（与界面「区域」开关同口径：0 / 1 / 2 三态），不能盖住素材细节。
7. **临时标注**：`overlay.outlines` 只存在于这张图，不写文档、不进撤销；用于 Agent 说「我看的是这里」。
8. **区域叠加（P2）**：`overlay.regions` 画半透明填充与名字；区域是语义标注，不改变通行性，也不写进导出 PNG。
9. **输出路径**：固定落在 `preview/agent/` 下，文件名含 `revision` 与短选项哈希，避免同 revision 不同叠加互相覆盖；每次保留最近 20 张，旧的按 mtime 清理。`preview` 已在资源白名单里，子目录不需要新增 scope。
10. **本机路径**：`localPath` 必须是绝对路径，Agent 用它调 `read_image`；`url` 是给用户点的。
11. **陈旧检测**：渲染开始与结束各取一次 `revision`；不一致时 `stale:true`，Agent 应该重新 `inspect` 再决定，不要拿这张图当最终验收。
12. `isoRender` 的 `crop` 要包含物件向上 / 左右的溢出；`region` 是地格范围，物件可能画出边界，需按 `planPadding` 留余量。
13. `runMapPreview` / `runIsoPreview` 继续存在，作为「全图验收图」；返回值补 `revision`、`previewPath`（本机绝对路径），内部也改为复用同一套渲染入口。

**Agent 用法示例**

```text
1. mapRender({projectId, region:{r0:0,c0:0,r1:15,c1:15}, overlay:{markers:"labels",grid:true}})
2. 把返回的 localPath 交给 read_image
3. 看到不对 → mapInspect 找具体格子 → applyMapOps 改 → 再 mapRender
```

### 6.3 素材：路径导入、选项透传、总览图

#### 6.3.1 `importMapTileset` / `importIsoTileset` 增加 `path`

```jsonc
{
  "projectId": "m…",
  "path": "/Users/me/art/grass.png", // 与 data 二选一；path 优先
  "name": "草地",
  "cell": { "width": 32, "height": 32 },
  "shape": "plain",
  "kind": "ground",
  "animRows": true,
  "fps": 6,
  "clarity": "smooth",
  "scale": 1,
  "footprint": { "cols": 2, "rows": 2 },
  "objectScale": 1,
  "pass": [1, 1, 1, 1]
}
```

- `path` 由宿主读盘、按现有 `sniffImage` 校验；文件大小上限与 `upload` 一致。
- `data` 保留，兼容现有调用；两者都给时 `path` 优先并给一条 warning。
- 返回的 `tileset` 增加 `localPath`、`url`、`palette`（已有）与 `rev`。
- `iso` 的 `kind` 必给；`map` 的 `shape` / `cell` 留空仍走自动识别。
- **不改变**「属性一次定死」：这里传的是新增时的属性；后续改属性仍走 `save*Tileset` 的受限字段。

#### 6.3.2 `upload` 增加 `options`

`upload` 已经是 Agent 最顺手的入口（宿主读盘，不贴 base64）。给 `module=map|iso` 的 `tileset` 增加：

```jsonc
{
  "module": "iso",
  "id": "g…",
  "kind": "tileset",
  "path": "/Users/me/art/house.png",
  "options": {
    "kind": "object",
    "footprint": { "cols": 2, "rows": 2 },
    "objectScale": 1.2,
    "pass": [0, 1]
  }
}
```

- `map` 的 `options` 透传 `cell` / `shape` / `animRows` / `fps` / `clarity` / `scale` / `stamp` / `stampKey` / `loop`。
- `iso` 的 `options` 透传 `kind` / `sourceCell` / `animRows` / `frames` / `fps` / `loop` / `clarity` / `footprint` / `anchor` / `objectScale` / `pass` / `keyGreen`。
- 没有 `options` 时行为不变（`map` 自动识别，`iso` 按 `ground`）。
- `upload` 的 wire schema 加 `options: z.record(z.string(), z.unknown()).optional()`；不写进 schema 会被 typert 静默丢掉。

#### 6.3.3 `composeMapAsset` / `composeIsoAsset` 返回本机路径

返回体增加：

```jsonc
{
  "file": "ai/grass.png",
  "localPath": "/…/map-jobs/m…/ai/grass.png",
  "previewPath": "/…/map-jobs/m…/preview/agent/ai-grass.png",
  "sourceFiles": ["/…/img-00.png", "…"]
}
```

- `previewPath` 是整理后的素材缩略图 / 总览图，Agent 可以先 `read_image` 再决定是否贴回链。
- 仍然**只整理、不导入**；`openUrl` 仍然带 `dialog=add&asset=…&shape=…&frames=…&scale=…`。
- 如果用户明确授权「生成完直接加进去」，P2 可加 `import: {confirm:true, name, …}` 或 `autoImport:true`，由宿主在返回体里给出 `tilesetId`；默认不开，避免替用户拍板。

#### 6.3.4 素材总览图（P2，可选）

`mapTilesetSheet` / `isoTilesetSheet`：

```jsonc
{
  "projectId": "m…",
  "tilesetId": "ts…",
  "scale": 2,
  "labels": true
}
```

返回一张带格线、图块编号、调色板序号的 PNG，`localPath` + `url`。Agent 选笔刷、检查切片、确认 A2 形状时不再只靠 `rect` 数字。

### 6.4 排布原语：扩展 `applyMapOps` / `applyIsoOps`

所有新 op 都遵守现有约束：

- 校验**不抛**，写进 `skipped`（中文原文）。
- 脏块 / `dropKeys` / 撤销 / `stroke` 由宿主维护。
- 不跨环绕接缝的规则不变（物件占格必须完整落地；地面 / 标记 / 自动连接邻域取模）。
- 新 op 必须先在 `mapdoc` / `isodoc` 里定义，并补 `undo` / `redo`；不能只在前端展开。

#### 6.4.1 图形原语

```jsonc
{ "kind": "line",     "layerId": "l0", "r0": 2, "c0": 2, "r1": 12, "c1": 18, "tile": 33, "thickness": 1 }
{ "kind": "polyline", "layerId": "l0", "points": [[2,2],[8,8],[8,20]], "tile": 33, "thickness": 2, "closed": false }
{ "kind": "ellipse",  "layerId": "l0", "r0": 4, "c0": 4, "r1": 12, "c1": 16, "tile": 12, "filled": true }
{ "kind": "polygon",  "layerId": "l0", "points": [[2,2],[10,2],[6,9]], "tile": 12, "filled": true }
{ "kind": "duplicate","layerId": "l0", "r0": 2, "c0": 2, "r1": 6, "c1": 6, "dr": 10, "dc": 0 }
```

- `line` / `polyline` 用宿主自己的栅格化；45° 与正方格都按 **cell 坐标**，不是像素。
- `thickness` 以格为单位，1 = 单格；圆形 / 多边形不做抗锯齿，只决定哪些格被写入。
- `duplicate` 只复制同一层内的语义序号；目标区域先清空还是覆盖，由 `mode: "overwrite" | "skipFilled"` 决定（默认 `skipFilled`，避免误盖）。
- `rect` / `fill` / `replace` 保留；不修改它们的语义。

#### 6.4.2 整图与物件

`map`：

```jsonc
{ "kind": "stampMove",     "id": "s1", "r": 10, "c": 4 }
{ "kind": "stampRotate",   "id": "s1", "rot": 90 }
{ "kind": "stampDuplicate","id": "s1", "r": 20, "c": 8, "rot": 0, "newId": "s2" }
```

- 占格永远由宿主从素材规格读，op 不许带 `cols` / `rows`。
- 移动 / 旋转要重算占格与通行性，脏块覆盖旧位置与新位置。
- 删除整图仍然只能走 `stampRemove`（或橡皮碰到一格整张摘掉），不要新增「删一格」的歧义 op。

`iso`：

```jsonc
{ "kind": "object", "op": "duplicate", "id": "o1", "r": 12, "c": 8, "newId": "o2" }
```

- 复制沿用原 `tilesetId` / `layerId`；占格 / 遮挡规则不变。
- 不支持运行期旋转（45° 物件没有旋转维度）。

#### 6.4.3 标记更新

```jsonc
{ "kind": "marker", "op": "update", "id": "m1", "patch": { "kind": "boss", "color": "#ff3b30", "note": "第二阶段" } }
{ "kind": "marker", "op": "add", "r": 3, "c": 4, "name": "宝箱", "kind": "chest" }
{ "kind": "marker", "op": "rename", "id": "m1", "name": "出口" }
```

- `update` 只改给定字段；`rename` 保留兼容。
- 改名 / 改备注不脏格子，但仍要记一步撤销（现有 `touched` 机制）。
- 一格一个标记的约束不变；重复放置仍进 `skipped`，文案说清是第几个。

#### 6.4.4 事务选项

`applyMapOps` / `applyIsoOps` 增加：

```jsonc
{
  "dryRun": true,        // 只校验、算脏块，不写盘、不进撤销
  "ifRevision": "a1b2c3d4e5f6" // 不一致直接拒绝，返回当前 revision
}
```

返回增加：

```jsonc
{
  "revision": "…",
  "dryRun": false,
  "stale": false,
  "summary": {
    "cells": 42,
    "markers": 2,
    "objects": 1,
    "stamps": 1
  }
}
```

- `dryRun` 必须走同一套 `applyOps`，只是不 `pushHistory` / 不 `scheduleDocWrite`；这样预览结果与真正提交逐字段一致。
- `ifRevision` 只用于写入；`inspect` / `render` 只返回 revision，不拒绝。
- 一次提交的 cell / op 数设上限（建议 20,000 cells / 2,000 ops），超限明确报错并建议分片；不要静默丢。

#### 6.4.5 可选：蓝图模式（P3，不阻塞主链路）

如果实际使用中发现 Agent 生成的 `ops` 太大或重复，可增加：

```jsonc
{
  "projectId": "m…",
  "blueprint": {
    "seed": 7,
    "base": { "layerId": "l0", "tile": 33, "region": { "r0": 0, "c0": 0, "r1": 31, "c1": 31 } },
    "areas": [
      { "shape": "ellipse", "r0": 4, "c0": 4, "r1": 12, "c1": 16, "tile": 12 }
    ],
    "paths": [
      { "points": [[2,2],[8,8],[8,20]], "tile": 40, "thickness": 2 }
    ],
    "objects": [
      { "tilesetId": "ts…", "r": 10, "c": 10 }
    ],
    "markers": [
      { "r": 3, "c": 4, "name": "出生点", "kind": "spawn" }
    ]
  }
}
```

蓝图只是**把声明式意图展开成现有 op**，不引入新的几何口径；展开结果可以被 `dryRun` 预览、被 diff 对比。首版不做，等 P1 / P2 的真实使用数据决定。

### 6.5 标记与区域

#### 6.5.1 标记字段（P1）

```ts
interface Marker {
  id: string;
  r: number;
  c: number;
  name: string;
  kind?: string;   // spawn / exit / chest / boss / event / resource / npc / custom…
  color?: string;  // #rrggbb；不填按 kind 取默认色
  note?: string;
  tags?: string[];
}
```

- `kind` 用**开放字符串 + 推荐值**，不用封闭枚举：新类型不需要改协议；界面按推荐值显示颜色 / 图标，未知值用默认色。
- 颜色只影响界面与效果图，不进导出 PNG；导出 JSON 带上字段。
- 兼容旧文档：没有新字段的标记按 `kind:"custom"` / 空备注读取；`saveMapDoc` / `applyOps` 不自动补写，除非用户真的改了它。
- `normalizeMapDoc` / `normalizeIsoDoc` 必须保留新字段；`buildOwnJson` / `buildIsoJson` 必须写出；`get*Project` / `status` / `review` 必须返回。

#### 6.5.2 区域（P2）

标记是点，区域是面。建议单独的源数据，不塞进标记：

```ts
interface Region {
  id: string;
  name: string;
  kind: string;      // spawn-zone / no-build / boss-arena / quest-area / custom…
  color?: string;
  shape: "rect" | "polygon" | "cells";
  cells?: Array<{ r: number; c: number }>; // shape=cells
  rect?: { r0: number; c0: number; r1: number; c1: number };
  points?: Array<[number, number]>;        // shape=polygon
  note?: string;
}
```

- op：`region add` / `region update` / `region remove`；走同一个 `apply*Ops`，有撤销。
- 渲染：`mapRender` / `isoRender` 的 `overlay.regions` 用半透明填充 + 名字；不写进导出 PNG。
- 导出：`map.json` / `iso map.json` 增加 `regions`；格式升版（见 §6.5.3）。
- 约束：一格可以被多个区域覆盖（区域不是格子数据），但标记仍然一格一个。
- 与通行性的关系：区域是**语义标注**，不自动改 `pass[]`；如果用户要「禁建区」，导出里保留 `kind:"no-build"`，由引擎决定。

#### 6.5.3 导出格式

| 模块 | 当前 | 计划 | 说明 |
|---|---|---|---|
| `map` | `dsh-gem-map@4` | `dsh-gem-map@5` | `markers[]` 增加 `kind/color/note/tags`；新增 `regions[]`（没有区域时可省略或空数组） |
| `iso` | `dsh-gem-iso-map@1` | `dsh-gem-iso-map@2` | `markers[]` 增加同字段；新增 `regions[]`；其余不变 |

- 只在新字段真的写入时升版；旧文档读取不受影响。
- 升版后同步更新设计文档、ENGINEERING、自检里逐字段断言、README 的导出说明。
- `manifest.json` 增加 `revision`；`map.json` 可选增加 `revision`（便于交付追溯，但不要把它当源数据）。

### 6.6 版本、检查点与差异

#### 6.6.1 `revision`

- 由宿主计算：`sha1(canonical(doc) + canonical(tilesets 元数据) + 素材文件 mtime)` 取前 12 位。
- 所有改变文档 / 素材元数据的写入返回 `revision`；`inspect` / `render` / `status` / `review` 也返回。
- 不落盘；同一状态稳定。导出清单与检查点记录它。
- 异步任务（预览 / 导出）返回 `revisionAtStart`；完成后 `wait` 返回最终 `revision`。

#### 6.6.2 检查点（P2）

```jsonc
{ "projectId": "m…", "name": "方案 A：湖心岛", "note": "试一版水岸" }
```

方法：

- `saveMapCheckpoint` / `listMapCheckpoints` / `restoreMapCheckpoint` / `deleteMapCheckpoint`
- `saveIsoCheckpoint` / `listIsoCheckpoints` / `restoreIsoCheckpoint` / `deleteIsoCheckpoint`

契约：

- 检查点只存**文档源数据**（`map.json` / `iso map.json` 同形），不存图片、不存渲染缓存；恢复后素材变了就按当前素材渲染。
- 恢复是**一次可撤销的整文档替换**：`pushHistory` 记录 before / after，`restore` 后 `canUndo=true`；不要清空历史。
- ⚠️ **整文档恢复必须恢复 `stamps`**：当前 `mapgen.restoreDoc` 只恢复了 `name/cols/rows/layers/data/markers`，没有 `stamps`；检查点恢复若直接复用它，会「恢复后整图全部消失」，而且不报错。实现检查点前先把这一步补上，并加一条「恢复后整图仍在」的自检。
- 每项目最多 20 个，按创建时间淘汰；删除项目时一并删除。
- 返回 `id` / `revision` / `createdAt` / `sizeBytes`；超过上限明确报错。

#### 6.6.3 差异（P2）

```jsonc
{
  "projectId": "m…",
  "from": { "checkpointId": "c1" }, // 或 { "revision": "…" }（若仍可重算）
  "to": "current",
  "maxCells": 4096
}
```

返回按层分组的 `added` / `removed` / `changed` 格子数、样例坐标、标记 / 物件 / 整图变化。用于 Agent 自检「我只改了预期的那一片」；超过预算只给统计与建议区域。

### 6.7 验收包与工具手册

#### 6.7.1 `status` / `review`

`map` / `iso` 快照增加：

- `revision`
- `previewPaths`（本机绝对路径数组，与 `previewUrls` 一一对应）
- `markers`（`n` / `name` / `kind` / `color` / `r` / `c`）
- `objects` / `stamps`（iso 的 `objectList` 已存在，补 `footprint` / `pass`）
- `stats`（填充率、图块直方图、标记分类计数）
- `nextActions` 增加 `inspect` / `render` 的建议

`review` 包不要塞整张网格（会太大），只给统计、标记、物件、预览路径与 revision；Agent 需要细节时再 `inspect`。

#### 6.7.2 工具手册

新增共享主题 `map-agent`（或 `map-workflow`），并在 `map` / `iso` 主题末尾指向它：

```text
# 地图编辑器 Agent 工作流

1. 先 getMapProject / getIsoProject 看项目与素材；不要用 mapPlan 读状态。
2. 用 mapInspect / isoInspect 看区域（默认 64×64，超过要缩 region）。
3. 用 applyMapOps / applyIsoOps 画；先用 dryRun 验证，再正式提交。
4. 用 mapRender / isoRender 出检查图；把 localPath 交给 read_image。
5. 用 revision 防止旧状态覆盖；改坏了用 undo 或 checkpoint。
6. 验收用 runMapPreview + review；导出用 runMapExport / runIsoExport，再 wait。
7. 不要用 shell 改 map.json / project.json；不要自己算像素坐标 / 变体 / 自动连接。
```

手册还要写清：

- `tile` 用 `palette[].index`（1-based，0 = 空）；`mapPlan` 的 `legend` 是渲染用，不是调色板。
- 45° 的 `cell` 是 `width × height`，菱形宽 = `cell.width`、高 = `cell.width / 2`；物件占格用 `footprint`。
- 地图四周环绕；区域 / 坐标越界时宿主取模，物件占格必须完整落地。
- 标记只用于语义与导出，导出 PNG 不画；要看标记用 `render.overlay.markers`。
- `read_image` 是宿主侧的看图工具，不是 `game_material` 的方法；`render` 返回 `localPath` 后直接交给它。
- AI 素材仍然走图片 / 序列帧 → `compose*` → 用户确认；`compose*` 不自动导入。

`verify-tools.mjs` 需要覆盖：

- 新方法全部出现在 `methods` 目录且归到正确模块。
- `map-agent` 主题可读，包含关键方法名。
- 常驻工具面仍然 ≤6,000 B。
- 隐藏模块时新方法同样不可用。

## 七、Agent 工作流示例

### 7.1 俯视地图：从空图到可验收

```text
用户：做一张 32×32 的海岛，中间有湖，四周沙滩，标出出生点和宝箱。

1. createMapProject({name:"海岛", grid:{tileWidth:32,tileHeight:32}, cols:32, rows:32})
2. importSampleTileset({projectId})
3. mapInspect({projectId, include:["stats","legend"]})
   → 看 palette：草地 / 水 / 沙 / 道具的 index
4. applyMapOps({projectId, dryRun:true, ops:[
     {kind:"fill", layerId:"l0", r:0,c:0, tile: 草地},
     {kind:"ellipse", layerId:"l0", r0:8,c0:8,r1:23,c1:23, tile: 水, filled:true},
     {kind:"ellipse", layerId:"l0", r0:9,c0:9,r1:22,c1:22, tile: 沙, filled:false, thickness:2}
   ]})
   → 看 skipped / summary；没问题再去掉 dryRun
5. applyMapOps({projectId, ops:[…同上…], stroke:"island"})
6. applyMapOps({projectId, ops:[
     {kind:"marker", op:"add", r:16,c:16, name:"出生点", kind:"spawn"},
     {kind:"marker", op:"add", r:10,c:20, name:"宝箱", kind:"chest"}
   ]})
7. mapRender({projectId, region:{r0:0,c0:0,r1:31,c1:31}, overlay:{markers:"labels",grid:true}})
   → read_image(localPath)
8. mapInspect({projectId, region:{r0:8,c0:8,r1:23,c1:23}})
   → 核对湖 / 沙 / 标记
9. runMapPreview({projectId}) → wait({id}) → review({module:"map", id})
10. runMapExport({projectId, formats:{png:true,json:true}}) → wait
11. 贴 review.openUrl 给用户
```

### 7.2 45° 地图：摆一组物件

```text
1. isoInspect({projectId, include:["layers","objects","stats","legend"]})
   → 看 cell / footprint / objectList / palette
2. applyIsoOps({projectId, dryRun:true, ops:[
     {kind:"paint", layerId:"l0", cells:[…草地…]},
     {kind:"object", op:"add", layerId:"l2", tilesetId:"ts_house", r:10, c:10},
     {kind:"object", op:"add", layerId:"l1", tilesetId:"ts_tree", r:8, c:9}
   ]})
3. applyIsoOps({projectId, ops:[…], stroke:"village"})
4. isoRender({projectId, region:{r0:6,c0:6,r1:16,c1:16}, scale:2, overlay:{markers:true,grid:true}})
   → read_image(localPath) 检查遮挡 / 占格 / 物件是否悬空
5. 需要复制树：{kind:"object", op:"duplicate", id:"o2", r:9,c:9}
6. runIsoPreview / runIsoExport / review
```

### 7.3 AI 素材：生成 → 整理 → 先看再确认

```text
1. createImageJob / runImageJob（图片模块，★计费）→ wait
2. composeMapAsset({projectId, name:"水", files:[绝对路径…], shape:"a2quad"})
   → 返回 localPath / previewPath / notes / scale
3. read_image(previewPath)，看接缝与颜色
4. 把 openUrl 贴给用户；用户点「新增素材」确认（默认）
5. 如果用户提前授权「直接加」：
   composeMapAsset({…, import:{confirm:true, name:"水", shape:"a2quad"}})
   → 返回 tilesetId；再 mapInspect 确认 palette 多了一条
```

## 八、实施分期

### Phase 0 · 读模型与效果图（先让 Agent 看得见）

**目标**：不改变任何写入语义，先补齐「看得见、看得准」。

- `revision` 计算与所有读接口返回。
- `mapInspect` / `isoInspect`（区域、文本网格、统计、预算）。
- `mapRender` / `isoRender`（同步、region、scale、markers/grid/pass 叠加、localPath、清理）。
- `runMapPreview` / `runIsoPreview` 返回 `previewPath` / `revision`；`review` 包补 `previewPaths` / `revision` / markers / objects。
- 工具手册新增 `map-agent` 主题；`METHOD_MODULE` / `TOOL_METHODS` 补新方法。
- 新增 `verify-map-agent.mjs` / `verify-iso-agent.mjs`（或并入现有 pipeline 脚本），先钉读模型与渲染。

**退出标准**：Agent 能在不改一格的情况下，准确读出 32×32 地图的三层内容，并生成一张带标记 / 网格、与导出同源的本机 PNG；旧自检全绿。

### Phase 1 · 写入表达力与标记语义

**目标**：Agent 能「说意图」，而不是逐格算。

- `line` / `polyline` / `ellipse` / `polygon` / `duplicate`；`dryRun` / `ifRevision` / `summary`。
- `map` 的 `stampMove` / `stampRotate` / `stampDuplicate`；`iso` 的 `object duplicate`。
- 标记 `kind` / `color` / `note` / `tags` + `marker update`；`inspect` / `render` / `review` / 导出全链路。
- `import*` 的 `path` 与 `upload.options`；`compose*` 返回 `localPath` / `previewPath`。
- 界面：标记列表显示类型 / 颜色，支持按类型筛选；不新增术语（沿用模块六文案规则）。

**退出标准**：一条斜路、一个圆形湖、一次整图移动、一次物件复制都能一步完成；标记类型在界面、效果图、导出 JSON 三处一致；旧项目打开不丢标记。

### Phase 2 · 版本、检查点、区域

**目标**：支持「试几版、对比、回退」。

- `save*Checkpoint` / `list*Checkpoints` / `restore*Checkpoint` / `delete*Checkpoint`。
- `mapDiff` / `isoDiff`（检查点 / 当前版本对比，带预算）。
- 区域数据与 `region` op、渲染叠加、导出；格式升版到 `dsh-gem-map@5` / `dsh-gem-iso-map@2`。
- 素材总览图（`*TilesetSheet`）与可选的 job-id 素材交接。
- README / 设计文档 / ENGINEERING 同步。

**退出标准**：Agent 能保存「方案 A」、改一版、对比差异、恢复；区域在界面上可选中 / 删除；导出 JSON 通过新格式逐字段断言。

### Phase 3 · 打磨与评估

- 可选的蓝图模式（如果 P1/P2 的 ops 仍然太大）。
- 预览图 / 检查点的清理策略、性能基准、异常路径。
- Agent 评测集：海岛、村庄、迷宫、45° 村落、AI 水岸素材、标记与区域、超大图预算。
- 端到端 e2e：不联网、不花钱，故意留产物供人眼验收（参照 `e2e-map.mjs`）。

**退出标准**：评测集全部通过；Agent 完成一张 32×32 地图的平均工具调用数、平均 token 数、失败重试次数有基线；无静默截断 / 无坐标漂移。

## 九、验收标准

| # | 判据 | 阈值 | 谁盯 |
|---|---|---|---|
| A1 | `inspect` 的逐格内容与宿主文档完全一致（含空、越界、环绕） | 100% | 新 `verify-*-agent` |
| A2 | `inspect` 区域边界：请求范围 / 返回 range / 越界夹取 / `truncated` 不丢格 | 逐项 | 新 `verify-*-agent` |
| A3 | `render` 的 crop 与全图渲染同一区域逐像素一致 | 逐字节 | 新 `verify-*-agent` |
| A4 | `render` 的标记圆心 / 半径 / 字号等于计划中的值（不是重推） | 逐项 | 新 `verify-*-agent` |
| A5 | `render` 带 / 不带标记只在标记像素处不同 | 逐像素 | 新 `verify-*-agent` |
| A6 | `line` / `ellipse` / `polygon` 的格子集合与独立参考实现一致；`dryRun` 不写盘 | 逐格 | `verify-map-pipeline` / `verify-iso-pipeline` |
| A7 | 新 op 的撤销 / 重做回到逐项相同的计划；`stroke` 仍并成一步 | 完全一致 | `verify-map-pipeline` / `verify-iso-pipeline` |
| A8 | 标记字段在 `inspect → render → map.json → review` 四处一致；旧文档缺字段可读 | 逐项 | 新 `verify-*-agent` + pipeline |
| A9 | 路径导入与 base64 导入逐字节一致；`upload.options` 不被 schema 吞 | 逐字节 | `verify-map-gateway` / `verify-iso-gateway` |
| A10 | `ifRevision` 过期拒绝；`revision` 在写入 / 撤销 / 检查点后正确变化 | 逐项 | 新 `verify-*-agent` |
| A11 | 检查点恢复是一次可撤销操作；恢复后文档逐字段一致 | 逐项 | 新 `verify-*-agent` |
| A12 | `maxCells` / `maxPixels` 超限明确报错或 `truncated`，绝不静默丢内容 | 逐项 | 新 `verify-*-agent` |
| A13 | 导出格式升版后逐字段校验；旧格式读取不回归 | 逐项 | `verify-map-pipeline` / `verify-iso-pipeline` |
| A14 | 工具手册覆盖所有新方法；常驻工具面 ≤6,000 B；隐藏模块拒绝 | 逐项 | `verify-tools` |
| A15 | 现有全部自检（host / client / tools / map* / iso*）保持全绿 | 全绿 | CI |

## 十、风险与对策

| 风险 | 表现 | 对策 |
|---|---|---|
| **第二套渲染器** | Agent 图与导出图有 1px 位移 / 颜色差 | 只允许复用 `buildPlan` / `buildIsoPlan`；crop 只做后处理；A3 逐像素断言 |
| **inspect 撑爆上下文** | 512×512 地图一次返回几十万字符 | 默认 64×64 预算；超限要求 region；`format:"text"` 不返回数组；`maxItems` 限制列表 |
| **render 内存 / CPU** | 512×512×4 倍 = 4M 像素；多层 / 大图更糟 | `maxPixels` 默认 16M；超限报错并建议 region / scale；同步渲染加超时预算 |
| **标记格式升级破坏下游** | 旧引擎读到新字段 / 新格式无法解析 | 字段可选；格式只升一次；旧文档不自动改写；发布说明写清 |
| **区域与通行性混淆** | Agent 以为画了 `no-build` 就不能走 | 文档与手册明确：区域是语义标注，不改 `pass[]`；要改通行性走整图 `stampPass` / 物件 `pass` |
| **路径导入越权** | Agent 传任意系统路径 | 只允许项目 / 任务目录与显式用户路径；复用 `sniffImage` / 大小上限；拒绝目录、软链接逃逸（按现有 upload 规则） |
| **自动导入绕过确认** | AI 素材没经用户确认就进列表 | 默认仍回 `openUrl`；只有显式 `confirm:true` + 用户授权才自动导入，并在结果里标 `imported:true` |
| **旧客户端 / 旧缓存** | 新字段没进 wire schema，界面看不到 | 所有新字段逐键写进 `wire.ts`；`verify-*-gateway` 断言不丢键；`rev` 继续用于图片缓存 |
| **Agent 写入并发** | 用户同时编辑，Agent 用旧 revision 覆盖 | `ifRevision` 可选；写入返回新 revision；`stale` 提示重新读取 |
| **检查点膨胀** | 每版都存整份文档 | 最多 20 个；只存源数据；按需删除；不做自动每笔检查点 |
| **两套编辑器 API 漂移** | map 有、iso 没有，Agent 要记两套 | 共享 `inspect` / `render` / `checkpoint` 协议；差异字段用可选；同一套自检模板 |

## 十一、待决策

1. **标记 `kind` 用开放字符串还是枚举？** 建议开放字符串 + 推荐值；界面未知值用默认色。枚举会让「新类型」变成协议改动。
2. **区域是否进首版？** 建议 P2；标记点先覆盖「特殊位置」的主要需求，区域是增强。
3. **`mapRender` 同步还是异步？** 建议同步，`maxPixels` 保底；异步会让 Agent 多一次 `wait`，但大图可退回异步（P3 再考虑）。
4. **AI 素材是否允许自动导入？** 建议默认关闭，只有用户明确授权时开 `confirm:true`；产品规则「属性在新增时定死」不被绕过。
5. **检查点保留多少？** 建议 20 个 / 项目，按创建时间淘汰；不做自动版本。
6. **蓝图模式是否要做？** 先看 P1/P2 的 ops 体积；如果 Agent 仍在拼巨大的 `cells` 数组，再做声明式展开。
7. **`map.json` 是否写 `revision`？** 建议只写进 `manifest.json`；`map.json` 是游戏侧源数据，少塞派生字段。
8. **导出 PNG 是否提供「带标记」版本？** 建议不提供，避免把检查用的圆圈烧进游戏图；需要时用 `mapRender`。

## 十二、涉及文件

| 文件 | 改动 |
|---|---|
| `src/wire.ts` | 新方法 schema；`apply*Ops` 的 `dryRun` / `ifRevision`；`upload.options`；所有新字段逐键声明 |
| `src/index.ts` | 新方法 handler；`get*Project` / `status` / `review` 返回 revision / previewPath |
| `src/tools.ts` | `METHOD_MODULE`、`TOOL_METHODS`、intake / review / status 文案；新手册主题接线 |
| `src/toolguides.ts` | `map-agent` 主题；`map` / `iso` 主题补工作流 |
| `src/mapgen.ts` / `src/isogen.ts` | `inspect` / `render` / `revision` / checkpoint / diff；路径导入；compose 返回值 |
| `src/maprender.ts` / `src/isorender.ts` | 区域渲染、标记 / 网格 / 通行性叠加；crop；不复制几何 |
| `src/mapdoc.ts` / `src/isodoc.ts` | 新 op、标记字段、区域、归一化、撤销 / 重做 |
| `src/mapexport.ts` / `src/isoexport.ts` | 新字段导出、格式升版、manifest revision |
| `src/client.ts` | 标记类型 / 颜色 / 筛选；区域列表与叠加（P2）；不新增几何计算 |
| `scripts/verify-map*.mjs` / `verify-iso*.mjs` | 新断言；gateway schema；pipeline 导出字段 |
| `scripts/verify-tools.mjs` | 方法覆盖、手册覆盖、工具面预算 |
| `docs/*` / `README*` | 设计文档、工程文档、导出格式、Agent 工作流 |

## 十三、结论

这不是「给地图编辑器加几个 AI 按钮」，而是把 Agent 接进编辑器已有的**计划 / 源数据 / 撤销 / 导出**体系：

- **读**：`inspect` 让 Agent 看见语义，不依赖 chunk 计划。
- **写**：图形原语 + `dryRun` + `revision` 让 Agent 能安全地表达布局。
- **看**：`render` 用同一份计划出局部效果图，返回本机路径，Agent 真的能看。
- **标**：标记类型 + 区域让「特殊位置」有意义，并且能导出给引擎。
- **回**：检查点 + diff 让多轮迭代不失控。

按 Phase 0 → 1 → 2 推进，每阶段都能独立交付、独立验收；Phase 0 不改变任何写入语义，风险最低，建议先做。
