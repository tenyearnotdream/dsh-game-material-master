/**
 * 项目持久化。
 *
 * 每个项目一个目录：`${DSH_HOME}/game-material-master/projects/<id>/`
 *
 *   project.json          项目状态（本文件的 Project 结构）
 *   source/               用户上传的源图
 *   images/<方向>.png     八张绿幕图
 *   videos/<方向>.mp4     八段视频
 *   frames/<方向>/*.png   抽出来的原始绿幕帧
 *   keyed/<方向>/*.png    抠完绿幕的帧
 *   preview/<方向>.png    方向预览带（帧横向拼接）
 *   out/sheet.png         最终整图
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "./jsonio.js";
import {
  DEFAULT_TURN_PROMPT,
  DEFAULT_VIDEO_PROMPT,
  DIRECTION_KEYS,
  DEFAULT_ROW_ORDER,
  TURN_FRAME_COUNT_DEFAULT,
  TURN_DIRECTION_DEFAULT,
  TURN_FRAME_COUNT_MAX,
  TURN_FRAME_COUNT_MIN,
  defaultImagePrompts,
  defaultTurnPicks,
  type TurnDirection
} from "./directions.js";
import { DEFAULT_CONFIG, ROW_ORDER_VERSION, isLegacyRowOrder, loadConfig, projectsRoot, type Config } from "./config.js";
import {
  BUILTIN_ACTIONS,
  defaultActions,
  findAction,
  normalizeMotionMode,
  type ActionDef,
  type ActionKind,
  type MotionMode
} from "./actions.js";

export type NodeStatus = "empty" | "running" | "ready" | "error";
export type StageKey = "images" | "videos" | "frames" | "sheet";

/**
 * 视频任务的执行后端：MiniMax 云服务，或本机 ComfyUI。
 *
 * 节点的 `taskId` 在两个后端里都是字符串（MiniMax 是 task_id，ComfyUI 是 prompt_id），
 * 单看 id 分不出是谁家的，所以要把后端一起记在节点上。
 */
export type VideoBackend = "minimax" | "comfy" | "toapis";

/**
 * 阶段①「八方向绿幕图」的生成方式。
 *
 *   turn   （默认）先让视频模型绕竖轴转一整圈，再按时间轴截出八个方向的帧。
 *          八个方向出自**同一段视频**，一致性远好于八次独立生图。
 *   direct 沿用原来的「逐方向 Seedream 生图」：每个方向一张图、按依赖顺序生成。
 *
 * 两种方式产出的是**同一批产物**（`images/<方向>.png`），所以下游
 * （行走视频 → 抽帧 → 整图）完全不必知道用的是哪一种。
 */
export type ImageMode = "turn" | "direct";

/** 每个项目一条读-改-写串行链，见 patchProject。 */
const locks = new Map<string, Promise<unknown>>();

export interface ImageNode {
  status: NodeStatus;
  /** 相对项目目录的路径。 */
  file?: string;
  approved: boolean;
  error?: string;
  model?: string;
  elapsedMs?: number;
  updatedAt?: number;
  /** 它所依赖的参考图被重新生成过，需要重新生成本节点。 */
  stale?: boolean;
}

export interface VideoNode {
  status: NodeStatus;
  taskId?: string;
  /**
   * 这个任务是在哪个后端上跑的。查询时必须按**这里记的值**，不能按当前配置：
   * 用户可以在任务跑着的时候改设置。老数据没有这个字段 → 按 minimax 处理。
   */
  backend?: VideoBackend;
  remoteStatus?: string;
  file?: string;
  approved: boolean;
  error?: string;
  elapsedMs?: number;
  updatedAt?: number;
  /**
   * 这段视频是哪来的：`remote`（MiniMax 生成，缺省）还是 `local`
   * （用户在界面上自己选的本地视频）。两条路的产物完全同形，下游只看 `file`，
   * 这个字段只用来在界面上说清楚「这段不是我生成的」，以及排查时能一眼看出。
   */
  origin?: "remote" | "local";
  /** 本地视频的原始文件名（只用于界面显示）。 */
  originalName?: string;
}

export interface FramesNode {
  status: NodeStatus;
  /** 原始绿幕帧（相对路径）。 */
  frames: string[];
  /** 抠完绿幕的帧（相对路径）。 */
  keyed: string[];
  strip?: string;
  duration?: number;
  approved: boolean;
  error?: string;
  updatedAt?: number;
  /** 原始 RGBA 缓存（相对路径）：抠像参数可反复调整而无需重新解码视频。 */
  raw?: string;
  /** 抽帧工作尺寸或裁剪参数被改过，需要重新抽帧（raw.bin 已作废）。 */
  stale?: boolean;
  /** raw.bin 里每帧的像素尺寸（抽帧时的工作尺寸）。 */
  rawWidth?: number;
  rawHeight?: number;
  rawFrameCount?: number;
  /**
   * 手动选帧：把这一段行走视频匀抽成候选帧，再用圆圈挑出要进序列帧的那几张。
   * 没有它时，序列帧来自「整段等分」的 `runFrames`。
   */
  candidates?: FrameCandidates;
}

/** 某一个方向的行走视频候选帧，以及输出序列帧各自落在哪一张上。 */
export interface FrameCandidates {
  status: NodeStatus;
  /** 候选帧（绿幕原图）相对路径，按时间顺序。 */
  frames: string[];
  /** 每一张候选帧对应的时间（秒）。 */
  times: number[];
  raw?: string;
  rawWidth?: number;
  rawHeight?: number;
  rawFrameCount?: number;
  duration?: number;
  /** 整段视频的缩略条带，圆圈对着它拖。 */
  strip?: string;
  /** 输出帧各自对应的候选帧下标。长度等于项目的「每段视频抽帧数」。 */
  picks: number[];
  error?: string;
  stale?: boolean;
  updatedAt?: number;
}

export interface SheetState {
  status: NodeStatus;
  file?: string;
  thumb?: string;
  approved: boolean;
  error?: string;
  width?: number;
  height?: number;
  generatedAt?: number;
  /**
   * 生成这张整图时**实际使用**的行序、格子尺寸与帧数。
   *
   * 消费者（行走预览、外部工具）必须按这里记的值去切图，不能按当前 settings：
   * 用户改了行序而整图还没重新合成时，两者会不一致，按 settings 切就会取错行。
   */
  rowOrder?: string[];
  cellWidth?: number;
  cellHeight?: number;
  frameCount?: number;
  /**
   * 这次合成里被判为背景的像素占比（各方向各帧的平均值）。
   * 拿去和「绿幕该占多少」对一眼，就能发现抠像是不是跑偏了。
   */
  backgroundFraction?: number;
  /** 边框采样点里因「不属于背景主色」被排除的数量（各帧之和）。 */
  borderSamplesDropped?: number;
  /** 边框采样点总数（各帧之和）。 */
  borderSamples?: number;
}

export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

/** 转圈视频（整个转圈模式只有这一段视频，八方向共用）。 */
export interface TurnVideoNode {
  status: NodeStatus;
  taskId?: string;
  /** 见 VideoNode.backend。 */
  backend?: VideoBackend;
  remoteStatus?: string;
  file?: string;
  approved: boolean;
  error?: string;
  /**
   * 这一段视频用的首帧（相对路径）。转圈模式的输入是**一张图**，
   * 记下来才知道「模型到底看到的是哪张」——排查「第一帧就不是正面」时全靠它。
   */
  firstFrame?: string;
  elapsedMs?: number;
  updatedAt?: number;
  /** 见 `VideoNode.origin`：本地自选的转圈视频同样落这个字段。 */
  origin?: "remote" | "local";
  /** 本地视频的原始文件名（只用于界面显示）。 */
  originalName?: string;
}

/**
 * 候选帧：把转圈视频按时长匀抽出来的整圈切片，以及八个方向各自选了哪一帧。
 *
 * 抽完就落一份 `raw.bin`（RGBA 缓存），拖动圆圈重截时只读这份缓存——
 * 改一个截帧位置不必重新解码视频，是「拖着玩」能成立的前提。
 */
export interface TurnFramesState {
  status: NodeStatus;
  /** 候选帧（绿幕原图）相对路径，按时间顺序。 */
  frames: string[];
  /** 每一帧对应的时间（秒），用于在轴上标时刻。 */
  times: number[];
  raw?: string;
  rawWidth?: number;
  rawHeight?: number;
  rawFrameCount?: number;
  duration?: number;
  /** 八个方向各自选中的候选帧下标（0 … frames.length-1）。 */
  picks: Record<string, number>;
  /** 整条时间轴的缩略条带（轴上的圆圈就是对着它拖的）。 */
  strip?: string;
  approved: boolean;
  error?: string;
  /** 候选帧数 / 抽帧参数变过，需要重新抽帧（raw.bin 已作废）。 */
  stale?: boolean;
  updatedAt?: number;
}

export interface TurnState {
  video: TurnVideoNode;
  frames: TurnFramesState;
  /** 转圈方向：只决定「默认的八个位置」怎么排，用户拖过之后以 picks 为准。 */
  direction: TurnDirection;
}

/** 项目级的流水线参数快照：创建时从全局配置拷贝，之后可单独覆盖。 */
export interface ProjectSettings {
  cellWidth: number;
  cellHeight: number;
  frameCount: number;
  fitMode: "contain" | "stretch";
  workingLongEdge: number;
  pixelSize: number;
  autoCrop: boolean;
  fillRatio: number;
  bottomMargin: number;
  cropInset: number;
  keyLow: number;
  keyHigh: number;
  despill: number;
  bgTolerance: number;
  edgeShrink: number;
  rowOrder: string[];
  /** 行序语义版本，见 config.ts 的 ROW_ORDER_VERSION。 */
  rowOrderVersion: number;
  concurrency: number;
  /**
   * 转圈模式抽多少张候选帧（决定时间轴的分辨率，即每个方向能落到多细的朝向上）。
   * 这是**项目级**参数、不进全局配置：它只影响轴上的拖动粒度，
   * 换项目重置一次完全合理，放进全局设置反而多一层「改了没生效」的疑惑。
   */
  turnFrameCount: number;
}

/** 审核模式：agent 自动审 / 每一步人工审。见 src/tools.ts 的固定流程。 */
export type ReviewMode = "auto" | "manual";

/**
 * 「关键帧转圈」流水线里，某一个关键帧自己的一条转圈任务。
 *
 * 与项目级的 `turn`（阶段① 生成八方向图用的那一圈）结构相似但**互相独立**：
 * 那一条产出 `images/<方向>.png`（角色的基准朝向图），这一条产出
 * `actions/<动作>/k<i>/<方向>.png`（某个动作某一帧的八方向），绝不能混。
 */
export interface SeedTurnNode {
  status: NodeStatus;
  taskId?: string;
  backend?: VideoBackend;
  remoteStatus?: string;
  error?: string;
  /** 这一圈的视频（相对路径）。 */
  file?: string;
  /** 候选帧（相对路径，按时间顺序）。 */
  frames: string[];
  raw?: string;
  rawWidth?: number;
  rawHeight?: number;
  duration?: number;
  /** 八个方向各自的截帧下标。 */
  picks: Record<string, number>;
  /** 八个方向切出来的图（方向 key → 相对路径）。 */
  directions: Record<string, string>;
  updatedAt?: number;
}

/**
 * 关键帧模式（一次性动作）的全部状态。
 *
 * 流程：母本动作视频 → 抽候选帧 → 选 N 张关键帧 → 每个关键帧各转一圈 →
 * 得到「8 方向 × N 关键帧」的矩阵。全方向共享同一批关键帧，节奏天然对齐。
 */
export interface SeedState {
  /** 母本动作视频（只有一段，从 `baseDirection` 方向图生成）。 */
  video: VideoNode;
  /** 母本视频抽出的候选帧（相对路径）。 */
  candidates: string[];
  raw?: string;
  rawWidth?: number;
  rawHeight?: number;
  duration?: number;
  /** 被选中作为关键帧的候选下标（长度 = 矩阵列数）。 */
  keyframes: number[];
  /** 关键帧 → 它那一圈转圈（key 形如 "k0"）。 */
  turns: Record<string, SeedTurnNode>;
}

/**
 * 切到别的动作时，把当前动作的工作区整份存进 `actionArchive`。
 *
 * 这里刻意**包含 prompts.video**：每个动作的提示词都可以单独改过，
 * 切回该动作时要还原成它自己那份，而不是别的动作的提示词。
 */
export interface ActionWorkspace {
  videos: Record<string, VideoNode>;
  frames: Record<string, FramesNode>;
  sheet: SheetState;
  videoPrompt: string;
  videoPerDirection: Record<string, string>;
  motionMode: MotionMode;
  seed: SeedState;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source: { file: string; name: string } | null;
  prompts: {
    /** 每个方向一份生图提示词（已把 {facing} 展开）。 */
    images: Record<string, string>;
    /** 视频提示词，八个方向共用。 */
    video: string;
    /** 转圈模式的旋转视频提示词（整个转圈模式只有这一份）。 */
    turn: string;
    /** 视频提示词是否按方向单独覆盖。 */
    videoPerDirection: Record<string, string>;
    /**
     * 统一附加提示词：非空时会被追加到**每一张**生图提示词末尾。
     * 用来写跨方向的共同注意事项（例如「必须穿同一双靴子」「不要出现文字」），
     * 改一次就全部生效，不必逐个方向去改。
     */
    suffix: string;
  };
  images: Record<string, ImageNode>;
  videos: Record<string, VideoNode>;
  frames: Record<string, FramesNode>;
  sheet: SheetState;
  settings: ProjectSettings;
  /**
   * 阶段①的生成方式（`turn` 默认 / `direct` 备选）。
   *
   * 切换只影响「怎么产出 `images/*.png`」这一层：已产出的图不会被删，
   * 另一条路重跑一次就换过来了。
   */
  imageMode: ImageMode;
  /** 转圈模式的全部状态（视频 + 候选帧 + 八个截帧位置）。 */
  turn: TurnState;
  /**
   * 动作库（内置 + 自定义）。选中哪个动作，下面 `videos/frames/sheet` 就是哪个的产物。
   */
  actions: ActionDef[];
  /** 当前动作 id。 */
  activeActionId: string;
  /**
   * 非当前动作的产物存档。切动作时「存旧的、取新的」，
   * 所以走路与攻击的产物互不覆盖，切回来还是原样。
   */
  actionArchive: Record<string, ActionWorkspace>;
  /** 当前动作走哪条流水线：八方向独立视频 / 关键帧转圈。 */
  motionMode: MotionMode;
  /** 关键帧模式的母本动作与逐个关键帧的转圈。 */
  seed: SeedState;
  /**
   * 固定流程里问过用户的审核模式；没问过就是 undefined。
   * `manual` = 每一步产出后都停下来等用户打「通过」再继续。
   */
  reviewMode?: ReviewMode;
  log: LogEntry[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  hasSource: boolean;
  /** 阶段①用的是哪种生成方式，列表里据此标一下。 */
  imageMode: ImageMode;
  imageReady: number;
  videoReady: number;
  framesReady: number;
  sheetReady: boolean;
}

export function projectDir(id: string): string {
  return join(projectsRoot(), id);
}

export function projectFile(id: string): string {
  return join(projectDir(id), "project.json");
}

/** 把项目内的相对路径解析成绝对路径，并挡住目录穿越。 */
export function assetPath(id: string, relative: string): string {
  const base = resolve(projectDir(id));
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`非法的项目内路径：${relative}`);
  }
  return target;
}

export function settingsFromConfig(config: Config, rowOrder?: string[]): ProjectSettings {
  return {
    cellWidth: config.cellWidth,
    cellHeight: config.cellHeight,
    frameCount: config.frameCount,
    fitMode: config.fitMode,
    workingLongEdge: config.workingLongEdge,
    pixelSize: config.pixelSize,
    autoCrop: config.autoCrop,
    fillRatio: config.fillRatio,
    bottomMargin: config.bottomMargin,
    cropInset: config.cropInset,
    keyLow: config.keyLow,
    keyHigh: config.keyHigh,
    despill: config.despill,
    bgTolerance: config.bgTolerance,
    edgeShrink: config.edgeShrink,
    rowOrder: rowOrder ?? (config.rowOrder.length > 0 ? [...config.rowOrder] : [...DEFAULT_ROW_ORDER]),
    rowOrderVersion: ROW_ORDER_VERSION,
    concurrency: config.concurrency,
    turnFrameCount: TURN_FRAME_COUNT_DEFAULT
  };
}

function emptyImages(): Record<string, ImageNode> {
  const out: Record<string, ImageNode> = {};
  for (const key of DIRECTION_KEYS) out[key] = { status: "empty", approved: false };
  return out;
}

/** 八方向的默认截帧位置（转圈方向决定它们的先后）。 */
export function freshPicks(frameCount: number, direction: TurnDirection = TURN_DIRECTION_DEFAULT): Record<string, number> {
  return defaultTurnPicks(frameCount, direction);
}

function emptyTurn(frameCount = TURN_FRAME_COUNT_DEFAULT): TurnState {
  return {
    video: { status: "empty", approved: false },
    frames: { status: "empty", frames: [], times: [], picks: freshPicks(frameCount), approved: false },
    direction: TURN_DIRECTION_DEFAULT
  };
}

function emptyVideos(): Record<string, VideoNode> {
  const out: Record<string, VideoNode> = {};
  for (const key of DIRECTION_KEYS) out[key] = { status: "empty", approved: false };
  return out;
}

function emptyFrames(): Record<string, FramesNode> {
  const out: Record<string, FramesNode> = {};
  for (const key of DIRECTION_KEYS) out[key] = { status: "empty", frames: [], keyed: [], approved: false };
  return out;
}

/** 关键帧模式的初始状态：没母本视频、没候选帧、没关键帧、没转圈。 */
export function emptySeed(): SeedState {
  return {
    video: { status: "empty", approved: false },
    candidates: [],
    keyframes: [],
    turns: {}
  };
}

/** 当前动作的工作区整份快照（切动作时用）。 */
export function snapshotWorkspace(project: Project): ActionWorkspace {
  return {
    videos: project.videos,
    frames: project.frames,
    sheet: project.sheet,
    videoPrompt: project.prompts.video,
    videoPerDirection: { ...(project.prompts.videoPerDirection ?? {}) },
    motionMode: project.motionMode,
    seed: project.seed ?? emptySeed()
  };
}

/** 把一份工作区快照装回项目（没有快照就给初始状态）。 */
export function applyWorkspace(project: Project, workspace: ActionWorkspace | undefined): void {
  const ws = workspace;
  project.videos = ws?.videos ?? emptyVideos();
  project.frames = ws?.frames ?? emptyFrames();
  project.sheet = ws?.sheet ?? { status: "empty", approved: false };
  project.prompts.video = ws?.videoPrompt ?? DEFAULT_VIDEO_PROMPT;
  project.prompts.videoPerDirection = ws?.videoPerDirection ?? {};
  project.seed = ws?.seed ?? emptySeed();
  const action = findAction(project.actions, project.activeActionId);
  project.motionMode = normalizeMotionMode(ws?.motionMode, action.kind);
}

/** 当前动作的定义（永远是有效值）。 */
export function activeAction(project: Project): ActionDef {
  return findAction(project.actions, project.activeActionId);
}

/**
 * 换了源图：把「由源图派生出来的东西」全部作废。
 *
 * 源图是阶段①的输入。换了源图之后，之前那张图跑出来的八个方向图、转圈视频、
 * 候选帧（`turn/raw.bin` 动辄上百 MB）以及阶段②③④的产物全都属于另一个角色。
 * 留着它们不只是占地方——`turnFirstFrame()` 会**优先**拿 `images/front.png` 当首帧，
 * 于是新源图根本进不了模型，表现就是「换了源图，生成结果一点没变」。
 *
 * 所以这里一律清回初始状态，并删掉对应的磁盘文件（删不掉的忽略，不影响主流程）。
 * 返回被清掉的产物个数，供调用方记日志。
 */
export async function resetDerivedFromSource(id: string): Promise<number> {
  const orphans = await patchProject(id, (project) => {
    const files: string[] = [];
    const push = (file?: string): void => {
      if (file !== undefined && file !== "") files.push(file);
    };
    for (const key of DIRECTION_KEYS) push(project.images[key]?.file);
    push(project.turn?.video?.file);
    push(project.turn?.frames?.raw);
    push(project.turn?.frames?.strip);
    for (const file of project.turn?.frames?.frames ?? []) push(file);
    for (const key of DIRECTION_KEYS) {
      push(project.videos[key]?.file);
      const frames = project.frames[key];
      if (frames === undefined) continue;
      push(frames.raw);
      push(frames.strip);
      for (const file of frames.frames) push(file);
      for (const file of frames.keyed) push(file);
      const candidates = frames.candidates;
      if (candidates === undefined) continue;
      push(candidates.raw);
      push(candidates.strip);
      for (const file of candidates.frames) push(file);
    }
    push(project.sheet?.file);
    push(project.sheet?.thumb);
    // 关键帧模式（母本动作 / 每个关键帧的转圈）与所有动作的存档同样派生自源图，一并作废。
    const pushSeed = (seed: SeedState | undefined): void => {
      if (seed === undefined || seed === null) return;
      push(seed.video?.file);
      push(seed.raw);
      for (const file of seed.candidates ?? []) push(file);
      for (const turn of Object.values(seed.turns ?? {})) {
        push(turn?.file);
        push(turn?.raw);
        for (const file of turn?.frames ?? []) push(file);
        for (const file of Object.values(turn?.directions ?? {})) push(file);
      }
    };
    pushSeed(project.seed);
    for (const workspace of Object.values(project.actionArchive ?? {})) {
      push(workspace?.sheet?.file);
      for (const key of DIRECTION_KEYS) {
        push(workspace?.videos?.[key]?.file);
        push(workspace?.frames?.[key]?.raw);
        for (const file of workspace?.frames?.[key]?.frames ?? []) push(file);
      }
      pushSeed(workspace?.seed);
    }
    project.seed = emptySeed();
    project.actionArchive = {};
    project.images = emptyImages();
    project.videos = emptyVideos();
    project.frames = emptyFrames();
    project.sheet = { status: "empty", approved: false };
    project.turn.video = { status: "empty", approved: false };
    // 抽帧位置回到「候选帧数 ÷ 8」的默认值：旧的 picks 指的是旧视频的帧号，
    // 新视频未必有那么多帧，留着没有意义。转圈方向（cw / ccw）是用户的选择，保留。
    project.turn.frames = {
      status: "empty",
      frames: [],
      times: [],
      picks: freshPicks(project.settings.turnFrameCount),
      approved: false
    };
    if (files.length > 0) {
      log(
        project,
        "warn",
        `换了源图：已作废由旧源图派生的 ${files.length} 个产物（方向图 / 转圈视频 / 候选帧 / 序列帧 / 整图），请重新生成。`
      );
    }
    return files;
  });
  for (const relative of orphans) {
    await rm(assetPath(id, relative), { force: true }).catch(() => undefined);
  }
  return orphans.length;
}

export async function ensureLayout(id: string): Promise<void> {
  const base = projectDir(id);
  for (const sub of ["source", "images", "videos", "frames", "keyed", "preview", "out", "turn", "actions"]) {
    await mkdir(join(base, sub), { recursive: true });
  }
}

export async function createProject(name: string): Promise<Project> {
  const config = await loadConfig();
  const id = `p${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const now = Date.now();
  const settings = settingsFromConfig(config);
  const project: Project = {
    id,
    name: name.trim() === "" ? "未命名项目" : name.trim(),
    createdAt: now,
    updatedAt: now,
    source: null,
    prompts: {
      images: defaultImagePrompts(),
      video: DEFAULT_VIDEO_PROMPT,
      turn: DEFAULT_TURN_PROMPT,
      videoPerDirection: {},
      suffix: ""
    },
    images: emptyImages(),
    videos: emptyVideos(),
    frames: emptyFrames(),
    sheet: { status: "empty", approved: false },
    settings,
    // 新项目默认走转圈截帧：「一致性」比「单张清晰度」更值钱，而八方向图
    // 恰恰最容易在一致性上翻车。逐方向生图保留为备选，随时可切。
    imageMode: "turn",
    turn: emptyTurn(settings.turnFrameCount),
    // 动作库：内置全量开箱即用，默认选中走路（与改造前行为一致）。
    actions: defaultActions(),
    activeActionId: "walk",
    actionArchive: {},
    motionMode: "perDirection",
    seed: emptySeed(),
    log: []
  };
  await ensureLayout(id);
  await writeProject(project);
  return project;
}

export async function readProject(id: string): Promise<Project | undefined> {
  try {
    const text = await readFile(projectFile(id), "utf8");
    return normalizeProject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export async function writeProject(project: Project): Promise<void> {
  project.updatedAt = Date.now();
  const target = projectFile(project.id);
  // Reuse the shared unique-temp + Windows sharing-violation retry path.
  // A transient read/scanner handle must not abort a batch before recording its task.
  await writeJsonAtomic(target, project);
}

export async function deleteProject(id: string): Promise<void> {
  await rm(projectDir(id), { recursive: true, force: true });
}

/**
 * 串行化同一项目的「读-改-写」。
 * mutator 必须是短操作且不要发网络请求——真正耗时的调用要放在锁外，
 * 只把状态变更包进这里，否则并发任务会互相排队。
 */
export function patchProject<T>(id: string, mutator: (project: Project) => T | Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const run = previous.then(async () => {
    const project = await readProject(id);
    if (project === undefined) throw new Error(`项目不存在：${id}`);
    const result = await mutator(project);
    await writeProject(project);
    return result;
  });
  locks.set(
    id,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(projectsRoot(), { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory() && d.name.startsWith("p")).map((d) => d.name);
  } catch {
    return [];
  }
  const summaries: ProjectSummary[] = [];
  for (const id of entries) {
    const project = await readProject(id);
    if (project === undefined) continue;
    summaries.push(summarize(project));
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

export function summarize(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    hasSource: project.source !== null,
    imageMode: project.imageMode,
    imageReady: DIRECTION_KEYS.filter((k) => project.images[k]?.status === "ready").length,
    videoReady: DIRECTION_KEYS.filter((k) => project.videos[k]?.status === "ready").length,
    framesReady: DIRECTION_KEYS.filter((k) => project.frames[k]?.status === "ready").length,
    sheetReady: project.sheet.status === "ready"
  };
}

/** 补齐历史版本缺字段，保证读进来的对象形状永远完整。 */
/**
 * 视频节点的后端标记：只认两个已知值。
 *
 * 老项目 / 手写坏值一律折成 undefined（= 按 minimax 处理），而不是原样带进内存——
 * 一个不认识的字符串会让查询分派悄悄走到「按配置猜」那条路上。
 */
function normalizeVideoBackend(raw: unknown): VideoBackend | undefined {
  return raw === "comfy" || raw === "minimax" || raw === "toapis" ? raw : undefined;
}

function normalizeProject(raw: any): Project {
  const now = Date.now();
  const settings = { ...(raw?.settings ?? {}) };
  const defaults = settingsFromConfig(DEFAULT_CONFIG);
  const merged: ProjectSettings = {
    cellWidth: num(settings.cellWidth, defaults.cellWidth),
    cellHeight: num(settings.cellHeight, defaults.cellHeight),
    frameCount: num(settings.frameCount, defaults.frameCount),
    fitMode: settings.fitMode === "stretch" ? "stretch" : "contain",
    workingLongEdge: num(settings.workingLongEdge, defaults.workingLongEdge),
    pixelSize: num(settings.pixelSize, defaults.pixelSize),
    autoCrop: settings.autoCrop !== false,
    fillRatio: num(settings.fillRatio, defaults.fillRatio),
    bottomMargin: num(settings.bottomMargin, defaults.bottomMargin),
    cropInset: num(settings.cropInset, defaults.cropInset),
    keyLow: num(settings.keyLow, defaults.keyLow),
    keyHigh: num(settings.keyHigh, defaults.keyHigh),
    despill: num(settings.despill, defaults.despill),
    bgTolerance: num(settings.bgTolerance, defaults.bgTolerance),
    edgeShrink: num(settings.edgeShrink, defaults.edgeShrink),
    rowOrder:
      Array.isArray(settings.rowOrder) && settings.rowOrder.length > 0 && !(settings.rowOrderVersion === undefined && isLegacyRowOrder(settings.rowOrder))
        ? settings.rowOrder.map(String)
        : [...DEFAULT_ROW_ORDER],
    rowOrderVersion: ROW_ORDER_VERSION,
    concurrency: num(settings.concurrency, defaults.concurrency),
    turnFrameCount: clampIntSetting(settings.turnFrameCount, defaults.turnFrameCount, TURN_FRAME_COUNT_MIN, TURN_FRAME_COUNT_MAX)
  };

  const images = emptyImages();
  for (const key of DIRECTION_KEYS) {
    const node = raw?.images?.[key];
    if (node !== undefined) images[key] = { ...images[key], ...node, approved: node.approved === true };
  }
  const videos = emptyVideos();
  for (const key of DIRECTION_KEYS) {
    const node = raw?.videos?.[key];
    if (node !== undefined) {
      videos[key] = {
        ...videos[key],
        ...node,
        approved: node.approved === true,
        backend: normalizeVideoBackend(node.backend),
        origin: node.origin === "local" ? "local" : undefined,
        originalName: typeof node.originalName === "string" ? node.originalName : undefined
      };
    }
  }
  const frames = emptyFrames();
  for (const key of DIRECTION_KEYS) {
    const node = raw?.frames?.[key];
    if (node !== undefined) {
      frames[key] = {
        ...frames[key],
        ...node,
        frames: Array.isArray(node.frames) ? node.frames.map(String) : [],
        keyed: Array.isArray(node.keyed) ? node.keyed.map(String) : [],
        approved: node.approved === true,
        stale: node.stale === true,
        candidates: normalizeFrameCandidates(node.candidates)
      };
    }
  }

  const defaultPrompts = defaultImagePrompts();
  const images_prompts: Record<string, string> = {};
  for (const key of DIRECTION_KEYS) {
    const value = raw?.prompts?.images?.[key];
    images_prompts[key] = typeof value === "string" && value.trim() !== "" ? value : defaultPrompts[key];
  }

  const imageMode = deriveImageMode(raw);

  return {
    id: String(raw?.id ?? ""),
    name: typeof raw?.name === "string" && raw.name.trim() !== "" ? raw.name : "未命名项目",
    createdAt: num(raw?.createdAt, now),
    updatedAt: num(raw?.updatedAt, now),
    source: raw?.source?.file ? { file: String(raw.source.file), name: String(raw.source.name ?? "source") } : null,
    prompts: {
      images: images_prompts,
      video: typeof raw?.prompts?.video === "string" && raw.prompts.video.trim() !== "" ? raw.prompts.video : DEFAULT_VIDEO_PROMPT,
      turn: typeof raw?.prompts?.turn === "string" && raw.prompts.turn.trim() !== "" ? raw.prompts.turn : DEFAULT_TURN_PROMPT,
      videoPerDirection:
        raw?.prompts?.videoPerDirection !== null && typeof raw?.prompts?.videoPerDirection === "object"
          ? { ...raw.prompts.videoPerDirection }
          : {},
      suffix: typeof raw?.prompts?.suffix === "string" ? raw.prompts.suffix : ""
    },
    images,
    videos,
    frames,
    sheet: {
      status: raw?.sheet?.status ?? "empty",
      file: raw?.sheet?.file,
      thumb: raw?.sheet?.thumb,
      approved: raw?.sheet?.approved === true,
      error: raw?.sheet?.error,
      width: raw?.sheet?.width,
      height: raw?.sheet?.height,
      generatedAt: raw?.sheet?.generatedAt,
      rowOrder: Array.isArray(raw?.sheet?.rowOrder) ? raw.sheet.rowOrder.map(String) : undefined,
      cellWidth: raw?.sheet?.cellWidth,
      cellHeight: raw?.sheet?.cellHeight,
      frameCount: raw?.sheet?.frameCount,
      backgroundFraction: typeof raw?.sheet?.backgroundFraction === "number" ? raw.sheet.backgroundFraction : undefined,
      borderSamplesDropped: typeof raw?.sheet?.borderSamplesDropped === "number" ? raw.sheet.borderSamplesDropped : undefined,
      borderSamples: typeof raw?.sheet?.borderSamples === "number" ? raw.sheet.borderSamples : undefined
    },
    settings: merged,
    imageMode,
    turn: normalizeTurn(raw?.turn, merged.turnFrameCount),
    actions: normalizeActions(raw?.actions),
    activeActionId: normalizeActiveActionId(raw),
    actionArchive: normalizeArchive(raw?.actionArchive),
    motionMode: normalizeMotionMode(raw?.motionMode, findAction(normalizeActions(raw?.actions), normalizeActiveActionId(raw)).kind),
    seed: normalizeSeed(raw?.seed),
    reviewMode: raw?.reviewMode === "manual" ? "manual" : raw?.reviewMode === "auto" ? "auto" : undefined,
    log: Array.isArray(raw?.log) ? raw.log.slice(-200) : []
  };
}

/**
 * 动作库归一化。
 *
 * 老项目没有 `actions` 字段 → 直接给内置全量（含走路），不迁移也要能打开。
 * 已有动作的项目：内置动作**永远补全**（新版本加了新内置动作时老项目也能看到），
 * 自定义动作按存档原样保留。
 */
function normalizeActions(raw: any): ActionDef[] {
  const builtins = defaultActions();
  if (!Array.isArray(raw) || raw.length === 0) return builtins;
  const seen = new Set<string>();
  const out: ActionDef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const builtin = builtins.find((action) => action.id === id);
    const kind: ActionKind = item.kind === "loop" ? "loop" : item.kind === "oneshot" ? "oneshot" : builtin?.kind ?? "oneshot";
    const count = Number(item.keyframeCount);
    out.push({
      id,
      label: typeof item.label === "string" && item.label.trim() !== "" ? item.label.trim() : builtin?.label ?? id,
      labelEn: typeof item.labelEn === "string" && item.labelEn.trim() !== "" ? item.labelEn.trim() : builtin?.labelEn ?? id,
      prompt: typeof item.prompt === "string" && item.prompt.trim() !== "" ? item.prompt : builtin?.prompt ?? DEFAULT_VIDEO_PROMPT,
      promptEn:
        typeof item.promptEn === "string" && item.promptEn.trim() !== "" ? item.promptEn : builtin?.promptEn ?? item.prompt ?? "",
      kind,
      keyframeCount: Number.isFinite(count) ? Math.min(24, Math.max(2, Math.round(count))) : builtin?.keyframeCount ?? 6,
      builtin: builtin !== undefined
    });
  }
  // 缺哪个内置动作就补哪个（放在前面，顺序与 BUILTIN_ACTIONS 一致）。
  for (const action of BUILTIN_ACTIONS) {
    if (!seen.has(action.id)) out.unshift({ ...action });
  }
  // 内置动作按 BUILTIN_ACTIONS 的顺序排在前面，自定义动作按加入顺序跟在后面。
  const order = new Map(BUILTIN_ACTIONS.map((action, index) => [action.id, index]));
  const builtinPart = out.filter((action) => action.builtin).sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  const customPart = out.filter((action) => !action.builtin);
  return [...builtinPart, ...customPart];
}

function normalizeActiveActionId(raw: any): string {
  const id = typeof raw?.activeActionId === "string" ? raw.activeActionId.trim() : "";
  return id === "" ? "walk" : id;
}

function normalizeArchive(raw: any): Record<string, ActionWorkspace> {
  if (raw === null || typeof raw !== "object") return {};
  const out: Record<string, ActionWorkspace> = {};
  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    if (value === null || typeof value !== "object") continue;
    const videos = emptyVideos();
    for (const key of DIRECTION_KEYS) {
      const node = value.videos?.[key];
      if (node !== undefined) videos[key] = { ...videos[key], ...node, approved: node.approved === true };
    }
    const frames = emptyFrames();
    for (const key of DIRECTION_KEYS) {
      const node = value.frames?.[key];
      if (node !== undefined) {
        frames[key] = {
          ...frames[key],
          ...node,
          frames: Array.isArray(node.frames) ? node.frames.map(String) : [],
          keyed: Array.isArray(node.keyed) ? node.keyed.map(String) : [],
          approved: node.approved === true,
          stale: node.stale === true
        };
      }
    }
    out[id] = {
      videos,
      frames,
      sheet: value.sheet ?? { status: "empty", approved: false },
      videoPrompt: typeof value.videoPrompt === "string" && value.videoPrompt.trim() !== "" ? value.videoPrompt : DEFAULT_VIDEO_PROMPT,
      videoPerDirection:
        value.videoPerDirection !== null && typeof value.videoPerDirection === "object" ? { ...value.videoPerDirection } : {},
      motionMode: normalizeMotionMode(value.motionMode),
      seed: normalizeSeed(value.seed)
    };
  }
  return out;
}

function normalizeSeedTurn(raw: any): SeedTurnNode {
  const picks: Record<string, number> = {};
  for (const key of DIRECTION_KEYS) {
    const value = Number(raw?.picks?.[key]);
    picks[key] = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }
  const directions: Record<string, string> = {};
  for (const key of DIRECTION_KEYS) {
    const value = raw?.directions?.[key];
    if (typeof value === "string" && value !== "") directions[key] = value;
  }
  return {
    status: raw?.status ?? "empty",
    taskId: typeof raw?.taskId === "string" ? raw.taskId : undefined,
    backend: normalizeVideoBackend(raw?.backend),
    remoteStatus: typeof raw?.remoteStatus === "string" ? raw.remoteStatus : undefined,
    error: typeof raw?.error === "string" ? raw.error : undefined,
    file: typeof raw?.file === "string" ? raw.file : undefined,
    frames: Array.isArray(raw?.frames) ? raw.frames.map(String) : [],
    raw: typeof raw?.raw === "string" ? raw.raw : undefined,
    rawWidth: typeof raw?.rawWidth === "number" ? raw.rawWidth : undefined,
    rawHeight: typeof raw?.rawHeight === "number" ? raw.rawHeight : undefined,
    duration: typeof raw?.duration === "number" ? raw.duration : undefined,
    picks,
    directions,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : undefined
  };
}

function normalizeSeed(raw: any): SeedState {
  const video = raw?.video;
  const turns: Record<string, SeedTurnNode> = {};
  if (raw?.turns !== null && typeof raw?.turns === "object") {
    for (const [key, value] of Object.entries(raw.turns as Record<string, any>)) turns[key] = normalizeSeedTurn(value);
  }
  return {
    video: {
      status: video?.status ?? "empty",
      approved: video?.approved === true,
      taskId: typeof video?.taskId === "string" ? video.taskId : undefined,
      backend: normalizeVideoBackend(video?.backend),
      remoteStatus: typeof video?.remoteStatus === "string" ? video.remoteStatus : undefined,
      file: typeof video?.file === "string" ? video.file : undefined,
      error: typeof video?.error === "string" ? video.error : undefined,
      updatedAt: typeof video?.updatedAt === "number" ? video.updatedAt : undefined
    },
    candidates: Array.isArray(raw?.candidates) ? raw.candidates.map(String) : [],
    raw: typeof raw?.raw === "string" ? raw.raw : undefined,
    rawWidth: typeof raw?.rawWidth === "number" ? raw.rawWidth : undefined,
    rawHeight: typeof raw?.rawHeight === "number" ? raw.rawHeight : undefined,
    duration: typeof raw?.duration === "number" ? raw.duration : undefined,
    keyframes: Array.isArray(raw?.keyframes)
      ? raw.keyframes.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value) && value >= 0)
      : [],
    turns
  };
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFrameCandidates(raw: any): FrameCandidates | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  return {
    status: raw.status ?? "empty",
    frames: Array.isArray(raw.frames) ? raw.frames.map(String) : [],
    times: Array.isArray(raw.times) ? raw.times.map((value: unknown) => num(value, 0)) : [],
    raw: typeof raw.raw === "string" ? raw.raw : undefined,
    rawWidth: typeof raw.rawWidth === "number" ? raw.rawWidth : undefined,
    rawHeight: typeof raw.rawHeight === "number" ? raw.rawHeight : undefined,
    rawFrameCount: typeof raw.rawFrameCount === "number" ? raw.rawFrameCount : undefined,
    duration: typeof raw.duration === "number" ? raw.duration : undefined,
    strip: typeof raw.strip === "string" ? raw.strip : undefined,
    picks: Array.isArray(raw.picks) ? raw.picks.map((value: unknown) => Math.max(0, Math.round(num(value, 0)))) : [],
    error: typeof raw.error === "string" ? raw.error : undefined,
    stale: raw.stale === true,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined
  };
}

function clampIntSetting(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(num(value, fallback))));
}

/**
 * 补齐项目的转圈状态。
 *
 * 老项目（这个字段还不存在时创建的）里 `picks` 一个都没有，这里补成默认的
 * 均分位置——补出来的位置和「用户从没拖过」等价，所以可以安全地当默认值用。
 */
function normalizeTurn(raw: any, frameCount: number): TurnState {
  const direction: TurnDirection = raw?.direction === "cw" ? "cw" : raw?.direction === "ccw" ? "ccw" : TURN_DIRECTION_DEFAULT;
  const fallback = freshPicks(frameCount, direction);
  const picks: Record<string, number> = {};
  const rawPicks = raw?.frames?.picks;
  for (const key of DIRECTION_KEYS) {
    const value = rawPicks !== null && typeof rawPicks === "object" ? Number(rawPicks[key]) : Number.NaN;
    // 只做「是个合法的非负下标」这一层收敛，**不按 settings.turnFrameCount 夹**：
    // 候选帧的权威张数是 turn.frames.rawFrameCount（抽帧时写下的），而 settings
    // 里的那个值随时可能被用户先改小——按它夹会把用户拖好的位置当场压平
    // （实测：32 帧调到 16 之后 back/upRight/downRight 全挤到最后一帧）。
    // 真正的夹取放在用它的地方：applyTurnPicks 按实际帧数夹。
    picks[key] = Number.isFinite(value)
      ? Math.min(TURN_FRAME_COUNT_MAX - 1, Math.max(0, Math.round(value)))
      : fallback[key];
  }
  const times = Array.isArray(raw?.frames?.times) ? raw.frames.times.map((value: unknown) => num(value, 0)) : [];
  return {
    video: {
      status: (raw?.video?.status ?? "empty") as NodeStatus,
      taskId: typeof raw?.video?.taskId === "string" ? raw.video.taskId : undefined,
      backend: normalizeVideoBackend(raw?.video?.backend),
      remoteStatus: typeof raw?.video?.remoteStatus === "string" ? raw.video.remoteStatus : undefined,
      file: typeof raw?.video?.file === "string" ? raw.video.file : undefined,
      approved: raw?.video?.approved === true,
      error: typeof raw?.video?.error === "string" ? raw.video.error : undefined,
      firstFrame: typeof raw?.video?.firstFrame === "string" ? raw.video.firstFrame : undefined,
      elapsedMs: typeof raw?.video?.elapsedMs === "number" ? raw.video.elapsedMs : undefined,
      updatedAt: typeof raw?.video?.updatedAt === "number" ? raw.video.updatedAt : undefined,
      origin: raw?.video?.origin === "local" ? "local" : undefined,
      originalName: typeof raw?.video?.originalName === "string" ? raw.video.originalName : undefined
    },
    frames: {
      status: (raw?.frames?.status ?? "empty") as NodeStatus,
      frames: Array.isArray(raw?.frames?.frames) ? raw.frames.frames.map(String) : [],
      times,
      raw: typeof raw?.frames?.raw === "string" ? raw.frames.raw : undefined,
      rawWidth: typeof raw?.frames?.rawWidth === "number" ? raw.frames.rawWidth : undefined,
      rawHeight: typeof raw?.frames?.rawHeight === "number" ? raw.frames.rawHeight : undefined,
      rawFrameCount: typeof raw?.frames?.rawFrameCount === "number" ? raw.frames.rawFrameCount : undefined,
      duration: typeof raw?.frames?.duration === "number" ? raw.frames.duration : undefined,
      picks,
      strip: typeof raw?.frames?.strip === "string" ? raw.frames.strip : undefined,
      approved: raw?.frames?.approved === true,
      error: typeof raw?.frames?.error === "string" ? raw.frames.error : undefined,
      stale: raw?.frames?.stale === true,
      updatedAt: typeof raw?.frames?.updatedAt === "number" ? raw.frames.updatedAt : undefined
    },
    direction
  };
}

/**
 * 老项目（`imageMode` 还不存在时建的）沿用逐方向生图：它们已经有八张图了，
 * 直接跳到空白的转圈页只会让人以为产物丢了。新项目走 `createProject`，默认 turn。
 *
 * `imageMode` 与上面这条判断是**唯一**一处「新旧默认不同」的地方，其余一律
 * 以字段为准——否则读一遍写一遍就会把用户的显式选择改掉。
 */
function deriveImageMode(raw: any): ImageMode {
  if (raw?.imageMode === "direct") return "direct";
  if (raw?.imageMode === "turn") return "turn";
  const hasImages = DIRECTION_KEYS.some((key) => typeof raw?.images?.[key]?.file === "string");
  return hasImages ? "direct" : "turn";
}

/** 往项目日志里追加一条（最多保留 200 条）。 */
export function log(project: Project, level: LogEntry["level"], message: string): void {
  project.log.push({ at: Date.now(), level, message });
  if (project.log.length > 200) project.log.splice(0, project.log.length - 200);
}

/** 某个方向的参考图绝对路径列表（source 或其它方向的产出）。 */
export function referenceFiles(project: Project, refs: string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    if (ref === "source") {
      if (project.source !== null) out.push(assetPath(project.id, project.source.file));
      continue;
    }
    const node = project.images[ref];
    if (node?.file !== undefined) out.push(assetPath(project.id, node.file));
  }
  return out;
}

/** 项目目录是否真实存在。 */
export async function projectExists(id: string): Promise<boolean> {
  try {
    const info = await stat(projectDir(id));
    return info.isDirectory();
  } catch {
    return false;
  }
}
