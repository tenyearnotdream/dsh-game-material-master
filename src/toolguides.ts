/**
 * 对话面的**按需手册**。
 *
 * 模型每次请求都会带上工具定义，所以工具面只保留一个 `game_material`；
 * 具体流程、方法名、参数与踩坑说明放在这里，由
 * `game_material({action:"guide", topic:"…"})` 主动读取。
 *
 * 这里的文字只面向模型，不是界面文案，所以保持中文、不接 `T()`。
 * 新增远程方法时，除了写进对应模块主题，`methods` 目录会从
 * `TOOL_METHODS` + `METHOD_MODULE` 自动生成，`verify-tools.mjs` 会核对覆盖。
 */

import { STUDIO_MODULES, type StudioModule } from "./links.js";

/** 手册主题；模块 key 与 `STUDIO_MODULES` 完全一致。 */
export const GUIDE_TOPICS = [
  "overview",
  "workflow",
  "config",
  "methods",
  "ai-asset",
  ...STUDIO_MODULES
] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export function isGuideTopic(value: string): value is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(value);
}

export function guideTopicList(): string {
  return GUIDE_TOPICS.join(" / ");
}

export interface GuideOptions {
  /** 用户在设置里隐藏的模块。 */
  hidden: ReadonlySet<string>;
  /** 模块中文名，与界面页签一致。 */
  labels: Record<StudioModule, string>;
  /** 暴露给模型的方法（已排除 clientOnly）。 */
  methods: ReadonlyArray<{ method: string; payload: boolean }>;
  /** 方法所属模块；共享方法返回 undefined。 */
  moduleOf: (method: string) => StudioModule | undefined;
  /** 共享方法（配置、测试、审核模式）。 */
  sharedMethods: ReadonlySet<string>;
  /** topic=methods 时只看某一个模块。 */
  module?: StudioModule;
}

export interface GuideResult {
  title: string;
  text: string;
}

/** 模块顺序与界面一致；隐藏模块从手册里整体消失。 */
function visibleModules(options: GuideOptions): StudioModule[] {
  return STUDIO_MODULES.filter((module) => !options.hidden.has(module));
}

function methodLine(entry: { method: string; payload: boolean }): string {
  return entry.payload ? `- \`${entry.method}(payload)\`` : `- \`${entry.method}()\``;
}

function methodsOfModule(module: StudioModule, options: GuideOptions): Array<{ method: string; payload: boolean }> {
  return options.methods.filter((entry) => options.moduleOf(entry.method) === module);
}

function sharedMethodsOf(options: GuideOptions): Array<{ method: string; payload: boolean }> {
  return options.methods.filter((entry) => options.sharedMethods.has(entry.method));
}

/** 模块主题末尾自动附上方法名，防止「方法做了但手册没提」。 */
function moduleText(module: StudioModule, options: GuideOptions): string {
  const base = MODULE_TEXTS[module];
  const lines = methodsOfModule(module, options).map(methodLine);
  return [
    `# ${options.labels[module]}（${module}）`,
    "",
    base,
    "",
    "### 本模块方法",
    ...(lines.length === 0 ? ["（暂无）"] : lines),
    "",
    "调用方式：`game_material({action:\"call\", method:\"<方法名>\", payload:{…}})`；有 payload 的方法必须给对象。"
  ].join("\n");
}

function overviewText(options: GuideOptions): string {
  const modules = visibleModules(options);
  const moduleLines = modules.map(
    (module) => `- \`${module}\` — ${options.labels[module]} → \`game_material({action:"guide", topic:"${module}"})\``
  );
  return [
    "# 游戏素材大师（game-material-master）",
    "",
    modules.length === 0
      ? "本机已安装「游戏素材大师」插件，但所有功能都已被用户在「设置 → 游戏素材大师 → 功能管理」里隐藏。"
      : `本机已安装「游戏素材大师」插件：${modules.map((module) => options.labels[module]).join(" / ")}。界面在侧栏「游戏素材大师」面板。`,
    "",
    "## 工具入口",
    "只有一个工具 `game_material`，用 `action` 选择要做什么：",
    "- `guide` — 读手册（任何任务的第一步）；可带 `topic`，默认 `overview`。",
    "- `intake` — 固定流程第 0 步：按真实状态列出还缺的参数与审核模式问题。",
    "- `call` — 调远程业务方法：`{action:\"call\", method:\"方法名\", payload:{…}}`。",
    "- `status` — 看进度；`wait` — 等到没有任务在跑；`review` — 出验收包；`approve` — 打通过。",
    "- `reviewMode` — 记录 auto / manual；`upload` — 按本机路径上传素材。",
    "",
    "**不要凭记忆猜方法名。** 先读对应模块的手册（里面有方法表与参数）；不确定某个方法属于哪个模块时读 `methods` 主题。",
    "",
    "## 模块（当前可见）",
    ...(moduleLines.length === 0 ? ["所有功能都已被用户在「设置 → 游戏素材大师 → 功能管理」里隐藏。"] : moduleLines),
    "",
    "## 其它主题",
    "- `workflow` — 固定流程、审核模式、计费与验收规则。",
    "- `config` — 配置方法、生图后端与连接测试。",
    "- `methods` — 全部可见方法目录（可按 `module` 过滤）。",
    "- `ai-asset` — 地图编辑器「AI 生成素材」自动任务。",
    "",
    "## 硬规则",
    "- 生成 / 视频 / 音乐 / 音效都可能**真实计费**：不要为了确认状态重复提交；提交后先 `action:\"wait\"`。",
    "- 用户说「自动审核」或「每一步人工审核」时，用 `action:\"reviewMode\"` 记录；manual 模式每步都要贴验收链接并停下等回复。",
    "- 工具返回的 `openUrl` 必须原样贴成 Markdown 链接，不要改写成裸文本，也不要自己编 URL。",
    "- 不要用 bash/shell 直接改 `<DSH_HOME>/game-material-master/` 下的 JSON——那会绕过宿主的复用与校验。",
    "- 被隐藏的模块对工具面一律不可用；遇到报错不要重试、不要绕过，让用户去设置里打开。"
  ].join("\n");
}

function workflowText(): string {
  return [
    "# 固定流程与验收",
    "",
    "## 第 0 步 · 先问，再动手",
    "用户一说要用某个功能，**先调用** `game_material({action:\"intake\", module:\"<模块>\", id?, told?})`，把它返回的 `questions` 逐条问清楚。",
    "还必须问同一个问题：「结果要自动审核，还是每一步人工审核？」——两者合并成一次提问，不要挤牙膏式地一问一停。",
    "在关键参数与审核模式都拿到答复之前，**不要调用任何生成类 / 删除类方法**。用户已经明确告知过的参数不必重复问；",
    "答复用 `game_material({action:\"call\", method:\"…\", payload:{…}})` 写进目标，审核模式用 `game_material({action:\"reviewMode\", module, id, reviewMode})` 记下来。",
    "",
    "## 第 1 步 · 逐阶段推进",
    "- 八方向图：images → videos → frames → sheet；",
    "- 图片生成：prompt → runImageJob → keyImageJob；",
    "- 序列帧：video → frames → sheet；",
    "- 骨骼动画：parts → layout → rig → atlas；",
    "- 地图地块：generate → review → map → export；",
    "- 地图编辑器：assets → rules（宿主自动）→ paint → export；",
    "- 音乐：generate → edit → export；谱曲：方案 → runMusicScore → 试听 → 导出；",
    "- 音效：generate → export。",
    "每次提交类调用之后**立刻** `game_material({action:\"wait\", id})`，拿到 `settled=true` 再判断下一步。",
    "",
    "## 第 2 步 · 每步都要审",
    "用 `game_material({action:\"review\", module, id, stage?, direction?, index?, step?})` 拿验收包，逐项看 status / error / 绝对 URL。",
    "用户说「我看看」「验收一下」时也用它，然后把 `openUrl` 以 Markdown 链接贴给用户。",
    "",
    "## 第 3 步 · 按审核模式分岔",
    "- `auto`：自己判断没问题就 `game_material({action:\"approve\", id, approved:true})` 打通过并进入下一步；",
    "- `manual`：贴出 openUrl 并**停下等用户回复**，只有用户明确说「通过 / 可以」才 approve 并继续。",
    "失败只重跑失败的那一项（例如 `runImage` / `runVideos({regenerate:true, keys:[…]})` / `runFrames({keys:[…]})`），不要整批重来。",
    "",
    "## 验收链接",
    "`intake` / `status` / `wait` / `review` / `upload` 等返回的 `openUrl` 是给用户点的深链接。输出时必须原样写成 Markdown 链接",
    "（例如 `[查看第 2 步验收](http://…/?dsh-gmm=1&module=sprite&project=…&stage=videos)`）；用户点击后界面会原地切到插件对应页面。",
    "不要改写成裸文本，也不要自己编 URL。manual 模式下每完成一步都要贴一次；auto 模式下至少在全部完成或需要用户决策时贴。",
    "",
    "## 计费与重复提交",
    "生图、生视频、音乐生成、音效生成都真实计费：不要为了确认状态重复提交同一个目标；提交类调用返回后一律先 `action:\"wait\"`。",
    "音乐已有歌曲后再生成必须 `regenerate:true`；Suno 每次提交返回 2 首；音效每次生成一条 take，失败不自动重试。",
    "",
    "## 被隐藏的功能",
    "用户可以在「设置 → 游戏素材大师 → 功能管理」里隐藏模块。被隐藏的模块：",
    "- 界面里不再出现它的页签与侧栏菜单项；",
    "- 工具面同样不可用——`guide` / `call` / `intake` / `upload` / `status` / `wait` / `review` / `approve` 对它的调用都会明确报错。",
    "`status`（不带 id）返回的 `hiddenModules` 是当前被隐藏的模块 key 列表。遇到这类报错**不要重试、也不要绕过**（例如直接改配置文件）：",
    "告诉用户这个功能被隐藏了，请他在设置里打开。`hiddenModules` 也不能通过 `game_material({action:\"call\", method:\"saveConfig\"})` 修改——工具面会拒绝。"
  ].join("\n");
}

function configText(options: GuideOptions): string {
  const shared = sharedMethodsOf(options).map(methodLine);
  return [
    "# 配置与后端",
    "",
    "配置方法通过 `game_material({action:\"call\", method:\"…\", payload:{…}})` 调用：",
    "- `getConfig()` 读取当前配置；`saveConfig(payload)` 保存。",
    "- `testArk()` / `testCustomImage()` / `testMinimax()` / `testComfy()` / `testMusic()` / `testMusicScore()` / `testSfx()` 测试连接。",
    "- 生图后端：`imageProvider` = `ark`（火山方舟 Seedream，默认）或 `custom`（用户自己的服务）。",
    "  - `customProtocol`：`openai` / `comfyui` / `sdwebui`；",
    "  - `customBaseUrl` / `customModel` / `customApiKey` / `customWorkflow` 等按协议填写。",
    "  - 换后端只改 `imageProvider` 一个字段，八方向图 / 图片生成 / 骨骼动画 / 地图地块全都跟着走。",
    "- 图生视频默认走 MiniMax；`comfyVideo` 可改走本机 / 远端 ComfyUI。",
    "- 凭据类字段（`arkApiKey` / `minimaxApiKey` / `customApiKey` / `sfxApiKey` / `musicApiKey` / `comfyCookies`）只写入、不回传明文；不要在回答里打印。",
    "- `hiddenModules` 只能由用户在设置页「功能管理」里改，工具面拒绝写。",
    "",
    "## 共用方法",
    ...(shared.length === 0 ? ["（暂无）"] : shared)
  ].join("\n");
}

function methodsText(options: GuideOptions): string {
  const modules = options.module === undefined ? visibleModules(options) : [options.module];
  const lines = [
    "# 方法目录",
    "",
    "调用方式：`game_material({action:\"call\", method:\"<方法名>\", payload:{…}})`；`payload` 为对象，没有 payload 的方法不要传。",
    ""
  ];
  let count = 0;
  for (const module of modules) {
    const entries = methodsOfModule(module, options);
    count += entries.length;
    lines.push(`## ${options.labels[module]}（${module}）`);
    lines.push(...(entries.length === 0 ? ["（暂无）"] : entries.map(methodLine)));
    lines.push("");
  }
  if (options.module === undefined) {
    const shared = sharedMethodsOf(options);
    count += shared.length;
    lines.push("## 共用");
    lines.push(...(shared.length === 0 ? ["（暂无）"] : shared.map(methodLine)));
    lines.push("");
  }
  lines.push(`共 ${count} 个方法。隐藏模块的方法不会出现在这里。`);
  return lines.join("\n");
}

const MODULE_TEXTS: Record<StudioModule, string> = {
  sprite: [
    "## 固定流程",
    "阶段① images（八方向绿幕图）→ ② videos（行走视频）→ ③ frames（抽帧）→ ④ sheet（合成整图）。每步提交后立刻 `action:\"wait\"`。",
    "",
    "## 方法",
    "- `listProjects()` / `createProject({name})` / `getProject({projectId})` / `deleteProject({projectId})` / `renameProject({projectId,name})`",
    "- `uploadSource({projectId,name,data:base64})` / `savePrompts({projectId,images?,video?,turn?,videoPerDirection?,suffix?,resetImagesToDefault?,resetVideoToDefault?,resetTurnToDefault?})`",
    "- `saveSettings({projectId,settings})` / `setApproved({projectId,stage:images|videos|frames|sheet,key?,approved})` / `revealProject({projectId})`",
    "- `uploadVideo({projectId,key:turn|<方向>,name,data:base64})`【本地自选视频：key=turn 是转圈视频（导入后自动抽候选帧并切八张图），key=<方向> 是某段行走视频；产物与远端生成同形，`origin:'local'` 标注来路】",
    "- `exportImages({projectId})`【把八方向绿幕图 / 转圈候选帧与条带 / 每段视频的绿幕帧与抠像帧 / 整图打成 zip 落在 out/ 下】",
    "- `runImage({projectId,key,prompt?})` / `runImages({projectId,force?})` / `runVideos({projectId,keys?,regenerate?})` / `pollVideos({projectId})`",
    "- `clearVideos({projectId,keys?})` / `runFrames({projectId,keys?})` / `rekey({projectId})` / `compose({projectId})`",
    "- `prepareFramePick({projectId,key,count?})`【只抽这个方向的候选帧，免费】/ `setFramePick({projectId,key,slot,index})` / `setFramePicks({projectId,key,picks:[index,…]})` / `resetFramePicks({projectId,key})`",
    "",
    "## 阶段① 两种生成方式（默认转圈截帧）",
    "`getProject` 返回的 `imageMode` 决定怎么做，产物都是 `images/<方向>.png`，后续阶段不变：",
    "- `turn`（默认）**转圈截帧**：`runTurnVideo({projectId})` 生成一段「角色原地匀速转一整圈」的绿幕视频（★一次 MiniMax 计费）。",
    "  视频到手后宿主自动抽候选帧并切出八个方向（本机 ffmpeg，免费）；八个方向的位置就是同一段视频的截帧下标，",
    "  可用 `setTurnPick({projectId,key,index})` 单独调，或 `resetTurnPicks({projectId,direction?'cw'|'ccw'})` 回到默认等分。",
    "  视频转得不对（转速不匀 / 动作太多 / 第一帧不是正面）时重跑 `runTurnVideo`，别去调坐标。",
    "- `direct`（备选）**逐方向生图**：`runImages({projectId})` 按依赖顺序逐个生图，单张更清晰但八个方向容易不一致。",
    "`setImageMode({projectId,mode:'turn'|'direct'})` 随时切换，两种方式的产物互不删除。",
    "",
    "## 关键约束",
    "- 每次提交类调用后先 `action:\"wait\"`；视频这一步最贵，确认 prompt 后再提交。",
    "- `getProject` 的 `imageMode` 是转圈 / 逐方向的分叉点；不要拿旧项目的产物当新角色。",
    "- 八个方向的提示词是内置模板，可单独保存 / 重置；改一份语言设置只影响未改过的模板。"
  ].join("\n"),

  image: [
    "## 固定流程",
    "`createImageJob({name})` → `saveImageJob({jobId,prompt,suffix?,settings?,keying?})` → `runImageJob({jobId,count?})`（★计费）→ `action:\"wait\"` → `keyImageJob({jobId})`（本地抠像）→ 验收 / 导出。",
    "",
    "## 方法",
    "- `listImageJobs()` / `createImageJob({name})` / `getImageJob({jobId})` / `deleteImageJob({jobId})`",
    "- `saveImageJob({jobId,name?,prompt?,suffix?,settings?,keying?,approved?,index?})` / `uploadImageRef({jobId,name,data})` / `removeImageRef({jobId,file})`",
    "- `addImageItem({jobId,name,data})` / `removeImageItem({jobId,index})` / `runImageJob({jobId,count?})` / `keyImageJob({jobId})`",
    "",
    "## 产出与交接",
    "`getImageJob` 返回 `dir`（本机绝对目录）：作品绝对路径 = `dir + \"/\" + items[i].file`（形如 out/img-00.png）。",
    "把生成结果交给别的模块（例如 `composeMapAsset`）时用绝对路径。",
    "",
    "## 关键约束",
    "- 生图真实计费；确认 prompt 与 count 后再提交，失败只重跑失败的那张。",
    "- 抠像 / 合成是本地计算，免费；不要为了「看看状态」重复提交生成任务。"
  ].join("\n"),

  sequence: [
    "## 固定流程",
    "`createSequenceJob({name})` → 上传首帧 / 尾帧 / 参考素材 → `saveSequenceJob({jobId,mode,prompt,settings})` → `runSequenceVideo({jobId})`（★计费）→ `action:\"wait\"` → `runSequenceFrames({jobId,count?})`（本地）→ `composeSequence({jobId})`。",
    "",
    "## 方法",
    "- `listSequenceJobs()` / `createSequenceJob({name})` / `getSequenceJob({jobId})` / `deleteSequenceJob({jobId})`",
    "- `saveSequenceJob({jobId,name?,mode?,prompt?,suffix?,settings?,keying?,approved?,step?})` / `uploadSequenceRef({jobId,kind:firstFrame|lastFrame|referenceImage|referenceVideo,name,data})`",
    "- `removeSequenceRef({jobId,kind,file?})` / `runSequenceVideo({jobId})` / `pollSequenceVideo({jobId})` / `clearSequenceVideo({jobId})`",
    "- `runSequenceFrames({jobId,count?})` / `keySequenceFrames({jobId})` / `composeSequence({jobId})`",
    "",
    "## 产出与交接",
    "`getSequenceJob` 返回 `dir` 与 `frames.files`：帧的绝对路径 = `dir + \"/\" + file`。",
    "把帧交给 `composeMapAsset`（AI 生成素材）时按帧序取前 N 张。",
    "",
    "## 关键约束",
    "- 生成视频真实计费；抽帧 / 抠像 / 合图是本地计算。",
    "- 首帧 / 参考素材没上传时无法提交；先 `getSequenceJob` 看当前模式需要哪些素材。"
  ].join("\n"),

  rig: [
    "## 固定流程",
    "① parts（`runRigSheet`，★一次 Seedream 计费）→ ② layout（`runRigLayout`，本地）→ ③ rig（`runRigBones`，本地）→ ④ atlas（`runRigAtlas`，本地）。",
    "只有第 ① 步花钱；②③④ 重跑不额外计费。装配失败时用 `runRigLayout({jobId, names:[…]})` 只重跑那几个部件。",
    "",
    "## 方法",
    "- `listRigJobs()` / `createRigJob({name})` / `getRigJob({jobId})` / `deleteRigJob({jobId})`",
    "- `saveRigJob({jobId,name?,sheetPrompt?,suffix?,resetSheetPrompt?,settings?,approved?,stage?parts|layout|rig|atlas,part?})`",
    "- `uploadRigSource({jobId,name,data:角色整图})` / `uploadRigPart({jobId,name:部件名,data:部件PNG})` / `removeRigPart({jobId,name})`",
    "- `setRigPartVisibility({jobId,name,hidden})` / `saveRigLayoutItem({jobId,name,x?,y?,width?,height?,rotation?,z?})`",
    "- `setRigSemantics({jobId,parts:[{name,role?,parent?,proximal?,distal?,tags?}]})`【语义：这块是什么、挂在谁身上、骨骼从哪端伸到哪端】",
    "- `setRigBoneOffsets({jobId,bones:[{name,x?,y?,rotation?}]})` / `resetRigBoneOffsets({jobId,names?})`【手工骨骼偏移，重跑骨骼不会覆盖】",
    "- `setRigAnimationSettings({jobId,animations:[{id,duration?,amplitude?}]})` / `resetRigAnimationSettings({jobId,ids?})`【动画参数】",
    "- `tintRigParts({jobId,names?|tag?,tint:{hue?,saturation?,lightness?,brightness?,contrast?,rgb?},note?})`【换色，落成新版本】",
    "- `uploadRigTexture({jobId,name,data})` / `setRigTextureVersion({jobId,name,version})` / `removeRigTextureVersion({jobId,name,version})`【贴图版本】",
    "- `runRigRedraw({jobId,name,prompt,erode?})`【★计费：一次 Seedream 重绘单个部件】/ `runRigSheet({jobId})`【★计费：拆件】/ `runRigSegment({jobId})`【本地分割】",
    "- `runRigLayout({jobId,names?})` / `runRigBones({jobId})` / `runRigAtlas({jobId})`",
    "",
    "## 自动摆位不准时：给「视觉先验」",
    "第 ② 步的自动定位是纯几何匹配，对模型重画过的部件（裙摆、袖子这类服装裁片）会失手：它在错误位置也可能拿到不低的分数。",
    "这时**你（agent）就是那个视觉模型**：",
    "1. `read_image` 看 `getRigJob` 返回的 `sourcePath`（角色参考图）与 `partsMontagePath`（全部部件的蒙太奇图，按 `partsOrder` 从左到右、从上到下排列，每格一个部件，带格线）；",
    "2. 逐个判断「这块部件在参考图的哪个位置」，给出大致像素框（不需要精确，区域对就行）；",
    "3. `game_material({action:\"call\", method:\"setRigLayoutHints\", payload:{jobId, hints:{部件名:{x,y,width,height}}}})`，然后 `runRigLayout({jobId})` 重新装配。",
    "先验框给大一点没关系（搜索区域会自动向外放宽 35%），但**别给错区域**——给错了它就会往错的地方搜。",
    "",
    "## 三层修改：语义 / 骨骼偏移 / 动画参数（本地免费、互不覆盖）",
    "这三层分开存储，重跑任何一步都不会抹掉另一层的人工改动；优先用它们，而不是重新生成整条链路。",
    "1. **语义**：`setRigSemantics` 决定「这块是什么、挂在谁身上、骨骼从部件的哪一端伸到哪一端」。`getRigJob` 的 `parts[].role/parent/proximal/distal` 是当前值，顶层 `semantics` 是校验结果（`errors` 非空时写入会被拒绝并返回原因）。改语义只作废 ③ 骨骼与 ④ 图集，② 里已经摆好的位置不受影响。",
    "2. **骨骼偏移**：`setRigBoneOffsets` 手工微调某根骨头（位移单位是参考图像素，旋转是度）；`resetRigBoneOffsets({jobId,names?})` 回到自动推的姿势。它与「重新推骨骼」互不覆盖。",
    "3. **动画参数**：`setRigAnimationSettings` 的 `amplitude` 统一缩放旋转与位移，`duration` 改循环秒数；改完要 `runRigBones` 重算。哪些动作会生成由 `saveRigJob` 的 `settings.animations` 决定。",
    "4. **贴图变体**：`tintRigParts` 换色、`setRigTextureVersion` 切版本。每次换色 / 上传替换都新增版本、永不覆盖原图；`getRigJob` 的 `parts[].versions` 是版本表（带 `note`），`parts[].activeTexture` 是当前版本。换色是本地计算、免费。`tag` 可按语义标签批量。",
    "",
    "## 判断依据",
    "先 `getRigJob` 看 `rig.warnings`（几何推导）、`semantics.errors/warnings`（结构问题）、`atlas.warnings`。**构建失败时先读 `stage.error`**——导出前校验（Spine 4.2 四条地雷、DragonBones 的 `tweenEasing` 缺省即阶跃与 `curve` 编码、循环接缝、图集越界/缺区域）不通过会直接让那一步失败，具体原因在 error 里。",
    "④ 图集同时产出 Spine `skeleton.atlas` 与 DragonBones `_tex.json`（`atlas.dragonBones[]`），两者同一次装箱；③ 也同时产出 `rig.skeleton`（Spine 4.2）与 `rig.dragonBones.skeleton`（DragonBones 5.5）。不要只导一个就以为齐了。"
  ].join("\n"),

  tile: [
    "## 实验性模块",
    "45° 等距地块：几何交给代码、内容交给 AI。参考图由本机渲染，AI 只填菱形内部；生成后本地量一次、仿射对齐回标准菱形。",
    "",
    "## 四个阶段",
    "generate → review → map → export。**没有「先做模板」这一步**：等距参考图在 `runTileItems` 开始时按各建筑地块的占格形状自动渲染（形状 / 格子尺寸没变就复用，免费）。",
    "",
    "## 方法",
    "- `listTileProjects()` / `createTileProject({name,style?,lang?,settings?})` / `getTileProject({projectId,lang?})` / `deleteTileProject({projectId})`",
    "- `saveTileProject({projectId,lang?,name?,style?,items?,settings?,resetItemsToDefault?})`【改 style / items / settings 会让已生成的地块作废，重跑要花钱】",
    "- `runTileItems({projectId,keys?})`【★计费：按清单逐类生成，每个变体一次 Seedream 调用】/ `runTileItem({projectId,key,variant?})`【★计费：只重跑某一张】",
    "- `setTileApproved({projectId,key?,variant?,approved})` / `runTileMap({projectId,rows?,cols?,seed?,fill?,decorDensity?})` / `saveTileMapCells({projectId,cells?,decor?,buildings?,seed?})`",
    "- `runTileExport({projectId})` / `cancelTileJob({projectId})` / `revealTileProject({projectId})`",
    "",
    "## 关键约束",
    "- 出现 `geomMode=template` 说明几何回退，多半是模型不对：必须用 Seedream 5.0 系列（4.0 会把 2:1 等距菱形画成近正方形，实测比例 1.058）。只重跑那几张：`runTileItem({projectId,key,variant})`。",
    "- 同种子 + 同布局 = 逐像素一致；本地铺图 / 导出免费。",
    "- 改 style / items / settings 会作废已花钱的地块；先确认再保存。"
  ].join("\n"),

  map: [
    "## 全本地、零计费",
    "导入自己的素材图，四步：素材图 → 自动连接 → 环绕画布 → 导出 PNG/存档。没有任何一步需要 API Key。",
    "",
    "## 方法",
    "- `listMapProjects()` / `createMapProject({name,grid?,cols?,rows?})` / `getMapProject({projectId,lang?})` / `saveMapProject({projectId,name})` / `deleteMapProject({projectId})`",
    "- `importMapTileset({projectId,name,data:素材图base64,cell?,shape?,animRows?,fps?,clarity?,scale?})`【新增素材：属性一次定死；cell/shape/animRows 留空 = 自动识别；fps 是这个素材自己的动画速度（0.5~30 帧/秒，留空跟全局）；clarity = smooth|sharp|crisp；scale = 素材图每格几倍】",
    "- `importSampleTileset({projectId})`【内置素材：本机现算、零成本，4 张自动连接图 + 1 张道具图；可删可恢复】",
    "- `composeMapAsset({projectId,name?,files:[本机绝对路径…],shape?,cell?,animRows?,stampCols?,stampRows?})`【把 AI 生成的图按素材形态整理成一张待确认素材图，落在 `ai/`；**只整理、不进素材列表**；返回 openUrl 让用户点「新增素材」确认】",
    "- `recomposeMapTileset({projectId,tilesetId,files,clarity?})`【原地重烘一张素材：保留素材 id 与图块序号，已经画好的格子不用重画；删掉重导会清空它画过的格子】",
    "- `saveMapTileset({projectId,tilesetId,name?,cell?,shape?,animRows?,fps?})` / `removeMapTileset({projectId,tilesetId})`",
    "- `saveMapDoc({projectId,name?,cols?,rows?,layers?,addLayer?,removeLayerId?,moveLayer?,clearLayerId?,wrap?})`【地图只有一张：改尺寸/图层/环绕都走它】",
    "- `applyMapOps({projectId,ops,stroke?,have?})`【agent 也能画：ops = [{kind:'paint',layerId,cells:[{r,c,tile}]}, {kind:'fill',...}, {kind:'rect',...}, {kind:'replace',...}]；tile 取 `getMapProject` 的 `view.tilesets[].palette[].index`（1 起，0 = 空）】",
    "- `mapUndo({projectId,have?})` / `mapRedo({projectId,have?})` / `mapPlan({projectId,view:{x,y,width,height},have?,layerIds?})`",
    "- `runMapGenerate({projectId,kind:'random'|'maze'|'continent',tiles?,seed?,layerId?})` / `runMapPreview({projectId})` / `runMapExport({projectId,scale?,formats?})`",
    "- `cancelMapJob({projectId})` / `setMapApproved({projectId,stage?,approved})` / `revealMapProject({projectId,target?})`",
    "",
    "## 素材形态（composeMapAsset / 新增素材）",
    "- `plain` 普通：每张 = 一帧（一格内容），多张 = 翻页图。",
    "- `corner16` 整格：只能 1 张 = 一块无缝墙砖，宿主拼出 16 种接法；整格没有帧这一维。",
    "- `a2quad` 拼块：每张 = 一个变体的一块无缝材质，拼成 N 列 × 5 行；帧数 = 变体数。",
    "- `stamp` 整图：每张 = 一帧的整张画，必须给 `stampCols`/`stampRows`（占几格），背景纯绿幕，导入时由用户点通行区域。",
    "**不要自己先拼多格排布**：模型画的多格各自独立，拼到地图上每一处交界都有缝。整格 / 拼块只画一块无缝砖，怎么拼由宿主做。",
    "",
    "## 关键约束",
    "- `composeMapAsset` 只整理、不进素材列表；返回的 openUrl 会让「新增素材」按形态预填，用户点「确定」才真的导入。",
    "- 地图四周环绕：视口范围可以越出边界，宿主会映射回图内；网格、命中、绘制范围、脏块、自动连接邻域都取模。",
    "- 素材视图带 `rev`（文件 mtime）用于缓存失效；改完素材图要跟着刷新。",
    "- 导出是「内容多选 → 一个导出按钮 → 一个 zip / 另存为」；多产物自动打 zip。",
    "",
    "## 「AI 生成素材」自动任务",
    "如果用户是在地图编辑器素材窗口点「AI 生成素材」自动开的新对话，**先读 `guide` 的 `ai-asset` 主题**，不要 intake、不要问参数，直接按那段话做完。"
  ].join("\n"),

  music: [
    "## 直接生成（谱乐 AI，按平台积分计费）",
    "用户要写歌 / 做音乐时：先 `game_material({action:\"intake\", module:\"music\"})` 问清「灵感还是完整歌词 / 用途与风格 / 要不要后期」，并问审核模式；",
    "然后 `createMusicJob` →（先读 `getMusicGuide` 内置创作指南）→ `runMusicGeneration`（★计费）→ `action:\"wait\"`。",
    "一次提交按谱乐 AI 积分计费：Suno 返回 2 首；已有歌曲后再生成必须 `regenerate:true`；不要为确认状态重复提交；失败重试也要先问用户。",
    "生成后用 `renderMusicEdit` 做裁剪 / 音量 / 淡入淡出 / loudnorm（本地 ffmpeg、免费），用 `exportMusic` 导出；最后把 `openUrl` 原样贴成 Markdown 链接。",
    "用户给完整歌词时歌词是权威文本：不要重写，只修断句 / 结构标签 / 发音并说明改动。工具类接口（分轨 / MIDI / 乐谱 / 风格分析 / 转码）只接受公开 http(s) URL，编辑后的本地版本不能直接传。",
    "manual 模式：生成后先贴链接并停下等用户说「通过」；auto 模式：自己核对后继续，但失败 / 再生成仍要找用户确认。",
    "",
    "## 方法",
    "- `getMusicGuide({lang?})`【直接生成指南】/ `getMusicScoreGuide({lang?})`【谱曲模式 scoremill 指南】",
    "- `listMusicJobs()` / `createMusicJob({name?,source?,settings?,reviewMode?,workflow:generate|compose})` / `getMusicJob({jobId,lang?})` / `saveMusicJob({jobId,name?,source?,settings?,reviewMode?})` / `deleteMusicJob({jobId})`",
    "- `saveMusicScorePlan({jobId,plan})` / `runMusicScore({jobId,title?,plan?,script,basedOn?,label?})`【★本地免费：宿主跑 Python + 渲染试听】",
    "- `submitMusicScoreToSuno({jobId,scoreId?,confirm:true,model?,params?,regenerate?,copyrightAudio?,audioWeight?})`【★计费：先把这一版试听音频上传给 Suno 作为参考（标准上传免费），再走 cover；**不上传 MIDI 原文件**；已有歌曲必须 regenerate:true；绝不自动提交】",
    "- `setMusicApproved({jobId,stage?,songId?,versionId?,scoreId?,approved})` / `revealMusicJob({jobId})`",
    "- `runMusicGeneration({jobId,engine,mode,model?,params?,regenerate?})`【★计费：engine=suno|mureka|minimax|aceStep；params 用 camelCase 或 snake_case 都收】",
    "- `cancelMusicGeneration({jobId})`【只停本地轮询，已提交的仍会完成并计费】/ `refreshMusicJob({jobId})`",
    "- `getMusicWav({jobId,songId})` / `getMusicLrc({jobId,songIds?})` / `listMusicHistory({page?,size?,filters?})` / `listMusicStemInstruments()`",
    "- `runMusicTool({jobId,kind,params?})`【kind=stems|pro-stems|midi|sheet-music|style-analysis|convert；只接受公开 http(s) URL】",
    "- `musicPeaks({jobId,songId?,versionId?,scoreId?,buckets?})` / `renderMusicEdit({jobId,songId?,versionId?,ops,label?,preview?,force?})`【本地 ffmpeg，免费；ops={start,end,gainDb,fadeIn,fadeOut,normalize,lufs,truePeak,format,bitrate,channels,sampleRate}】",
    "- `saveMusicVersion({jobId,versionId,label?})` / `deleteMusicVersion({jobId,versionId})` / `exportMusic({jobId,songId?,versionId?,scoreId?,format?,name?,zip?})`",
    "",
    "## 谱曲模式（本地 MIDI，谱曲免费）",
    "用户想「先谱曲 / 先出 MIDI / 要能改的曲子 / 先听听再决定要不要 AI 唱」时：",
    "`createMusicJob({workflow:'compose', source:{kind:'prompt', prompt, note, instrumental}, reviewMode})`",
    "流程：`getMusicScoreGuide` 读 scoremill 指南 → 分析用户想法 → **用用户的语言把方案（曲风 / 调性 / BPM / 段落表 / 配器 / 主题 / 力度弧）输出给用户看** → `saveMusicScorePlan` → manual 模式停下等确认 → 写 `compose.py`（scoremill）→ `runMusicScore({jobId,title,plan,script})`（本地免费）→ 把 `openUrl` 贴给用户试听 → 有修改意见就再 `runMusicScore`（`basedOn` 指上一版，每版都保留）。",
    "只有用户**明确要求**「用 Suno 生成正式版 / 交给 Suno」时才调 `submitMusicScoreToSuno`：★真实计费。Suno 不接受 MIDI 原文件，但接受音频，所以「MIDI → 渲染音频 → 上传 cover」才是正确链路；结果不会逐音一致。若 Suno 判定版权，返回 `needsCopyrightConsent`，用户确认后传 `copyrightAudio:true` 走付费版权通道。",
    "谱曲脚本只做记谱：必须 `s.save('score.mid')`；不要自己渲染音频、不要联网。报错按 scoremill 小节号只改那一处，最多重试 3 次。",
    "谱曲依赖本机 Python 3 + scoremill；缺了会在 `getConfig().musicScoreStatus` / `testMusicScore` 里说明。谱曲不需要谱乐 AI Key，交 Suno 才需要。"
  ].join("\n"),

  sfx: [
    "## 流程（火山引擎 Seed-Audio，每次生成真实计费）",
    "先 `game_material({action:\"intake\", module:\"sfx\"})` 问清「要什么声音 / 要不要参考」与审核模式。",
    "`createSfxJob({name,prompt,settings:{format,sampleRate,speechRate?,loudnessRate?,pitchRate?,watermark?},reviewMode})` →（可选）上传参考 → `runSfxGeneration({jobId})`（★每次真实计费）→ `action:\"wait\"` → `action:\"review\"` → 把 `openUrl` 原样贴成 Markdown 链接。",
    "",
    "## 方法",
    "- `listSfxJobs()` / `createSfxJob({name,prompt,settings?,reviewMode?})` / `getSfxJob({jobId})` / `saveSfxJob({jobId,name?,prompt?,settings?,reviewMode?})` / `deleteSfxJob({jobId})`",
    "- `uploadSfxRef({jobId,kind:image|audio,name?,data})`【参考图 1 张 / 参考音频 ≤3 条，两者互斥，单文件 ≤10MB】/ `removeSfxRef({jobId,kind,file?})`",
    "- `runSfxGeneration({jobId})`【★计费：同步接口，宿主包成后台任务；一次一条 take，失败不自动重试】/ `cancelSfxGeneration({jobId})`【只停本地请求，远端可能仍会完成并计费】",
    "- `setSfxApproved({jobId,stage?:generate|export,approved})` / `revealSfxJob({jobId})` / `exportSfx({jobId,takeId?,zip?})`",
    "",
    "## 提示词与参考",
    "提示词要写成**导演脚本**：声源 + 环境 + 强度 / 节奏 + 时长（例如「暴雨中的金属撞击，短促有力，约 1 秒，带一点尾音」）。单次输出上限 120 秒；没有 duration 参数。",
    "参考图最多 1 张；参考音频最多 3 条（每条 ≤30 秒 / ≤10MB），提示词里用 `@音频1…@音频3` 引用；**参考图与参考音频不能同时用**。",
    "一次生成 = 一条 take，永不覆盖；再生成一条会再计费。失败不自动重试，重试前先问用户。manual 模式生成后先贴链接并停下等用户说「通过」；auto 模式自己核对后继续。",
    "`seed-audio-1.0` 需要在火山引擎语音控制台开通；Key 是语音控制台的 API Key（`X-Api-Key`），不是火山方舟的 `ARK_API_KEY`。"
  ].join("\n")
};

const AI_ASSET_TEXT = [
  "# 地图编辑器「AI 生成素材」自动任务",
  "",
  "这是「地图编辑器 → 素材 → AI 生成素材」自动发起的一次任务：需求里已经带了目标地图项目 id、素材名字、动画帧数、生成方式、素材主题与画法要求。",
  "**不要再调用 intake 追问、不要停下来等确认**，直接做完；审核模式按那段话里写的（通常是 auto）。",
  "",
  "## 第一步 · 定这块素材怎么用（普通 / 整格 / 拼块 / 整图；需求里没指定时才由你判断）",
  "- `a2quad` 拼块 — 成片铺开、边缘要自动接上：草地 / 水面 / 沙地 / 岩浆 / 雪地 / 石地。每个变体只画**一块**无缝材质（四边能接上自己），5 种形状与边缘收口由宿主从这一块砖拼出来。",
  "- `corner16` 整格 — 要连成一条、拐角要对上：墙 / 路 / 栅栏 / 桥 / 管道。只画**一块**无缝墙砖（整张图就是这一块，不要分格），16 种接法与断口收口由宿主从这一块砖拼出来。整格没有帧这一维。",
  "- `plain` 普通 — 一块一块单独摆、不跟邻居接：树 / 箱子 / 道具 / 装饰。每张 = 一格内容；多张 = 翻页图。",
  "- `stamp` 整图 — 一张画占好几格的多格建筑 / 装饰：雕像 / 壁画 / 喷泉 / 大门 / 摊位 / 地毯。背景必须纯绿幕，只画本体、不要画地面 / 天空。",
  "整格 / 拼块都只画**一块无缝砖**（不要画多格排布，也不要在砖里画边框 / 收口），怎么拼由宿主做。",
  "",
  "## 第二步 · 规划生图",
  "帧数 1 或「生图模型」→ 图片生成 count:N（N = 帧数；拼块时 N = 变体数）。",
  "「视频模型」→ 先图片生成 count:1 当首帧，再序列帧 upload(firstFrame) → runSequenceVideo → runSequenceFrames count:N。",
  "所有远程方法都通过 `game_material({action:\"call\", method:\"<方法名>\", payload:{…}})` 调用；`wait` / `upload` 用同工具的对应 action。",
  "",
  "## 第三步 · 生成（新语法速查）",
  "1. 静态或生图模型：`createImageJob({name})` → `saveImageJob({jobId,prompt})` → `runImageJob({jobId,count})` → `action:\"wait\"`；",
  "2. 视频模型：先 `createImageJob` / `runImageJob({count:1})` 出首帧 → `action:\"upload\"`（module=sequence, kind=firstFrame）→ `runSequenceVideo` → `runSequenceFrames` → `action:\"wait\"`；",
  "3. `getImageJob` / `getSequenceJob` 返回 `dir`；图片绝对路径 = `dir + \"/\" + items[i].file`，帧绝对路径 = `dir + \"/\" + frames.files[i]`。",
  "",
  "## 第四步 · 整理并回链",
  "`game_material({action:\"call\", method:\"composeMapAsset\", payload:{projectId,name,files:[绝对路径…],shape:'plain|corner16|a2quad|stamp', stampCols?, stampRows?}})`。",
  "- 宿主按形态把这一块砖拼成地图编辑器要的几何；`composeMapAsset` **只整理、不进素材列表**；",
  "- 返回的 `openUrl` 会打开地图编辑器的「新增素材」并按形态预填，用户点「确定」才真的导入；",
  "- 把 `openUrl` 原样贴成 Markdown 链接。",
  "- 如果 `notes` 说「这块砖自己接不上自己」，**不要**自动重跑（重跑要花真钱）：照常贴链接，并在回答里原样告诉用户，让他决定。",
  "",
  "## 画法要求",
  "- 细节不能小于一格的 1/4；砖块这类重复单元一格最多排 3/4/5 排；一格 ≤32px 时直接劝用户改用 64px 网格再生成。",
  "- 普通 / 拼块 / 整格：内容铺满、不留边、不要绿幕、不要自己抠像；",
  "- 整图：纯绿幕（#00FF00 饱和纯绿、一整片、不要渐变 / 阴影 / 纹理），只画本体，不要地面 / 草地 / 道路 / 天空；绿幕由 `composeMapAsset` 抠，**不要**为了抠图再跑一次 keyImageJob。",
  "",
  "## 审核",
  "auto 模式：自己核对；失败只重跑失败的那一步。manual 模式：每步产出后贴 `openUrl` 并停下等用户说「通过」。"
].join("\n");

export function buildGuide(topic: GuideTopic, options: GuideOptions): GuideResult {
  if (topic === "overview") return { title: "游戏素材大师 · 总览", text: overviewText(options) };
  if (topic === "workflow") return { title: "游戏素材大师 · 固定流程", text: workflowText() };
  if (topic === "config") return { title: "游戏素材大师 · 配置", text: configText(options) };
  if (topic === "methods") return { title: "游戏素材大师 · 方法目录", text: methodsText(options) };
  if (topic === "ai-asset") return { title: "游戏素材大师 · AI 生成素材", text: AI_ASSET_TEXT };
  return { title: `游戏素材大师 · ${options.labels[topic]}`, text: moduleText(topic, options) };
}
