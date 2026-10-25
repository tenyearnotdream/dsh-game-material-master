/**
 * 位图上的极简绘制原语（Agent 检查图 / 网格 / 标记叠加用）。
 *
 * 这里只做「像素画布上画线 / 圆 / 菱形 / 数字」这几件事，不参与地图几何：
 * 坐标由 `maprender` / `isorender` 从宿主计划算好，本文件只负责落像素。
 *
 * 为什么不用 canvas：宿主半区没有 DOM；PNG 导出走的是同一套 RGBA 缓冲区，
 * 预览与导出必须共享同一条路径。数字用内置 3×5 点阵，中文名不画在图上
 * （几十个中文名字常驻会糊成一片，界面悬停看名字即可）。
 */
function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}
function clampAlpha(value) {
    return Math.max(0, Math.min(1, value));
}
/** source-over 混合一个像素；越界直接忽略。 */
export function blendPixel(bitmap, x, y, color, alpha = 1) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= bitmap.width || py >= bitmap.height)
        return;
    const a = clampAlpha(alpha);
    if (a <= 0)
        return;
    const index = (py * bitmap.width + px) * 4;
    const dst = bitmap.rgba;
    const da = dst[index + 3] / 255;
    const outA = a + da * (1 - a);
    if (outA <= 0)
        return;
    const mix = (source, target) => clampByte((source * a + target * da * (1 - a)) / outA);
    dst[index] = mix(color[0], dst[index]);
    dst[index + 1] = mix(color[1], dst[index + 1]);
    dst[index + 2] = mix(color[2], dst[index + 2]);
    dst[index + 3] = clampByte(outA * 255);
}
export function fillRect(bitmap, x, y, width, height, color, alpha = 1) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(bitmap.width, Math.ceil(x + width));
    const y1 = Math.min(bitmap.height, Math.ceil(y + height));
    for (let py = y0; py < y1; py++)
        for (let px = x0; px < x1; px++)
            blendPixel(bitmap, px, py, color, alpha);
}
export function strokeRect(bitmap, x, y, width, height, color, alpha = 1, thickness = 1) {
    const t = Math.max(1, Math.round(thickness));
    fillRect(bitmap, x, y, width, t, color, alpha);
    fillRect(bitmap, x, y + height - t, width, t, color, alpha);
    fillRect(bitmap, x, y, t, height, color, alpha);
    fillRect(bitmap, x + width - t, y, t, height, color, alpha);
}
/** Bresenham 直线，厚度用方形刷子近似。 */
export function drawLine(bitmap, x0, y0, x1, y1, color, alpha = 1, thickness = 1) {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx - dy;
    const t = Math.max(1, Math.round(thickness));
    const half = Math.floor((t - 1) / 2);
    while (true) {
        fillRect(bitmap, ax - half, ay - half, t, t, color, alpha);
        if (ax === bx && ay === by)
            break;
        const e2 = err * 2;
        if (e2 > -dy) {
            err -= dy;
            ax += sx;
        }
        if (e2 < dx) {
            err += dx;
            ay += sy;
        }
    }
}
export function fillCircle(bitmap, cx, cy, radius, color, alpha = 1) {
    const r = Math.max(0, radius);
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy <= r * r)
                blendPixel(bitmap, x, y, color, alpha);
        }
    }
}
export function strokeCircle(bitmap, cx, cy, radius, color, alpha = 1, thickness = 1) {
    const r = Math.max(0, radius);
    const inner = Math.max(0, r - Math.max(1, thickness));
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 <= r * r && d2 >= inner * inner)
                blendPixel(bitmap, x, y, color, alpha);
        }
    }
}
/** 2:1 菱形（等距地格 / 地图 cell 轮廓）。 */
export function fillDiamond(bitmap, cx, cy, rx, ry, color, alpha = 1) {
    if (rx <= 0 || ry <= 0)
        return;
    for (let dy = -ry; dy <= ry; dy++) {
        const half = rx * (1 - Math.abs(dy) / ry);
        const x0 = Math.round(cx - half);
        const x1 = Math.round(cx + half);
        for (let x = x0; x <= x1; x++)
            blendPixel(bitmap, x, cy + dy, color, alpha);
    }
}
export function strokeDiamond(bitmap, cx, cy, rx, ry, color, alpha = 1, thickness = 1) {
    drawLine(bitmap, cx - rx, cy, cx, cy - ry, color, alpha, thickness);
    drawLine(bitmap, cx, cy - ry, cx + rx, cy, color, alpha, thickness);
    drawLine(bitmap, cx + rx, cy, cx, cy + ry, color, alpha, thickness);
    drawLine(bitmap, cx, cy + ry, cx - rx, cy, color, alpha, thickness);
}
/** 3×5 点阵数字；只画 0-9，其他字符留空。 */
const DIGITS = {
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "010", "010", "010"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"]
};
/**
 * 以 (cx,cy) 为中心画一串数字。`height` 是字高（像素），宽度按 3:5 推。
 * 返回实际绘制宽度，方便调用方排版。
 */
export function drawDigits(bitmap, text, cx, cy, height, color, alpha = 1) {
    const chars = String(text).split("").filter((char) => DIGITS[char] !== undefined);
    if (chars.length === 0)
        return 0;
    const scale = Math.max(1, Math.floor(Math.max(1, height) / 5));
    const glyphWidth = 3 * scale;
    const gap = scale;
    const total = chars.length * glyphWidth + (chars.length - 1) * gap;
    let x = Math.round(cx - total / 2);
    const y = Math.round(cy - (5 * scale) / 2);
    for (const char of chars) {
        const rows = DIGITS[char];
        for (let row = 0; row < 5; row++) {
            for (let col = 0; col < 3; col++) {
                if (rows[row][col] === "1")
                    fillRect(bitmap, x + col * scale, y + row * scale, scale, scale, color, alpha);
            }
        }
        x += glyphWidth + gap;
    }
    return total;
}
/** 棋盘格背景（透明图在聊天里不容易看清；检查图默认铺一层很淡的格）。 */
export function checkerBackground(bitmap, size = 8, light = [244, 244, 244], dark = [224, 224, 224]) {
    const cell = Math.max(1, Math.round(size));
    for (let y = 0; y < bitmap.height; y++) {
        const rowDark = Math.floor(y / cell) % 2 === 1;
        for (let x = 0; x < bitmap.width; x++) {
            const color = (Math.floor(x / cell) % 2 === 1) !== rowDark ? light : dark;
            const index = (y * bitmap.width + x) * 4;
            bitmap.rgba[index] = color[0];
            bitmap.rgba[index + 1] = color[1];
            bitmap.rgba[index + 2] = color[2];
            bitmap.rgba[index + 3] = 255;
        }
    }
}
