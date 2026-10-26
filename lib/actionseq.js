/**
 * 动作序列：「母本动作 → 关键帧 → 逐关键帧转圈」的流水线。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 一次性动作（挥砍 / 突刺 / 倒地）要的是「八个方向、同一套节奏」。
 * 八个方向各生成一段视频时，八次采样的**时序**完全解耦：实测两段视频的
 * 打击帧能错开小半秒，游戏里一转身就发现「斜向的刀已经落下、正面的还在蓄力」。
 * 招式语义也会漂（同一次挥砍，一段是横劈一段是下砸）。
 *
 * 这里的做法是把「时间」和「朝向」拆成两个正交的维度：
 *
 *   时间轴  母本动作视频（一段，正面） → 抽 32 张候选 → 选 N 张关键帧
 *   朝向轴  每个关键帧各转一圈（复用阶段①的转圈能力） → 8 个方向
 *   矩阵    8 方向 × N 关键帧
 *
 * 全方向共用**同一批关键帧**，所以「第 2 列 = 同一姿态」是结构上保证的，
 * 不靠模型配合。代价是 1 + N 次视频生成（N=5 时 6 次，比 8 次还少）。
 *
 * ── 文件布局 ────────────────────────────────────────────────────────
 *   actions/<动作id>/seed.mp4        母本动作视频
 *   actions/<动作id>/seed/c00.png…   母本候选帧
 *   actions/<动作id>/seed/raw.bin    候选帧 RGBA 缓存
 *   actions/<动作id>/k0/turn.mp4     第 0 个关键帧的转圈视频
 *   actions/<动作id>/k0/c00.png…     它自己的候选帧
 *   actions/<动作id>/k0/raw.bin      它自己的候选帧缓存
 *   actions/<动作id>/k0/<方向>.png   切出来的方向图
 *
 * 为什么每个关键帧单独存一份 raw.bin：拖动截帧位置时要能**只重切那一张**，
 * 不必重新抽帧、更不必重新生成视频（和阶段①的 turn/raw.bin 同一套道理）。
 *
 * ── 这里的函数为什么不用 kick() 丢后台 ──────────────────────────────
 * 只有「提交」和「轮询」会发网络请求，提交是一次 HTTP（1~2 秒），
 * 抽帧是本地 ffmpeg（几秒）。都不是分钟级，直接 await 更好调试；
 * 真正的长任务（视频生成）由 pipeline 的轮询器接管。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { DIRECTION_KEYS, defaultTurnPicks, directionOf, TURN_DIRECTION_DEFAULT } from "./directions.js";
import { BUILTIN_ACTIONS, defaultActions, findAction, mergeActionPatch, normalizeActionKind, normalizeMotionMode, poseLockTurnPrompt, sanitizeAction } from "./actions.js";
import { extractFrames, toJpegDataUri } from "./media.js";
import { encodePng } from "./png.js";
import { assertVideoBackendReady, downloadVideoTask, queryVideoTask, submitVideoTask, videoBackendOf, videoFailureReason } from "./videogen.js";
import { activeAction, applyWorkspace, assetPath, emptySeed, log, patchProject, readProject, snapshotWorkspace } from "./store.js";
import { composeSheet } from "./chroma.js";
/** 母本动作 / 关键帧转圈的候选帧张数：与阶段① 转圈轴保持同一档，截帧才够细。 */
export const SEED_CANDIDATE_DEFAULT = 32;
export const SEED_CANDIDATE_MIN = 8;
export const SEED_CANDIDATE_MAX = 128;
/** 关键帧数量的上下限（矩阵列数）：少了动作不连贯，多了生成成本线性上涨。 */
export const KEYFRAME_MIN = 2;
export const KEYFRAME_MAX = 24;
function clampInt(value, fallback, min, max) {
    const n = Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 提示词语言跟着项目走：项目的转圈提示词是英文时，姿势锁定版也用英文。 */
function promptLangOf(project) {
    const text = project.prompts?.turn ?? "";
    return /\[Static camera\]/i.test(text) ? "en" : "zh";
}
/** 把 N 个关键帧均匀铺在候选帧上（格心取整），与阶段①的等分算法一致。 */
export function evenKeyframes(count, wanted) {
    const total = Math.max(1, count);
    const n = clampInt(wanted, 6, KEYFRAME_MIN, KEYFRAME_MAX);
    const out = [];
    for (let i = 0; i < n; i++)
        out.push(Math.min(total - 1, Math.floor(((i + 0.5) * total) / n)));
    return out;
}
// ── 动作库 ──────────────────────────────────────────────────────────
/** 列出动作库与当前选中项。 */
export function listActions(project) {
    return {
        actions: project.actions ?? defaultActions(),
        activeActionId: project.activeActionId ?? "walk",
        motionMode: project.motionMode ?? "perDirection"
    };
}
/**
 * 新建 / 修改动作。
 *
 * 内置动作只允许改提示词与关键帧数（id / 类型是结构，改了会让存档对不上）；
 * 自定义动作可以整条覆盖。
 */
export async function saveAction(projectId, input) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const raw = (input ?? {});
    const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
    const existing = rawId === "" ? undefined : (project.actions ?? []).find((action) => action.id === rawId);
    const now = Date.now();
    const action = existing !== undefined
        ? mergeActionPatch(existing, {
            prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
            promptEn: typeof raw.promptEn === "string" ? raw.promptEn : undefined,
            keyframeCount: raw.keyframeCount === undefined ? undefined : Number(raw.keyframeCount)
        })
        : sanitizeAction(raw, `a${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    const next = (project.actions ?? []).filter((item) => item.id !== action.id);
    // 自定义动作追加在末尾；内置动作保持在原位置。
    const index = (project.actions ?? []).findIndex((item) => item.id === action.id);
    if (index >= 0)
        next.splice(index, 0, action);
    else
        next.push(action);
    await patchProject(projectId, (current) => {
        current.actions = next;
        log(current, "info", `${existing !== undefined ? "更新" : "新增"}动作「${action.label}」（${action.kind === "loop" ? "循环" : "一次性"}）`);
    });
    return action;
}
/** 删除自定义动作（内置动作不允许删）。正在用的动作也会连带切回走路。 */
export async function deleteAction(projectId, actionId) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const action = (project.actions ?? []).find((item) => item.id === actionId);
    if (action === undefined)
        throw new Error(`动作不存在：${actionId}`);
    if (action.builtin === true)
        throw new Error(`内置动作「${action.label}」不能删除（可以改提示词）`);
    await patchProject(projectId, (current) => {
        current.actions = (current.actions ?? []).filter((item) => item.id !== actionId);
        delete current.actionArchive[actionId];
        if (current.activeActionId === actionId)
            current.activeActionId = "walk";
    });
    if (project.activeActionId === actionId)
        await switchWorkspace(projectId, "walk");
}
/**
 * 切换当前动作。
 *
 * 「存旧的、取新的」：当前工作区整份存进 `actionArchive`，目标动作的快照装回来。
 * 这样走路与攻击的产物互不覆盖——这也是为什么阶段②~④ 的代码一行都不用改，
 * 它们看到的永远是「当前动作的」`videos / frames / sheet`。
 */
async function switchWorkspace(projectId, actionId) {
    await patchProject(projectId, (current) => {
        const from = current.activeActionId ?? "walk";
        if (from === actionId)
            return;
        current.actionArchive[from] = snapshotWorkspace(current);
        const archived = current.actionArchive[actionId];
        current.activeActionId = actionId;
        applyWorkspace(current, archived);
        delete current.actionArchive[actionId];
        // 提示词跟着动作走：存档里有就用存档的（用户可能改过），没有就用动作预设。
        const action = activeAction(current);
        if (archived === undefined)
            current.prompts.video = action.prompt;
        log(current, "info", `切换到动作「${action.label}」（${action.kind === "loop" ? "循环" : "一次性"}，${current.motionMode === "keyframe" ? "关键帧转圈" : "八方向独立"}）`);
    });
}
export async function setActiveAction(projectId, actionId) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const action = (project.actions ?? []).find((item) => item.id === actionId);
    if (action === undefined)
        throw new Error(`动作不存在：${actionId}`);
    if (project.activeActionId === actionId)
        return;
    await switchWorkspace(projectId, actionId);
}
/** 切换生成方式（八方向独立 / 关键帧转圈）。只切流程，不删任何产物。 */
export async function setMotionMode(projectId, mode) {
    await patchProject(projectId, (current) => {
        const action = activeAction(current);
        current.motionMode = normalizeMotionMode(mode, action.kind);
        log(current, "info", `动作「${action.label}」的生成方式改为：${current.motionMode === "keyframe" ? "关键帧转圈（8 方向 × 关键帧矩阵）" : "八方向各自生成"}`);
    });
}
// ── 母本动作视频 ────────────────────────────────────────────────────
function actionDir(actionId) {
    return `actions/${actionId}`;
}
/**
 * 生成母本动作视频（**计费一次**）。
 *
 * 首帧是「当前动作的基准方向图」（默认 front）：这张图已经是绿幕、已经是对的画风，
 * 所以母本视频的画面风格与后面八方向的图天然一致。
 */
export async function startSeedVideo(projectId, options = {}) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const config = await loadConfig();
    assertVideoBackendReady(config);
    const action = activeAction(project);
    const baseDirection = options.baseDirection ?? "front";
    const baseImage = project.images?.[baseDirection];
    if (baseImage?.file === undefined)
        throw new Error(`还没有「${directionOf(baseDirection)?.label ?? baseDirection}」的绿幕图，请先完成阶段①`);
    if (project.seed?.video?.status === "running")
        throw new Error("母本动作视频正在生成中，请等它跑完");
    const suffix = (project.prompts.suffix ?? "").trim();
    const base = (options.prompt ?? project.prompts.video ?? action.prompt).trim();
    if (base === "")
        throw new Error("动作提示词为空，请先填写提示词");
    // 动作提示词 + 统一附加提示词：与阶段② 的拼法保持一致。
    const prompt = suffix === "" ? base : `${base}\n${suffix}`;
    const dir = actionDir(action.id);
    const firstFrameRel = `${dir}/seed-first-frame.jpg`;
    // 动作目录是新建才有的（ensureLayout 只建项目根下的固定几层），转码目标目录要先存在，
    // 否则 ffmpeg 的 image2 muxer 会以 I/O error 退出。
    await mkdir(dirname(assetPath(projectId, firstFrameRel)), { recursive: true });
    const dataUri = await toJpegDataUri(assetPath(projectId, baseImage.file), assetPath(projectId, firstFrameRel), 1280, 3, videoBackendOf(config) === "toapis" ? "white" : undefined);
    await patchProject(projectId, (current) => {
        current.seed = { ...(current.seed ?? emptySeed()), video: { status: "running", approved: false, remoteStatus: "提交中", updatedAt: Date.now() } };
        log(current, "info", `提交动作「${action.label}」的母本视频（首帧：${directionOf(baseDirection)?.label ?? baseDirection}）`);
    });
    const submitted = await submitVideoTask(config, {
        prompt,
        firstFrameImage: dataUri,
        duration: config.minimaxDuration,
        resolution: config.minimaxResolution,
        promptOptimizer: config.minimaxPromptOptimizer
    });
    await patchProject(projectId, (current) => {
        current.seed.video = {
            status: "running",
            approved: false,
            taskId: submitted.taskId,
            backend: submitted.backend,
            remoteStatus: "已提交",
            updatedAt: Date.now()
        };
        log(current, "info", `母本视频任务已提交（${submitted.taskId}）`);
        for (const note of submitted.notes)
            log(current, "info", note);
    });
    return { taskId: submitted.taskId, backend: submitted.backend };
}
// ── 母本候选帧 ──────────────────────────────────────────────────────
/** 从母本视频抽候选帧（本机 ffmpeg，免费）。默认关键帧按动作预设的列数等分。 */
export async function extractSeedCandidates(projectId, count) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const action = activeAction(project);
    const seed = project.seed ?? emptySeed();
    if (seed.video?.file === undefined)
        throw new Error("还没有母本动作视频，请先生成母本视频");
    const frameCount = clampInt(count ?? SEED_CANDIDATE_DEFAULT, SEED_CANDIDATE_DEFAULT, SEED_CANDIDATE_MIN, SEED_CANDIDATE_MAX);
    const dir = actionDir(action.id);
    const settings = project.settings;
    const extracted = await extractFrames({
        video: assetPath(projectId, seed.video.file),
        frameCount,
        longEdge: settings.workingLongEdge,
        cropInset: settings.cropInset
    });
    const rawRelative = `${dir}/seed/raw.bin`;
    await mkdir(dirname(assetPath(projectId, rawRelative)), { recursive: true });
    await writeFile(assetPath(projectId, rawRelative), Buffer.concat(extracted.frames));
    const files = [];
    for (let i = 0; i < extracted.frames.length; i++) {
        const relative = `${dir}/seed/c${String(i).padStart(2, "0")}.png`;
        await writeFile(assetPath(projectId, relative), encodePng(extracted.frames[i], extracted.width, extracted.height));
        files.push(relative);
    }
    // 缩略条带（选关键帧时对着它拖），与阶段① 的条带同一套尺寸规则。
    const strip = composeSheet([{ key: "seed", frames: extracted.frames, width: extracted.width, height: extracted.height }], {
        cellWidth: 96,
        cellHeight: Math.max(24, Math.round((96 * extracted.height) / Math.max(1, extracted.width))),
        frameCount: extracted.frames.length,
        autoCrop: false,
        fillRatio: 1,
        pixelSize: 0,
        fitMode: "stretch",
        bottomMargin: 0
    });
    const stripRelative = `${dir}/seed/strip.png`;
    await writeFile(assetPath(projectId, stripRelative), encodePng(strip.rgba, strip.width, strip.height));
    await patchProject(projectId, (current) => {
        current.seed = {
            ...(current.seed ?? emptySeed()),
            candidates: files,
            raw: rawRelative,
            rawWidth: extracted.width,
            rawHeight: extracted.height,
            duration: extracted.duration,
            // 张数变了：旧的关键帧下标已经没有意义，按新的张数重新等分。
            keyframes: evenKeyframes(files.length, current.seed?.keyframes?.length || action.keyframeCount)
        };
        log(current, "info", `母本候选帧抽取完成：${files.length} 张 / ${extracted.width}×${extracted.height} / 时长 ${extracted.duration.toFixed(2)} 秒；关键帧 ${current.seed.keyframes.length} 张`);
    });
}
/**
 * 选定关键帧（矩阵的列）。
 *
 * 关键帧列表一变，那些「位置没变但指向的候选帧变了」的转圈就得作废——
 * 留着它们会拿旧姿势的八个方向去合成，整张图里混进一格别的动作。
 */
export async function setSeedKeyframes(projectId, keyframes) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const seed = project.seed ?? emptySeed();
    const total = seed.candidates?.length ?? 0;
    if (total === 0)
        throw new Error("还没有母本候选帧，请先抽取候选帧");
    if (!Array.isArray(keyframes) || keyframes.length < KEYFRAME_MIN)
        throw new Error(`关键帧至少要 ${KEYFRAME_MIN} 张（矩阵至少要两列才看得出动作）`);
    if (keyframes.length > KEYFRAME_MAX)
        throw new Error(`关键帧最多 ${KEYFRAME_MAX} 张`);
    const next = keyframes.map((value, index) => {
        const n = Number(value);
        if (!Number.isFinite(n))
            throw new Error(`第 ${index + 1} 个关键帧不是数字`);
        return clampInt(n, 0, 0, total - 1);
    });
    await patchProject(projectId, (current) => {
        const previous = current.seed?.keyframes ?? [];
        const turns = { ...(current.seed?.turns ?? {}) };
        for (let i = 0; i < next.length; i++) {
            // 位置 i 指向的关键帧换了 → 这一列的转圈作废；没换的保留（重跑一次要花钱）。
            if (previous[i] !== next[i] && turns[`k${i}`] !== undefined)
                delete turns[`k${i}`];
        }
        // 列数变少：多余的列整条删掉。
        for (const key of Object.keys(turns)) {
            const index = Number(key.slice(1));
            if (!Number.isFinite(index) || index >= next.length)
                delete turns[key];
        }
        current.seed = { ...(current.seed ?? emptySeed()), keyframes: next, turns };
        log(current, "info", `关键帧改为 ${next.length} 张：候选帧 #${next.map((n) => n + 1).join(" / #")}`);
    });
    return { keyframes: next };
}
// ── 每个关键帧的转圈 ────────────────────────────────────────────────
function keyframeKey(index) {
    return `k${index}`;
}
/**
 * 给第 index 个关键帧提交一次转圈（**计费一次**）。
 *
 * 提示词必须是**姿势锁定**版：默认转圈提示词要求「正面站姿面对镜头」，
 * 用在半挥刀的姿势上会把角色掰回站姿，整列都废在同一个姿势上。
 */
export async function startKeyframeTurn(projectId, index, options = {}) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const config = await loadConfig();
    assertVideoBackendReady(config);
    const action = activeAction(project);
    const seed = project.seed ?? emptySeed();
    const keyframes = seed.keyframes ?? [];
    if (index < 0 || index >= keyframes.length)
        throw new Error(`关键帧序号越界：${index}（当前 ${keyframes.length} 列）`);
    const candidate = keyframes[index];
    const firstFrame = seed.candidates?.[candidate];
    if (firstFrame === undefined)
        throw new Error(`第 ${index + 1} 个关键帧指向的候选帧不存在，请重新抽取候选帧`);
    const key = keyframeKey(index);
    const existing = seed.turns?.[key];
    if (existing?.status === "running" && options.regenerate !== true)
        throw new Error(`第 ${index + 1} 个关键帧的转圈正在生成中`);
    if (existing?.status === "ready" && options.regenerate !== true)
        throw new Error(`第 ${index + 1} 个关键帧已经转好圈了（要重做请带 regenerate）`);
    const prompt = poseLockTurnPrompt(promptLangOf(project));
    const dir = actionDir(action.id);
    const jpegRel = `${dir}/${key}/turn-first-frame.jpg`;
    await mkdir(dirname(assetPath(projectId, jpegRel)), { recursive: true });
    const dataUri = await toJpegDataUri(assetPath(projectId, firstFrame), assetPath(projectId, jpegRel), 1280, 3, videoBackendOf(config) === "toapis" ? "white" : undefined);
    await patchProject(projectId, (current) => {
        const turns = { ...(current.seed?.turns ?? {}) };
        turns[key] = {
            status: "running",
            remoteStatus: "提交中",
            frames: [],
            picks: turns[key]?.picks ?? defaultTurnPicks(current.settings.turnFrameCount, TURN_DIRECTION_DEFAULT),
            directions: {},
            updatedAt: Date.now()
        };
        current.seed = { ...(current.seed ?? emptySeed()), turns };
        log(current, "info", `提交第 ${index + 1}/${keyframes.length} 个关键帧的转圈（候选帧 #${candidate + 1}）`);
    });
    const submitted = await submitVideoTask(config, {
        prompt,
        firstFrameImage: dataUri,
        duration: config.minimaxDuration,
        resolution: config.minimaxResolution,
        promptOptimizer: config.minimaxPromptOptimizer
    });
    await patchProject(projectId, (current) => {
        const turns = { ...(current.seed?.turns ?? {}) };
        turns[key] = {
            ...(turns[key] ?? { frames: [], picks: {}, directions: {} }),
            status: "running",
            taskId: submitted.taskId,
            backend: submitted.backend,
            remoteStatus: "已提交",
            updatedAt: Date.now()
        };
        current.seed.turns = turns;
        log(current, "info", `第 ${index + 1} 个关键帧的转圈任务已提交（${submitted.taskId}）`);
        for (const note of submitted.notes)
            log(current, "info", note);
    });
    return { taskId: submitted.taskId, backend: submitted.backend };
}
/** 轮询一次：母本视频 + 所有在跑的关键帧转圈。由 pipeline 的轮询器调用。 */
export async function pollSeedOnce(projectId, config) {
    const project = await readProject(projectId);
    if (project === undefined)
        return;
    const action = activeAction(project);
    const dir = actionDir(action.id);
    const seed = project.seed ?? emptySeed();
    const seedNode = seed.video;
    if (seedNode?.status === "running" && typeof seedNode.taskId === "string") {
        const backend = seedNode.backend ?? "minimax";
        try {
            const query = await queryVideoTask(config, backend, seedNode.taskId);
            if (query.status === "failed") {
                const reason = videoFailureReason(backend, query.error);
                await patchProject(projectId, (current) => {
                    current.seed.video = { ...current.seed.video, status: "error", error: reason, remoteStatus: query.remoteStatus, updatedAt: Date.now() };
                    log(current, "error", `母本动作视频生成失败：${reason}`);
                });
            }
            else if (query.status === "succeeded" && query.url !== undefined) {
                const bytes = await downloadVideoTask(config, backend, query.url);
                const relative = `${dir}/seed.mp4`;
                await writeFile(assetPath(projectId, relative), bytes);
                await patchProject(projectId, (current) => {
                    current.seed.video = {
                        status: "ready",
                        approved: false,
                        taskId: seedNode.taskId,
                        backend,
                        remoteStatus: query.remoteStatus,
                        file: relative,
                        updatedAt: Date.now()
                    };
                    log(current, "info", `母本动作视频已下载（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
                });
            }
            else {
                await patchProject(projectId, (current) => {
                    current.seed.video = { ...current.seed.video, remoteStatus: query.remoteStatus, updatedAt: Date.now() };
                });
            }
        }
        catch (error) {
            // 单次查询异常不等于失败：保留 running 让下一轮重试。
            await patchProject(projectId, (current) => {
                if (current.seed?.video !== undefined)
                    current.seed.video.remoteStatus = `查询异常：${messageOf(error)}`;
            });
        }
    }
    for (const [key, node] of Object.entries(project.seed?.turns ?? {})) {
        if (node?.status !== "running" || typeof node.taskId !== "string")
            continue;
        const backend = node.backend ?? "minimax";
        try {
            const query = await queryVideoTask(config, backend, node.taskId);
            if (query.status === "failed") {
                const reason = videoFailureReason(backend, query.error);
                await patchProject(projectId, (current) => {
                    const turn = current.seed?.turns?.[key];
                    if (turn === undefined)
                        return;
                    turn.status = "error";
                    turn.error = reason;
                    turn.remoteStatus = query.remoteStatus;
                    turn.updatedAt = Date.now();
                    log(current, "error", `${key} 的转圈失败：${reason}`);
                });
            }
            else if (query.status === "succeeded" && query.url !== undefined) {
                const bytes = await downloadVideoTask(config, backend, query.url);
                const relative = `${dir}/${key}/turn.mp4`;
                await writeFile(assetPath(projectId, relative), bytes);
                await patchProject(projectId, (current) => {
                    const turn = current.seed?.turns?.[key];
                    if (turn === undefined)
                        return;
                    turn.status = "ready";
                    turn.file = relative;
                    turn.remoteStatus = query.remoteStatus;
                    turn.updatedAt = Date.now();
                    log(current, "info", `${key} 的转圈视频已下载（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
                });
            }
            else {
                await patchProject(projectId, (current) => {
                    const turn = current.seed?.turns?.[key];
                    if (turn !== undefined)
                        turn.remoteStatus = query.remoteStatus;
                });
            }
        }
        catch (error) {
            await patchProject(projectId, (current) => {
                const turn = current.seed?.turns?.[key];
                if (turn !== undefined)
                    turn.remoteStatus = `查询异常：${messageOf(error)}`;
            });
        }
    }
}
/** 是否还有母本 / 关键帧转圈在跑（决定轮询器要不要继续活着）。 */
export function hasSeedPending(project) {
    const seed = project.seed;
    if (seed === undefined)
        return false;
    if (seed.video?.status === "running" && typeof seed.video.taskId === "string")
        return true;
    return Object.values(seed.turns ?? {}).some((node) => node?.status === "running" && typeof node.taskId === "string");
}
/**
 * 抽一个关键帧转圈的候选帧，并按当前截帧位置切出八个方向。
 *
 * 切图写进 `actions/<动作>/k<i>/<方向>.png`，**不动** `images/<方向>.png`
 * ——那八张是角色的基准朝向图，后面所有动作都靠它，绝不能被某个动作覆盖。
 */
export async function cutKeyframeTurn(projectId, index, count) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const action = activeAction(project);
    const key = keyframeKey(index);
    const node = project.seed?.turns?.[key];
    if (node?.file === undefined)
        throw new Error(`第 ${index + 1} 个关键帧还没有转圈视频`);
    const frameCount = clampInt(count ?? project.settings.turnFrameCount, project.settings.turnFrameCount, SEED_CANDIDATE_MIN, SEED_CANDIDATE_MAX);
    const dir = actionDir(action.id);
    const extracted = await extractFrames({
        video: assetPath(projectId, node.file),
        frameCount,
        longEdge: project.settings.workingLongEdge,
        cropInset: project.settings.cropInset
    });
    const rawRelative = `${dir}/${key}/raw.bin`;
    await mkdir(dirname(assetPath(projectId, rawRelative)), { recursive: true });
    await writeFile(assetPath(projectId, rawRelative), Buffer.concat(extracted.frames));
    const files = [];
    const times = [];
    for (let i = 0; i < extracted.frames.length; i++) {
        const relative = `${dir}/${key}/c${String(i).padStart(2, "0")}.png`;
        await writeFile(assetPath(projectId, relative), encodePng(extracted.frames[i], extracted.width, extracted.height));
        files.push(relative);
        times.push((i * extracted.duration) / Math.max(1, extracted.frames.length));
    }
    const strip = composeSheet([{ key, frames: extracted.frames, width: extracted.width, height: extracted.height }], {
        cellWidth: 96,
        cellHeight: Math.max(24, Math.round((96 * extracted.height) / Math.max(1, extracted.width))),
        frameCount: extracted.frames.length,
        autoCrop: false,
        fillRatio: 1,
        pixelSize: 0,
        fitMode: "stretch",
        bottomMargin: 0
    });
    const stripRelative = `${dir}/${key}/strip.png`;
    await writeFile(assetPath(projectId, stripRelative), encodePng(strip.rgba, strip.width, strip.height));
    // 张数变了就按比例换算已校准的截帧位置（与阶段① 的 rescalePicks 同一套规则）。
    const previous = node.picks ?? {};
    const previousCount = node.frames?.length ?? 0;
    const picks = {};
    for (const direction of DIRECTION_KEYS) {
        const old = Number(previous[direction]);
        const scaled = previousCount > 0 && previousCount !== files.length && Number.isFinite(old)
            ? Math.round((old * files.length) / previousCount)
            : Number.isFinite(old) ? old : 0;
        picks[direction] = clampInt(scaled, 0, 0, files.length - 1);
    }
    await patchProject(projectId, (current) => {
        const turns = { ...(current.seed?.turns ?? {}) };
        turns[key] = {
            ...(turns[key] ?? { directions: {} }),
            status: "ready",
            frames: files,
            raw: rawRelative,
            rawWidth: extracted.width,
            rawHeight: extracted.height,
            duration: extracted.duration,
            picks,
            updatedAt: Date.now()
        };
        current.seed.turns = turns;
        log(current, "info", `第 ${index + 1} 个关键帧：候选帧 ${files.length} 张 / ${extracted.width}×${extracted.height} / 时长 ${extracted.duration.toFixed(2)} 秒`);
    });
    await cutKeyframeDirections(projectId, index);
}
/** 按 picks 把某个关键帧的八个方向切出来（本机 CPU，免费；只重写那几张 PNG）。 */
export async function cutKeyframeDirections(projectId, index) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    const action = activeAction(project);
    const key = keyframeKey(index);
    const node = project.seed?.turns?.[key];
    if (node?.raw === undefined || node.rawWidth === undefined || node.rawWidth <= 0)
        throw new Error(`第 ${index + 1} 个关键帧还没有候选帧，请先抽帧`);
    const width = node.rawWidth;
    const height = node.rawHeight;
    const raw = await readFile(assetPath(projectId, node.raw));
    const frameBytes = width * height * 4;
    const total = Math.max(0, Math.floor(raw.length / frameBytes));
    if (total === 0)
        throw new Error("候选帧缓存是空的，请重新抽帧");
    const dir = actionDir(action.id);
    const directions = { ...(node.directions ?? {}) };
    for (const direction of DIRECTION_KEYS) {
        const pick = clampInt(node.picks?.[direction] ?? 0, 0, 0, total - 1);
        const slice = Buffer.from(raw.subarray(pick * frameBytes, (pick + 1) * frameBytes));
        const relative = `${dir}/${key}/${direction}.png`;
        await writeFile(assetPath(projectId, relative), encodePng(slice, width, height));
        directions[direction] = relative;
    }
    await patchProject(projectId, (current) => {
        const turn = current.seed?.turns?.[key];
        if (turn === undefined)
            return;
        turn.directions = directions;
        log(current, "info", `第 ${index + 1} 个关键帧已切出八个方向`);
    });
}
/** 改某个关键帧某个方向的截帧位置（拖圆圈），只重切那一张。 */
export async function setKeyframeTurnPick(projectId, index, direction, pick) {
    const project = await readProject(projectId);
    if (project === undefined)
        throw new Error(`项目不存在：${projectId}`);
    if (directionOf(direction) === undefined)
        throw new Error(`未知方向：${direction}`);
    const key = keyframeKey(index);
    const node = project.seed?.turns?.[key];
    if (node === undefined)
        throw new Error(`第 ${index + 1} 个关键帧还没有转圈`);
    const total = node.frames?.length ?? 0;
    if (total === 0)
        throw new Error(`第 ${index + 1} 个关键帧还没有候选帧，请先抽帧`);
    const next = clampInt(pick, 0, 0, total - 1);
    await patchProject(projectId, (current) => {
        const turn = current.seed?.turns?.[key];
        if (turn === undefined)
            return;
        turn.picks = { ...(turn.picks ?? {}), [direction]: next };
    });
    await cutKeyframeDirections(projectId, index);
    return { pick: next };
}
/** 矩阵是否已经齐了（每一列的八个方向都在）。 */
export function matrixStatus(project) {
    const seed = project.seed ?? emptySeed();
    const keyframes = seed.keyframes ?? [];
    const missing = [];
    let readyColumns = 0;
    for (let i = 0; i < keyframes.length; i++) {
        const turn = seed.turns?.[keyframeKey(i)];
        const missingDirs = DIRECTION_KEYS.filter((direction) => turn?.directions?.[direction] === undefined);
        if (missingDirs.length === 0)
            readyColumns++;
        else
            missing.push(`k${i}:${missingDirs.join("/")}`);
    }
    return { columns: keyframes.length, readyColumns, missing };
}
/** 动作 id 的目录名（供 pipeline 合成时复用）。 */
export function actionAssetDir(actionId) {
    return actionDir(actionId);
}
export { BUILTIN_ACTIONS, findAction, normalizeActionKind };
