/**
 * 标准测试图样生成(纯代码,不依赖图片资源)。
 */
import type { RgbImage } from '../sstv/encoder';

/** SMPTE 风格彩条 + 灰度阶梯 + 圆形图案,适合肉眼和数值比对。 */
export function makeTestPattern(width: number, height: number): RgbImage {
  const data = new Uint8ClampedArray(width * height * 3);
  const bars = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
    [0, 0, 0],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      if (y < height * 0.6) {
        // 上 60%: 竖彩条
        const bar = Math.min(bars.length - 1, Math.floor((x / width) * bars.length));
        data[idx] = bars[bar][0];
        data[idx + 1] = bars[bar][1];
        data[idx + 2] = bars[bar][2];
      } else if (y < height * 0.8) {
        // 中 20%: 灰度阶梯
        const step = Math.floor((x / width) * 8);
        const v = Math.round((step / 7) * 255);
        data[idx] = data[idx + 1] = data[idx + 2] = v;
      } else {
        // 下 20%: 中心圆 + 纯色背景
        const cx = width / 2;
        const cy = height * 0.9;
        const r = height * 0.08;
        const d = Math.hypot(x - cx, y - cy);
        if (d < r) {
          data[idx] = 255;
          data[idx + 1] = 128;
          data[idx + 2] = 0;
        } else {
          data[idx] = 24;
          data[idx + 1] = 48;
          data[idx + 2] = 96;
        }
      }
    }
  }
  return { width, height, data };
}

/** 渐变图(平滑色调,考验频率跟随)。 */
export function makeGradient(width: number, height: number): RgbImage {
  const data = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      data[idx] = Math.round((x / width) * 255);
      data[idx + 1] = Math.round((y / height) * 255);
      data[idx + 2] = Math.round(((x + y) / (width + height)) * 255);
    }
  }
  return { width, height, data };
}

/** 呼号文字风格的几何图(横竖线条,检验错行/半行偏移)。 */
export function makeGridPattern(width: number, height: number): RgbImage {
  const data = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const on = x % 32 < 2 || y % 32 < 2;
      const v = on ? 255 : 32;
      data[idx] = v;
      data[idx + 1] = on ? 255 : 64;
      data[idx + 2] = on ? 255 : 128;
    }
  }
  return { width, height, data };
}
