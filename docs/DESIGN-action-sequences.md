# 动作序列（Action Sequences）设计与实施方案

> 目标读者：改这个插件的编码 agent。
> 对应需求：「阶段② 从『行走视频』泛化成『动作视频』；行走作为内置动作绑定提示词、界面用 select；
> 用户可以自己加动作 + 提示词；攻击这类强节奏动作要求八个方向的动作一致」。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 8 个方向各自独立生一段攻击视频，能对齐吗？ | **不能**。时序（蓄力/打击/后摇）与招式语义在 8 次独立采样里完全解耦，打击帧对不齐，招式还可能变成 8 种。 |
| 那怎么办？ | **先动后转**：只生成 1 段「母本动作视频」→ 抽 N 张关键帧 → **每个关键帧单独跑一次转圈**（复用现有转圈流水线）→ 得到 8 方向 × N 帧的矩阵。全方向共享同一套关键帧，节奏天然锁死。 |
| 成本 | 走路：1 转圈 + 8 方向视频 = 9 次；攻击（关键帧法）：1 母本 + N 关键帧转圈，N=5 时 = **6 次**，比 8 次还便宜，且一致。 |
| 现有代码能复用多少？ | 抠像 / 合成整图 / 抽帧 / 打包导出 **一行不用改**（详见 §4.3 的关键发现）。 |

---

## 1. 现有流水线（改造基线）

```
① 八方向绿幕图   转圈截帧：源图 → trackTurn (turn.mp4) → 32 候选帧 → 8 个方向图 images/<dir>.png
                 （备选：逐方向生图）
② 八方向动作视频  images/<dir>.png 作首帧 → 各提交 1 次图生视频 → videos/<dir>.mp4
③ 抽帧          videos/<dir>.mp4 → settings.frameCount 帧 → frames/<dir>/f00..f07.png + raw.bin
④ 抠像合成      keyed/<dir>/*.png → composeSheet(行=方向, 列=帧) → out/sheet.png
```

关键代码位置（上游 v0.11.0）：

| 关注点 | 位置 |
|---|---|
| 八方向定义 / 默认提示词 | `src/directions.ts`（`DIRECTIONS`、`DEFAULT_TURN_PROMPT`、`DEFAULT_VIDEO_PROMPT`、`localizePrompts`） |
| 项目数据结构 | `src/store.ts:271`（`Project`）、`:240`（`ProjectSettings`） |
| 转圈视频 | `src/pipeline.ts:384`（`startTurnVideo`）、`:513`（`startTurnFrames`）、`:649`（`applyTurnPicks`） |
| 八方向视频 | `src/pipeline.ts:993`（`startVideos`）、`:1097`（`pollVideosOnce`）、`:1752`（`clearVideos`） |
| 抽帧 | `src/pipeline.ts:1486`（`startExtract`）→ `extractFrames` |
| 抠像合成 | `src/pipeline.ts:1592`（`renderSheet`）→ `src/chroma.ts:585`（`composeSheet`） |
| 远程方法表 | `src/tools.ts:71`（`METHOD_MODULE`）、`src/wire.ts:1200+`（每个方法的 zod schema） |
| UI | `src/client.ts`（单文件，约 1.2MB；阶段②在 `StageVideos` 系列组件里） |

---

## 2. 需求拆解

1. **动作（Action）= 名字 + 提示词 + 类型**，内置 `走路`，界面用下拉选择。
2. **自定义动作**：用户可新增 `{名称, 提示词, 类型(循环/一次性)}`，跨项目复用。
3. **同一角色要有多套动作的产物**：走路一套、攻击一套，互不覆盖。
4. **攻击类动作走「关键帧转圈」流水线**；走路/待机仍走「8 方向独立视频」（它便宜且已够好）。
5. 不引入 3D、不引入外部动作捕捉数据、不缩减到 5 方向（独眼等不对称特征必须保留全部 8 向）。

---

## 3. 数据模型

### 3.1 动作定义（`src/directions.ts` 新增）

```ts
export type ActionKind = "loop" | "oneshot";     // 循环（走路/待机）/ 一次性（攻击/受击/死亡）
export type ActionPipeline = "perDirection" | "keyframe";

export interface ActionDef {
  id: string;              // "walk"、"idle"、"attack-slash"、自定义 "a<uuid>"
  label: string;           // 中文名
  labelEn: string;
  prompt: string;          // 该动作的视频提示词（中文）
  promptEn: string;
  kind: ActionKind;
  /** 推荐流水线；UI 可覆盖 */
  pipeline: ActionPipeline;
  /** 一次性动作建议生成的关键帧数（矩阵列数） */
  keyframeCount: number;
  builtin: boolean;
}
export const BUILTIN_ACTIONS: ActionDef[] = [
  walk, idle, attackMelee, attackStab, hurt, die, cast, ...
];
```

内置提示词要求（沿用现有 `DEFAULT_VIDEO_PROMPT` 的写法，中英各一份）：

- **走路 walk**：就是现在的 `DEFAULT_VIDEO_PROMPT`（保持原文，别改，`verify-host` 5b 比对着）。
- **待机 idle**：呼吸起伏 + 轻微左右重心移动，不位移、不转身。
- **挥砍 attack-slash**：蓄力 → 横向挥出 → 收招；节奏 0.6~0.9 秒；打击帧在第 40% 左右。
- **突刺 attack-stab**：后坐蓄力 → 前突刺出 → 回位。
- **受击 hurt**：向后一顿 + 轻微后仰 + 恢复。
- **倒地 die**：失衡 → 倒地 → 定格（一次性、不循环）。
- **施法 cast**：抬手蓄力 → 推出 → 收回。

每条都必须带「朝向锁定」段（这是实测踩出来的，见 §7 坑位 1）。

### 3.2 项目结构改动（`src/store.ts`）

现在 `videos / frames / sheet` 是项目级单份。改成**按动作分桶**：

```ts
export type MotionMode = "perDirection" | "keyframe";

export interface MotionState {
  mode: MotionMode;
  /** perDirection 模式：八个方向各一段视频 */
  videos: Record<string, VideoNode>;
  /** keyframe 模式：母本动作视频 */
  seed?: SeedActionState;
  frames: Record<string, FramesNode>;
  sheet: SheetState;
}

export interface SeedActionState {
  video: VideoNode;                       // 母本动作视频（一次性，取一段）
  baseDirection: string;                  // 用哪个方向图当首帧生成母本（默认 front）
  /** 从母本视频抽出的候选帧（时间是均匀的，用户可以拖动挑选） */
  candidates: { file: string; at: number }[];
  /** 被选中作为关键帧的候选下标（长度 = 矩阵列数） */
  keyframes: number[];
  /** 每个关键帧一条转圈状态：key = "k0"…"kN" */
  turns: Record<string, TurnState>;
}

export interface Project {
  // …原有字段保留…
  /** 动作库（内置 + 自定义），项目级拷贝，便于单项目微调 */
  actions: ActionDef[];
  /** 当前选中的动作 id */
  activeActionId: string;
  /** 每个动作各自的产物 */
  motions: Record<string, MotionState>;
  /** 兼容旧项目：下面三个字段只作为「迁移源」，读盘时合并进 motions.walk */
  videos?: Record<string, VideoNode>;
  frames?: Record<string, FramesNode>;
  sheet?: SheetState;
}
```

**迁移**：`store.ts` 的 `normalizeProject()`（约 :664-690）里加一段：
老项目读到 `videos` 有内容、`motions` 为空 → `motions.walk = { mode:"perDirection", videos, frames, sheet }`，
`activeActionId = "walk"`，然后**不删旧字段**（只在新写入时不写它们），跑两个版本后再删。

### 3.3 配置（`src/config.ts` + `src/index.ts` 的 `saveConfig`）

```ts
/** 用户自定义动作库（全局，跨项目复用）。内置动作不落盘。 */
customActions: ActionDef[];
```

⚠️ 两处白名单，漏了就是**静默丢弃**：

- **全局配置**：`index.ts:357` 的 `saveConfig` 用 `directKeys`（index.ts:360-445）逐字段透传；
  `customActions` 是数组，建议**不进 directKeys**、单独手写归一化（逐项校验 id/label/prompt 长度、
  去重、跳过内置 id、最多 50 条），再写进 patch。
- **项目级参数**：`saveSettings`（index.ts:777-828）**逐字段重建 settings 对象**，未列入的字段被丢弃；
  动作相关字段要像 `turnFrameCount`（:807）那样加一行 clamp。

---

## 4. 流水线改造

### 4.1 阶段②（perDirection）只改一处：动作来源

`startVideos`（pipeline.ts:993）现在读 `project.prompts.video` / `prompts.videoPerDirection[key]`。
改成：

```ts
const action = actionOf(project, project.activeActionId);
const motion = motionOf(project, action.id);
const prompt = (project.prompts.videoPerDirection?.[key] ?? project.prompts.video ?? action.prompt).trim();
```

其余全部照旧（首帧仍然是 `images/<dir>.png`，产物写进 `motions[actionId].videos[dir]`）。

### 4.2 新增阶段②-b（keyframe）流水线

```
A. 母本动作视频   images/<baseDirection>.png（默认 front） + action.prompt → seedVideo.mp4   ★1 次
B. 抽候选帧       seedVideo.mp4 → 32 张匀速候选帧（复用 extractFrames/抽帧逻辑，本地免费）
C. 选关键帧       用户拖选 N 张（默认等分 N=5），或由动作预设的 keyframeCount 决定
D. 逐关键帧转圈   对每个关键帧 ki：以它为首帧 → 跑一次「转圈视频」→ 32 候选 → 8 方向图   ★N 次
E. 组装矩阵       对方向 d：frames = [ turn_k0.picks[d], turn_k1.picks[d], … turn_kN.picks[d] ]
                 按顺序写成 frames/<d>/f00..fNN.png + raw.bin（顺序 = 关键帧顺序）
F. 抠像合成       直接调 renderSheet()，零改动 → out/sheet.png（8 行 × N 列）
G. 可选插帧       ffmpeg minterpolate 在两两关键帧之间补 1~2 帧，输出 motion/frames/<d>/fNN.png
```

**关键设计点**

1. **转圈提示词要有「姿势锁定」变体**。现有 `DEFAULT_TURN_PROMPT` 的 `[起始姿态]` 写的是
   「正面站姿面对镜头」，用在半挥刀的姿势上会把角色掰回站姿。新增：

   ```ts
   export const DEFAULT_TURN_PROMPT_POSE_LOCK = [ // 只换第一段
     "[固定机位] …(同默认)…",
     "[起始姿态] 画面开始时角色必须就是参考图里的样子：**保持参考图中的这个动作姿态**——手臂、腿、武器与躯干的角度、重心位置全部不要改，也不要把它掰回站姿；完整保留参考图的五官、服装、配色与整体画风。",
     "[动作] …原地绕自身竖直轴以完全均匀的速度旋转满一整圈…",
     "[禁止其它动作] 除了绕竖轴旋转不要有任何动作：不要迈步、不要挥动、不要把动作收回去，姿态在整圈里保持冻结，只允许整体朝向变化。",
     "[一致性] …",
     "[背景] …",
     "[画面] …"
   ].join("\n");
   ```
   项目加 `turnPoseMode: "front" | "asIs"`，keyframe 流水线固定用 `asIs`。

2. **矩阵组装 = 写 frames**。这是本方案能低成本落地的核心：`composeSheet(rows, {frameCount: N})`
   本来就接受任意列数（`src/chroma.ts:585`，`columns = max(1, options.frameCount)`），
   `renderSheet` 也只是把 `frames[dir].frames` 顺序贴到格子里。
   所以 keyframe 流水线**不需要新写合成器**，只要把 N 张图按关键帧顺序写进 `frames/<dir>/`。

3. **每个关键帧的 TurnState 独立**（`seed.turns["k0"]`），有各自的 32 候选与 picks，
   UI 上就是 N 个迷你转圈面板；任何一个关键帧姿势没转对，只重跑那一个（★1 次）。

4. **插帧**：`ffmpeg -i a.png -i b.png -filter_complex minterpolate` 对两张静图不适用，
   正确做法是把整条序列拼成视频后插帧，或者用 `-filter_complex "minterpolate='mi_mode=mci:fps=…'"` 对
   N 帧序列先编码成序列再用光流插值。**首版先不做**（N 关键帧直接当 N 帧用，游戏里就是 N 帧的硬切动画），
   留一个 `interpolateAction({projectId, times})` 的口子。

### 4.3 需要新增/修改的文件

| 文件 | 改动 |
|---|---|
| `src/directions.ts` | 新增 `ActionDef` / `BUILTIN_ACTIONS` / `DEFAULT_TURN_PROMPT_POSE_LOCK` / `actionOf()`；`localizePrompts` 扩展动作提示词 |
| `src/store.ts` | `Project` 加 `actions` / `activeActionId` / `motions` / `turnPoseMode`；`MotionState` / `SeedActionState` 类型；`normalizeProject` 迁移；`motionOf()` / `actionOf()` 辅助 |
| `src/pipeline.ts` | `startVideos` 读动作与分桶；新增 `startActionSeed` / `startSeedCandidates` / `setSeedKeyframes` / `startKeyframeTurn` / `cutKeyframeTurn` / `composeActionMatrix`；`submitTurnVideo` 参数化（首帧 + 提示词变体 + 目标 TurnState） |
| `src/wire.ts` | 新增 8~10 个方法的 zod schema；已有方法加字段（`savePrompts` 加 `actionId`、`runVideos` 加 `actionId`） |
| `src/tools.ts` | `METHOD_MODULE` 加新方法（全部归 `sprite`）+ 分发实现 + `toolguides.ts` 的 sprite 主题补流程 |
| `src/config.ts` + `src/index.ts` | `customActions` 配置 + `directKeys` 白名单 |
| `src/client.ts` | 阶段② 顶部加动作下拉 + 「＋ 新建动作」弹窗；keyframe 模式的母本视频卡 / 关键帧选择条 / N 个转圈面板；`T()` 词条 |
| `src/index.ts` | `SERVABLE_DIRS` 加 `actions`（母本视频与关键帧图落这里，否则 403 图裂） |
| `scripts/verify-*.mjs` | host / client / tools / pipeline 四件补契约 |

---

## 5. 界面（`src/client.ts`，行号基于 v0.11.0）

**先记住三条硬约束**（不然改完不报错、只是坏掉）：

1. `render*Stage` 是**普通函数**、在 `StudioPanel` 里被条件调用（client.ts:5492-5536），**不能在里面 `useState`**；
   需要 Hook 的阶段必须包成真组件（样板：`renderFrameStage` 6759-6764 → `FrameStage` 6766-6991）。
2. 新增项目级参数要改**三处**：`ProjectSettings`（store.ts:240-266）+ 宿主 `saveSettings` 的**逐字段重建白名单**
   （index.ts:777-828，没列入的字段被静默丢弃）+ 界面。
3. 新文案必须登记进 `const EN = {...}`（client.ts:46-2055）——中文表由 EN 的 key 反推（2115），
   漏了只是「英文界面显示中文」，不会露 key。模块加载时求值的表还要进 `staticTextRebuilders`（2064-2104）。

阶段② 现在的结构是「一句提示 + 一个全局视频提示词 textarea + 八个方向卡片」：

| 位置 | 内容 |
|---|---|
| `renderVideoStage` client.ts:6349-6541 | 阶段② 全部 |
| 6366 | 顶部提示句 |
| 6367-6371 | 全局视频提示词 `textarea`（`videoPromptDraft`） |
| 6372-6426 | 工具条：保存提示词 / 生成全部 / 立即刷新 / 全部通过 / 清空重来 |
| 6427-6437 | 八方向网格 `SPR_grid` |
| 6440-6537 | 单个方向卡片（预览 / 遮罩 / 错误 / 生成 / 选本地视频 / 通过 / 保存） |
| 5003 / 5073-5077 / 4319-4331 | `videoPromptDraft` 与 `mergeDrafts()`（**轮询不许覆盖草稿**） |

改造后的结构：

```
┌ 阶段② 动作视频 ────────────────────────────────────────┐
│ 动作 [ 走路 ▾ ]  ＋新建   类型:循环   生成方式:(8 方向独立 | 关键帧转圈)  │
│ 提示词 [多行文本框]                    [保存] [重置为预设]              │
├─────────────────────────────────────────────────────────┤
│ perDirection 模式：八个方向卡片（现状不变）                              │
│ keyframe 模式：                                                         │
│   ① 母本视频  [预览]  [生成] (★1 次)                                    │
│   ② 关键帧    [候选条带，可拖 N 个圆圈]  关键帧数 [5]                   │
│   ③ 转圈      k0 [候选条带][8 向缩略]  k1 […]  k2 […] …                   │
│   ④ 成品      [8 × N 预览]  [合成整图]                                   │
└─────────────────────────────────────────────────────────┘
```

要点：
- 动作下拉切换时，若当前提示词 ≠ 预设提示词 → 弹「保留我的修改 / 用预设覆盖」。
- 「＋新建动作」弹窗：名称、类型、提示词、建议关键帧数 → 存进 `config.customActions`（全局）。
- 动作切换后**产物不丢**（`motions[actionId]` 分桶）。
- 所有文案走 `T("中文")` 并补英文词条；模块顶层的动作名表要进 `staticTextRebuilders`。

### 5.1 具体挂载点（照抄即可）

| 要加的东西 | 加在哪 | 抄哪个现成实现 |
|---|---|---|
| 动作下拉 | 阶段② 顶部，client.ts:6366 与 6367 之间 | `h("label",{className:"SPR_field"}, h("span",{className:"SPR_fieldLabel"}, T("动作")), h("select",{className:"SPR_input", value:…, onChange:…}, …options))`，样板在 13664-13667 |
| 「8 独立 / 关键帧」模式切换 | 阶段② 工具条 6372 之前（或 6427 网格上方） | 药丸分段控件 `ImageModeBar` 5657-5689（`SPR_modeBar` + `button.SPR_mode` + `data-active`），数据表照 `IMAGE_MODES` 5607-5613 |
| 新建动作弹窗 | 与现有弹窗同层（`SPR_modal` 那套） | 设置页的字段组 `SPR_field` / `SPR_input`（20466 附近） |
| keyframe 子界面（母本卡 / 关键帧条 / N 个转圈面板） | 阶段② 内部**作为真组件** `ActionSequenceStage`，在 6363 的 Fragment 里按 `mode` 二选一渲染 | 真组件样板 `FrameStage` 6766；关键帧选择条抄 `TurnAxis` 5690-5817 / `FramePickAxis` 6548-6667；N 个转圈面板抄 `TurnImageStage` 5820-6111（每个关键帧一个，状态从 `seed.turns["k0"]` 取） |
| 阶段条的绿点 / 说明 | `stageDone()` 5586-5592、`stageHint()` 5579-5584（如果提升成独立阶段才需要） | — |
| 深链接 `?stage=` | 5040 用 `STAGES.some(...)` 校验；提升成独立阶段要改 `make_STAGES()` 3153-3162 | — |

**建议**：A 期只改阶段② **内部**（下拉 + 模式切换），不动阶段条；B/C 期如果 keyframe 界面太大，
再提升成独立阶段（`STAGES` + 分发 + `setApproved` 的 `z.enum` 同步，wire.ts:82 是硬编码枚举）。

### 5.2 前端 API 面

新增远程方法要同时改**四处**：`wire.ts`（zod schema + METHODS 表）、`index.ts`（handler + 静态资源白名单）、
`client.ts` 的 `REMOTE_METHODS`（2819）与 `api` 薄封装（21479）。调用一律 `await api.xxx({...})`，
`start()`（5237-5247）负责 pending 反馈。

---

## 6. 工具面（对话侧）

新增方法（全部 `sprite`）：

```
listActions({projectId})                      列出内置 + 自定义动作与当前选中
saveAction({projectId?, action})              新建 / 覆盖自定义动作（含提示词）
deleteAction({projectId, actionId})           删自定义动作（内置不可删）
setActiveAction({projectId, actionId})        切换当前动作
setMotionMode({projectId, actionId, mode})    切 8 独立 / 关键帧
runActionSeed({projectId, actionId, baseDirection?, prompt?})   ★1 次
extractSeedCandidates({projectId, actionId, count?})            本地免费
setSeedKeyframes({projectId, actionId, keyframes:[…]})          本地免费
runKeyframeTurn({projectId, actionId, keyframe, regenerate?})   ★1 次/关键帧
cutKeyframeTurn({projectId, actionId, keyframe, count?})        本地免费
composeActionMatrix({projectId, actionId})                      本地免费
```

`guide` 的 sprite 主题补一条「攻击动画怎么走」：先 `setActiveAction` → `runActionSeed` →
`extractSeedCandidates` → `setSeedKeyframes` → 循环 `runKeyframeTurn` → `composeActionMatrix`。

---

## 7. 坑位清单（都是实测踩过的，务必写进注释）

1. **视频提示词里不许列举方位例子**。写「背对镜头就一直背对镜头、面对镜头就一直面对镜头」时，
   模型会抓住第一个例子把正面角色转过来。要写成抽象句：「第一帧是什么朝向，整段就保持那个朝向，
   禁止转身 / 转头 / 转离镜头」。
2. **对称特征（独眼、单肩甲）必须在提示词里正面锁定**，否则 8 步 turbo 会把它们「修正」成对称。
3. **转圈速度不均匀**（实测前快后慢），8 个方向不能靠等分下标，要按实测角度校准 picks。
   一次性动作的关键帧转圈同样要校准（每个关键帧一套 picks）。
4. **`clearVideos` 不删磁盘文件**，重提前要按状态判断，否则会拿旧视频的帧去合成。
5. **`motions` 分桶后，`openUrl` 深链接要带 `action` 参数**，否则用户点回界面看到的还是默认动作。
6. **关键帧姿势被掰回站姿**是最常见的失败 —— 只看 `turns.k*.frames` 的前几帧就能发现，重跑单个关键帧即可。
7. 新增静态资源子目录必须进 `SERVABLE_DIRS`（`src/index.ts:2854`），否则图裂且不报错。

---

## 8. 分期实施

| 期 | 内容 | 交付 | 计费 |
|---|---|---|---|
| **A（1~2 天）** | 动作模型 + 内置 7 个动作 + select + 自定义动作 + 提示词绑定；`motions` 分桶与迁移 | 走路/待机/攻击都能用「8 方向独立」跑通 | 与现状相同 |
| **B（2~3 天）** | keyframe 流水线后端（母本 → 关键帧 → 逐帧转圈 → 矩阵）+ 工具面 | agent 能全自动跑出 8×N 攻击图 | 1 + N 次 |
| **C（1~2 天）** | keyframe 流水线界面（母本卡 / 关键帧条 / N 个转圈面板 / 成品预览） | 人也能全程手点 | — |
| **D（可选）** | 插帧（光流补间）、动作预览播放器、导出 GIF 到 `out/` | 更顺滑 | — |

---

## 9. 验收清单

- [ ] `npm run build` + `npm run typecheck` 通过
- [ ] `verify-host` / `verify-client` / `verify-tools` / `verify-pipeline` / `verify-feedback` / `verify-i18n` 全绿
- [ ] 老项目（只有 `videos` 字段）能打开、能继续跑到整图，不被迁移弄丢产物
- [ ] 走路：picks 校准后 8 向分布正确（用 `docs/` 里的校准方法，看 32 格候选图）
- [ ] 攻击：N=5 时 6 次视频调用，8 行 × 5 列，打击帧在每一行的**同一列**
- [ ] 独眼等不对称特征在 8 个方向都保留（肉眼过一遍整图）
- [ ] 中英文界面各点一遍：动作名、提示词、新建动作弹窗都有英文
