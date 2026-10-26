/**
 * 把一张图里的「角色 + 道具」重新摆到画布中间，并留出一圈余量。
 *
 * 为什么需要这个：动作视频（母本 / 关键帧转圈）都是**图生视频**——模型照着首帧
 * 画，首帧里角色占到画面边缘，模型就没有地方放挥出去的手臂和武器，结果刀被画面
 * 边缘切掉（实测：挥砍第 1 列的刀整截不见）。首帧先缩到 70% 并居中，模型的可用
 * 余量翻倍，切边概率大幅下降；整图合成时又会按内容框放大回格子尺寸，分辨率不亏。
 *
 * 判定「什么算内容」：有 alpha 的图按 alpha；绿幕图按色度（纯绿 #00FF00 附近算背景）。
 * 两者都不满足的像素（比如角色身上的深绿）一律算内容——宁可多留一点余量，
 * 也不要把角色的深色部分当成背景裁掉。
 */
import type { BoundingBox } from "./chroma.js";

export interface FrameFitOptions {
  /** 内容在两个方向上最多占画布的比例（0~1）。 */
  ratio?: number;
  /** 底部留白（占画布高度的比例），贴底放置，脚底落在同一条基线上。 */
  bottomMargin?: number;
  /** 垫底色（默认纯绿幕 #00FF00）。 */
  background?: [number, number, number];
  /** 允许的最大放大倍数：原图内容本来就小的时候别硬放大（糊）。 */
  maxUpscale?: number;
}

export interface FrameFitResult {
  rgba: Buffer;
  width: number;
  height: number;
  /** 原图里内容的外接框。 */
  box: BoundingBox;
  /** 实际缩放比（1 = 没缩放）。 */
  scale: number;
  /** 原图的内容已经贴到画面边缘了——说明**这张图本身**就被裁过。 */
  touchedEdge: boolean;
  /** 整张图都是背景（没找到内容）。 */
  empty: boolean;
}

/**
 * 内容占比的默认值。
 *
 * 0.78 = 单边约 11% 余量。别调太小：实测缩到 0.7 时模型反而会给角色配一把
 * 夸张的发光巨剑来「填满画面」，武器本身变形比切边更糟。0.78 既留出挥动
 * 空间，又不至于让角色在首帧里显得过小。
 */
export const FRAME_FIT_RATIO = 0.78;

/** 判断这一个像素算不算「背景」（纯绿幕 / 全透明）。 */
function isBackground(rgba: Buffer, offset: number): boolean {
  const alpha = rgba[offset + 3];
  if (alpha < 12) return true;
  const r = rgba[offset];
  const g = rgba[offset + 1];
  const b = rgba[offset + 2];
  // 标准 chroma key 绿 #00FF00：允许一点噪点，但不允许把「深绿」当背景。
  return g >= 190 && r <= 80 && b <= 80;
}

/** 找出所有非背景像素的外接框。 */
export function contentBox(rgba: Buffer, width: number, height: number): BoundingBox {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (isBackground(rgba, offset)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, width: 0, height: 0, empty: true };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, empty: false };
}

/** 内容是否贴到了画面边缘（贴边 = 这张图很可能已经被裁掉一部分）。 */
export function touchesEdge(box: BoundingBox, width: number, height: number): boolean {
  if (box.empty) return false;
  const pad = 1;
  return box.x <= pad || box.y <= pad || box.x + box.width >= width - pad || box.y + box.height >= height - pad;
}

/** 双线性采样一个像素（源坐标用浮点，越界按边缘夹住）。 */
function sampleBilinear(rgba: Buffer, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const at = (px: number, py: number) => (py * width + px) * 4;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel++) {
    const a = rgba[at(x0, y0) + channel];
    const b = rgba[at(x1, y0) + channel];
    const c = rgba[at(x0, y1) + channel];
    const d = rgba[at(x1, y1) + channel];
    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;
    out[channel] = Math.round(top + (bottom - top) * fy);
  }
  return out;
}

/**
 * 把内容缩到 `ratio` 并居中贴底，垫上背景色返回一张新图。
 *
 * 不做任何「找地面 / 猜朝向」的事：单纯按内容外接框缩放居中，所以对任何姿势都稳。
 */
export function fitFrameContent(
  rgba: Buffer,
  width: number,
  height: number,
  options: FrameFitOptions = {}
): FrameFitResult {
  const ratio = Math.max(0.2, Math.min(1, options.ratio ?? FRAME_FIT_RATIO));
  const bottomMargin = Math.max(0, Math.min(0.3, options.bottomMargin ?? 0.04));
  const background = options.background ?? [0, 255, 0];
  const maxUpscale = Math.max(0.2, options.maxUpscale ?? 1);

  const box = contentBox(rgba, width, height);
  if (box.empty) {
    return {
      rgba: Buffer.from(rgba),
      width,
      height,
      box,
      scale: 1,
      touchedEdge: false,
      empty: true
    };
  }

  const availWidth = width * ratio;
  const availHeight = height * ratio;
  const scale = Math.min(availWidth / box.width, availHeight / box.height, maxUpscale);
  const destWidth = Math.max(1, Math.round(box.width * scale));
  const destHeight = Math.max(1, Math.round(box.height * scale));
  const destX = Math.round((width - destWidth) / 2);
  const destY = Math.round(height - bottomMargin * height - destHeight);

  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = background[0];
    out[i * 4 + 1] = background[1];
    out[i * 4 + 2] = background[2];
    out[i * 4 + 3] = 255;
  }

  const stepX = box.width / destWidth;
  const stepY = box.height / destHeight;
  for (let dy = 0; dy < destHeight; dy++) {
    const ty = destY + dy;
    if (ty < 0 || ty >= height) continue;
    for (let dx = 0; dx < destWidth; dx++) {
      const tx = destX + dx;
      if (tx < 0 || tx >= width) continue;
      const [r, g, b, a] = sampleBilinear(rgba, width, height, box.x + (dx + 0.5) * stepX - 0.5, box.y + (dy + 0.5) * stepY - 0.5);
      // 半透明边缘按 alpha 混到底色上：视频后端只吃不透明帧，直接扔 alpha 会出黑边。
      const alpha = a / 255;
      const offset = (ty * width + tx) * 4;
      out[offset] = Math.round(r * alpha + background[0] * (1 - alpha));
      out[offset + 1] = Math.round(g * alpha + background[1] * (1 - alpha));
      out[offset + 2] = Math.round(b * alpha + background[2] * (1 - alpha));
      out[offset + 3] = 255;
    }
  }

  return { rgba: out, width, height, box, scale, touchedEdge: touchesEdge(box, width, height), empty: false };
}
