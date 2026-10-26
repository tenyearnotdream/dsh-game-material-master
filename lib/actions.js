/**
 * 动作（Action）：阶段② 的「拍什么动作」这一层。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 * 阶段② 原本只有「行走」一个动作，提示词写死在一个项目级字段里。
 * 但一个角色要出的动作远不止行走：待机、挥砍、突刺、受击、倒地、施法……
 * 而且**动作的语义必须和提示词绑在一起**——「行走」这个动作之所以稳定，
 * 是因为那段提示词是按行走调出来的；换个动作只改一句话，模型立刻跑偏。
 *
 * 所以这里把「动作名 + 提示词 + 动作类型 + 建议关键帧数」打成一个 ActionDef：
 *   · 内置动作开箱即用（走路 / 待机 / 挥砍 / 突刺 / 受击 / 倒地 / 施法）；
 *   · 用户可以自己加（`customActions` 存在全局配置里，跨项目复用）；
 *   · 界面上就是一个下拉，选中哪个就用哪个的提示词。
 *
 * ── 动作类型为什么重要 ──────────────────────────────────────────────
 * `loop`（循环：走路、待机）—— 首尾要能接上，八个方向各拍一段就够。
 * `oneshot`（一次性：攻击、受击、倒地）—— 有时序（蓄力/出手/收招），
 *   八个方向各自独立生成时**节奏对不上**（实测：八段视频的打击帧错开半秒），
 *   所以这类动作要走「母本动作 → 关键帧 → 逐关键帧转圈」的矩阵流水线。
 *
 * ── 提示词写法上的三条硬规矩（全是实测踩出来的）────────────────────
 * 1. **不许列举方位例子**。写「背对镜头就一直背对镜头、面对镜头就一直面对镜头」时，
 *    模型会抓住第一个例子把正面角色转身过去。只能写抽象句：「第一帧是什么朝向，
 *    整段就保持那个朝向，禁止转身 / 转头 / 转离镜头」。
 * 2. **对称特征必须正面锁定**（独眼、单肩甲、半边脸疤）。8 步 turbo 会「顺手修正」
 *    成对称，所以要把不对称特征写进 `[角色锁定]` 段落。
 * 3. **一次性动作要给出节拍**（前 1/3 蓄力 → 中间出手 → 后 1/3 收招）。
 *    关键帧截出来才有区分度，否则六帧全是同一个姿势。
 */
import { DEFAULT_VIDEO_PROMPT, DEFAULT_VIDEO_PROMPT_EN } from "./directions.js";
/**
 * 转圈提示词的「姿势锁定」版本（关键帧转圈专用）。
 *
 * 与默认转圈提示词只差两段：`[起始姿态]` 与 `[禁止其它动作]`。
 * 默认版要求「正面站姿面对镜头」——那是给**源图**用的；关键帧是半挥刀的姿势，
 * 拿默认版会把角色掰回站姿，整条矩阵就废在同一个姿势上（实测踩过）。
 */
export const DEFAULT_TURN_PROMPT_POSE_LOCK = [
    "[固定机位] 固定机位、固定焦距、固定构图，镜头完全静止不动，镜头高度与角色胸口齐平，不俯视也不仰视。绿幕背景保持原样不变。",
    "[起始姿态] 画面开始时角色必须就是参考图里的样子：**完全保持参考图中的这个动作姿态**——手臂、腿、武器、躯干的角度与重心位置一律不要改动，也不要把它掰回站立姿势。完整保留参考图的五官、发型、发色、服装款式、配色与整体画风，必须看起来是同一个人、同一个姿势。",
    "[动作] 画面中只有这一个角色，角色原地绕自身竖直轴以完全均匀的速度旋转满一整圈（360 度），转速从头到尾不变，最后回到与开始时完全相同的朝向与姿势，首尾能够无缝接上。",
    "[禁止其它动作] 除了绕竖轴旋转，不要有任何动作：不要迈步、不要挥动、不要把动作收回去、不要换姿势、不要点头；整圈里姿势像被冻结一样保持不动，只有身体朝向在变化。",
    "[一致性] 旋转过程中身高、体型、脸型、发型、服装、配色与画风必须完全一致，只有身体朝向在变化。",
    "[背景] 纯色绿幕，颜色是标准 chroma key 绿 #00FF00，整幅背景颜色完全均匀一致，全程保持纯绿，不要任何阴影、渐变、地面或投影。",
    "[画面] 角色始终完整居中在画面内、不被裁切；不要出现第二个人或任何其它物体，不出现转场、抖动、缩放、运镜或镜头移动。"
].join("\n");
/** `DEFAULT_TURN_PROMPT_POSE_LOCK` 的英文版（逐行对应）。 */
const DEFAULT_TURN_PROMPT_POSE_LOCK_EN = [
    "[Static camera] Fixed camera position, fixed focal length, fixed framing, the camera stays completely motionless, camera height level with the character's chest, neither looking down nor looking up. The green screen background stays exactly as it is.",
    "[Start pose] At the start of the clip the character must look exactly as in the reference image: **keep this exact action pose from the reference image** - the angles of the arms, legs, weapon and torso and the center of gravity must not change at all, and do not straighten it back into a standing pose. Fully preserve the reference image's facial features, hairstyle, hair color, clothing style, color scheme and overall art style; it must look like the exact same person in the exact same pose.",
    "[Motion] There is only this one character in the frame; the character rotates in place around its own vertical axis at a completely even speed for a full circle (360 degrees), the rotation speed stays constant from beginning to end, and it finishes facing exactly the same direction and in exactly the same pose as at the start, so the first and last frames connect seamlessly.",
    "[No other motion] Apart from rotating around the vertical axis, there must be no other movement: no stepping, no swinging, do not retract the action, do not change pose, no nodding. The pose stays frozen for the whole circle, like a statue being turned; only the body orientation changes.",
    "[Consistency] During the rotation the height, build, face shape, hairstyle, clothing, color scheme and art style must stay exactly identical; only the body orientation changes.",
    "[Background] Solid green screen, the color is standard chroma key green #00FF00, the whole background is a completely uniform single color, pure green throughout, with no shadows, gradients, ground or cast shadow.",
    "[Frame] The character stays fully centered inside the frame the whole time, never cropped; no second person and no other object appears, no transitions, no jitter, no zooming, no camera movement or camera motion."
].join("\n");
/** 按语言取「姿势锁定」版转圈提示词（关键帧转圈专用；默认版在 directions.ts）。 */
export function poseLockTurnPrompt(lang) {
    return lang === "en" ? DEFAULT_TURN_PROMPT_POSE_LOCK_EN : DEFAULT_TURN_PROMPT_POSE_LOCK;
}
/**
 * 所有动作提示词的共同结尾：镜头 / 背景 / 画面约束。
 *
 * 抽出来是为了让每个动作只写「动作本身」，不必反复抄这几行——
 * 也避免了某一两条漏写「固定机位」导致整段视频运镜。
 */
const TAIL_ZH = [
    "[背景] 纯色绿幕，颜色是标准 chroma key 绿 #00FF00，整幅背景颜色完全均匀一致，全程保持纯绿，不要任何阴影、渐变、地面或投影；角色身上不要沾到绿色。",
    "[画面] 角色始终完整居中在画面内、不被裁切；不要走出画面，不要出现第二个人或任何其它物体，不出现转场、抖动、缩放、运镜或镜头移动。"
].join("\n");
const TAIL_EN = [
    "[Background] Solid green screen, the color is standard chroma key green #00FF00, the whole background is a completely uniform single color, pure green throughout, with no shadows, gradients, ground or cast shadow; no green spill on the character.",
    "[Frame] The character stays fully centered inside the frame the whole time, never cropped; do not walk out of the frame, do not let a second person or any other object appear, no transitions, no jitter, no zooming, no camera movement or camera motion."
].join("\n");
/** 镜头与朝向锁定：所有动作共用（朝向锁定是朝向一致性的唯一来源）。 */
const LOCK_ZH = "[固定机位] 固定机位、固定焦距、固定构图，镜头完全静止不动，镜头高度与角色胸口齐平，不俯视也不仰视。\n" +
    "[朝向锁定] 画面中只有这一个角色，保持参考图里的朝向不变——第一帧是什么朝向，整段视频就只能保持那个朝向，禁止转身、禁止转头、禁止把身体转向镜头、也禁止转离镜头。角色位置基本不动。\n" +
    // 武器/道具漂移是实测最常见的「看起来没错但用不了」：一段挥砍里小刀变成大砍刀、
    // 长矛变短剑，八个方向拼起来就成了八把不同的武器。
    "[道具锁定] 角色手里的武器／道具从头到尾保持同一件：外形、长短、颜色、握法都不变，不要换武器、不要让它变长变短，也不要在动作过程中凭空出现光效或碎片。";
const LOCK_EN = "[Static shot] Fixed camera position, fixed focal length, fixed framing, the camera stays completely motionless, camera height level with the character's chest, neither looking down nor looking up.\n" +
    "[Orientation lock] There is only this one character in the frame; keep the orientation from the reference image unchanged - whatever direction the first frame faces, the whole clip must keep facing exactly that direction. Do not turn around, do not turn the head, do not rotate the body toward the camera, and do not rotate away from it. The character stays roughly in place.\n" +
    "[Prop lock] The weapon or prop in the character's hand stays exactly the same object from start to finish: same shape, same length, same color, same grip. Do not swap the weapon, do not make it longer or shorter, and do not spawn light effects or debris during the motion.";
function promptOf(lines, tail) {
    return [...lines, tail].join("\n");
}
/**
 * 内置动作。
 *
 * ⚠️ `walk` 的提示词**必须逐字等于** `DEFAULT_VIDEO_PROMPT`：
 * 界面上「重置为默认」与 `localizePrompts` 的语言切换都按它比对，
 * 差一个字就会被当成「用户改过的」而不跟着语言走。
 */
export const BUILTIN_ACTIONS = [
    {
        id: "walk",
        label: "走路",
        labelEn: "Walk",
        prompt: DEFAULT_VIDEO_PROMPT,
        promptEn: DEFAULT_VIDEO_PROMPT_EN,
        kind: "loop",
        keyframeCount: 8,
        builtin: true
    },
    {
        id: "idle",
        label: "待机",
        labelEn: "Idle",
        prompt: promptOf([
            LOCK_ZH,
            "画面中只有这一个角色，原地待机：身体随呼吸轻微起伏（幅度很小），重心在双脚之间缓慢左右移动，手臂随身体轻微晃动，偶尔有一下极小的头部动作。",
            "动作幅度要克制：不要走动、不要迈步、不要跳跃、不要大幅度摆手，脚不能离地，整体看起来是在原地站着呼吸。",
            "保持平涂色块和干净的绿幕，不要补充纹理、光影或背景细节。"
        ], TAIL_ZH),
        promptEn: promptOf([
            LOCK_EN,
            "There is only this one character in the frame, idling in place: the body rises and falls slightly with breathing, the weight shifts slowly from one foot to the other, the arms sway slightly with the body, and every now and then there is a very small head movement.",
            "Keep the motion restrained: do not walk, do not step, do not jump, do not swing the arms widely, the feet must not leave the ground; overall it should read as standing in place and breathing.",
            "Keep the flat color blocks and the clean green screen; do not add texture, lighting or background detail."
        ], TAIL_EN),
        kind: "loop",
        keyframeCount: 8,
        builtin: true
    },
    {
        id: "attackSlash",
        label: "挥砍",
        labelEn: "Slash",
        prompt: promptOf([
            LOCK_ZH,
            "画面中只有这一个角色，原地完成一次横向挥砍，节拍平均分成三段：前三分之一蓄力（重心后坐、持械手向身后抬起、身体略微拧转），中间三分之一挥出（手臂从后向前横扫过身体前方，动作干净利落，这一下是打击帧），后三分之一收招（手臂沿着余势收回到身体侧前方，重心回正）。",
            "挥砍的幅度要够大、弧线要清楚，能看出「抬起来—扫过去—收回来」三个阶段；不要只抖一下，也不要连挥两次。双脚保持原地，不要迈步、不要跳起。",
            "保持平涂色块和干净的绿幕，不要补充纹理、光影或背景细节；不要出现刀光、特效、拖影或粒子。"
        ], TAIL_ZH),
        promptEn: promptOf([
            LOCK_EN,
            "There is only this one character in the frame, performing a single horizontal slash in place, with the beat split evenly into three parts: the first third is the wind-up (weight shifts back, the weapon hand lifts behind the body, the torso twists slightly), the middle third is the swing (the arm sweeps from behind across the front of the body, crisp and decisive - this is the impact frame), and the last third is the recovery (the arm follows through and returns to the side, the weight comes back to center).",
            "The swing must be large with a clear arc, so that the three stages - lift, sweep, return - are all readable; do not just twitch, and do not swing twice. Both feet stay planted; do not step and do not jump.",
            "Keep the flat color blocks and the clean green screen; do not add texture, lighting or background detail, and do not add weapon trails, effects, motion blur or particles."
        ], TAIL_EN),
        kind: "oneshot",
        keyframeCount: 6,
        builtin: true
    },
    {
        id: "attackStab",
        label: "突刺",
        labelEn: "Thrust",
        prompt: promptOf([
            LOCK_ZH,
            "画面中只有这一个角色，原地完成一次向正前方的突刺，节拍平均分成三段：前三分之一蓄力（重心后坐、持械手收到腰侧、上身略微侧转），中间三分之一刺出（手臂沿直线向前推出、身体前压，这一下是打击帧），后三分之一收回（手臂撤回腰侧，重心回正）。",
            "突刺走直线、不要挥出弧线；幅度要够大，能看出「收—出—收」三个阶段；双脚保持原地，前脚可以略微蹬地但不要迈步。",
            "保持平涂色块和干净的绿幕，不要补充纹理、光影或背景细节；不要出现刀光、特效、拖影或粒子。"
        ], TAIL_ZH),
        promptEn: promptOf([
            LOCK_EN,
            "There is only this one character in the frame, performing a single forward thrust in place, with the beat split evenly into three parts: the first third is the wind-up (weight shifts back, the weapon hand pulls back to the waist, the upper body turns slightly), the middle third is the thrust (the arm pushes straight forward along a line, the body drives forward - this is the impact frame), and the last third is the retraction (the arm pulls back to the waist, the weight returns to center).",
            "The thrust travels in a straight line, not an arc; make it large enough that the three stages - pull back, push out, pull back - are readable; both feet stay planted, the front foot may push off slightly but must not step.",
            "Keep the flat color blocks and the clean green screen; do not add texture, lighting or background detail, and do not add weapon trails, effects, motion blur or particles."
        ], TAIL_EN),
        kind: "oneshot",
        keyframeCount: 6,
        builtin: true
    },
    {
        id: "hurt",
        label: "受击",
        labelEn: "Hurt",
        prompt: promptOf([
            LOCK_ZH,
            "画面中只有这一个角色，原地演一次被击中的反应：先是身体猛地一顿（胸口/肩膀向后一缩、头略微后仰、手臂本能地收紧），然后小幅回弹并恢复到接近原来的站姿。整个反应很快，总长不超过半段视频。",
            "幅度要克制但有冲击感：不要被打飞、不要后退走开、不要倒地、不要翻滚；双脚保持在原地。",
            "保持平涂色块和干净的绿幕，不要补充纹理、光影或背景细节；不要出现受击特效、火星、冲击波或血。"
        ], TAIL_ZH),
        promptEn: promptOf([
            LOCK_EN,
            "There is only this one character in the frame, reacting to being hit in place: first the body jolts (the chest and shoulders flinch backward, the head tilts back slightly, the arms tighten instinctively), then it rebounds a little and returns to almost the original stance. The whole reaction is quick and takes less than half of the clip.",
            "Keep it restrained but punchy: do not get knocked flying, do not walk backward, do not fall down, do not roll; both feet stay planted.",
            "Keep the flat color blocks and the clean green screen; do not add texture, lighting or background detail, and do not add hit effects, sparks, shockwaves or blood."
        ], TAIL_EN),
        kind: "oneshot",
        keyframeCount: 5,
        builtin: true
    },
    {
        id: "die",
        label: "倒地",
        labelEn: "Death",
        prompt: promptOf([
            LOCK_ZH,
            "画面中只有这一个角色，原地从站立演到倒地：先失去力气（身体一软、头垂下、手臂下坠），再双膝弯下去，最后侧向倒在地上并停住不再动，倒地后保持不动直到视频结束。",
            "倒地要贴着地面完成，全过程角色都留在画面内、不要被裁掉；不要翻滚、不要弹跳、不要飘起来。",
            "保持平涂色块和干净的绿幕，不要补充纹理、光影或背景细节；不要出现血迹、特效或烟尘。"
        ], TAIL_ZH),
        promptEn: promptOf([
            LOCK_EN,
            "There is only this one character in the frame, going from standing to collapsing in place: first the strength drains away (the body goes limp, the head droops, the arms fall), then the knees buckle, and finally it falls over onto the ground on its side and stops moving, staying motionless until the end of the clip.",
            "The collapse happens close to the ground and the character stays inside the frame the whole time, never cropped; do not roll, do not bounce, do not float.",
            "Keep the flat color blocks and the clean green screen; do not add texture, lighting or background detail, and do not add blood, effects or dust."
        ], TAIL_EN),
        kind: "oneshot",
        keyframeCount: 8,
        builtin: true
    },
    {
        id: "cast",
        label: "施法",
        labelEn: "Cast",
        prompt: promptOf([
            LOCK_ZH,
            "画面中只有这一个角色，原地完成一次施法：先是抬起手臂到胸前蓄力（手掌朝前、身体略微下沉、肩膀放松），然后向前推出双手（掌心向前、身体前压，这一下是爆发帧），最后手臂缓慢收回身侧。",
            "动作要完整、有明确的三个阶段，不要只抬手不推出，也不要连推两次；双脚保持原地，不要迈步。",
            "保持平涂色块和干净的绿幕，不要补充纹理、光影或背景细节；不要出现魔法光效、粒子、法阵或发光。"
        ], TAIL_ZH),
        promptEn: promptOf([
            LOCK_EN,
            "There is only this one character in the frame, performing a single cast in place: first the arms lift to the chest to gather power (palms forward, the body sinks slightly, the shoulders relax), then both hands push forward (palms forward, the body drives forward - this is the burst frame), and finally the arms slowly return to the sides.",
            "The motion must be complete with three clear stages; do not just raise the hands without pushing, and do not push twice. Both feet stay planted; do not step.",
            "Keep the flat color blocks and the clean green screen; do not add texture, lighting or background detail, and do not add magic effects, particles, runes or glow."
        ], TAIL_EN),
        kind: "oneshot",
        keyframeCount: 6,
        builtin: true
    }
];
/** 一个项目默认带哪些动作（内置全量；自定义动作按需追加）。 */
export function defaultActions(lang = "zh") {
    return BUILTIN_ACTIONS.map((action) => ({ ...action }));
}
/** 取某个动作；找不到就退回走路（永远有兜底，界面不会空着）。 */
export function findAction(actions, id) {
    const list = actions.length > 0 ? actions : BUILTIN_ACTIONS;
    return list.find((action) => action.id === id) ?? list.find((action) => action.id === "walk") ?? list[0];
}
/** 动作类型 / 关键帧数的默认值（新建自定义动作时用）。 */
export function normalizeActionKind(value) {
    return value === "loop" ? "loop" : "oneshot";
}
export function normalizeMotionMode(value, kind = "oneshot") {
    if (value === "keyframe")
        return "keyframe";
    if (value === "perDirection")
        return "perDirection";
    // 没选过就按动作类型给默认：一次性动作必须走关键帧，否则节奏对不上。
    return kind === "loop" ? "perDirection" : "keyframe";
}
/** 自定义动作 id：`a` + 时间戳 + 随机，与项目 id 前缀不冲突。 */
export function newActionId(seed, random) {
    return `a${seed.toString(36)}${random}`;
}
/**
 * 把用户的输入整理成一个可用的 ActionDef。
 *
 * 提示词为空时必须报错而不是「悄悄用默认」——用户点了新建却得到一个走路动作，
 * 下次他会以为是自己写错了。
 */
export function sanitizeAction(input, fallbackId) {
    const raw = (input ?? {});
    const label = String(raw.label ?? "").trim();
    const prompt = String(raw.prompt ?? "").trim();
    if (label === "")
        throw new Error("动作名称不能为空");
    if (prompt === "")
        throw new Error("动作提示词不能为空");
    if (label.length > 40)
        throw new Error("动作名称最多 40 个字");
    if (prompt.length > 4000)
        throw new Error("动作提示词最多 4000 个字");
    const kind = normalizeActionKind(raw.kind);
    const rawCount = Number(raw.keyframeCount);
    const keyframeCount = Number.isFinite(rawCount) ? Math.min(24, Math.max(2, Math.round(rawCount))) : kind === "loop" ? 8 : 6;
    return {
        id: typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : fallbackId,
        label,
        labelEn: typeof raw.labelEn === "string" && raw.labelEn.trim() !== "" ? raw.labelEn.trim() : label,
        prompt,
        promptEn: typeof raw.promptEn === "string" && raw.promptEn.trim() !== "" ? raw.promptEn.trim() : prompt,
        kind,
        keyframeCount,
        builtin: raw.builtin === true
    };
}
/** 内置动作只允许改提示词，不允许改 id / 类型。 */
export function mergeActionPatch(base, patch) {
    return {
        ...base,
        prompt: patch.prompt !== undefined && patch.prompt.trim() !== "" ? patch.prompt : base.prompt,
        promptEn: patch.promptEn !== undefined && patch.promptEn.trim() !== "" ? patch.promptEn : base.promptEn,
        keyframeCount: patch.keyframeCount !== undefined ? Math.min(24, Math.max(2, Math.round(patch.keyframeCount))) : base.keyframeCount
    };
}
