/**
 * SSTV 通道 → sRGB 转换。
 * YUV 公式与 node-sstv 编码器(rgb2yuv)严格互逆,保证自发自收测试可往返。
 */
import { ImageBuffer } from './stream-decoder';

export interface RgbaPixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** RGB → YUV(BT.601 全范围,与编码器一致)。 */
export function rgbToYuv(r: number, g: number, b: number): [number, number, number] {
  return [
    16 + 0.003906 * (65.738 * r + 129.057 * g + 25.064 * b),
    128 + 0.003906 * (112.439 * r - 94.154 * g - 18.285 * b),
    128 + 0.003906 * (-37.945 * r - 74.494 * g + 112.439 * b),
  ];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 把 ImageBuffer 的各平面合成 RGBA。
 * @param out 长度必须为 width*height*4
 * @param markPatched 是否在补全像素上叠加醒目标记(红色斜纹)
 */
export function composeRgba(
  img: ImageBuffer,
  out: Uint8ClampedArray,
  markPatched = true,
): Uint8ClampedArray {
  const { mode, width, height } = img;
  const get = (kind: Parameters<ImageBuffer['plane']>[0], x: number, y: number) =>
    img.plane(kind)[y * width + x];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;

      if (mode.color === 'GBR') {
        r = get('R', x, y);
        g = get('G', x, y);
        b = get('B', x, y);
      } else {
        // YUV: PD120 每行有独立 Y;Robot36 偶数行 Y、奇数行 Y_EVEN,
        // U/V 在组内以半速率发送、两行共享。
        const yPlane = img.planes.get('Y_EVEN') && y % 2 === 1 ? 'Y_EVEN' : 'Y';
        const Y = get(yPlane, x, y);
        // 对 Robot36: U 来自偶数行段、V 来自奇数行段,合成时取最近的组值
        let U: number;
        let V: number;
        if (mode.id === 'ROBOT36') {
          const pairBase = y % 2 === 1 ? y - 1 : y;
          U = get('U', x, pairBase);
          V = get('V', x, pairBase);
        } else {
          // PD120: U/V 是两行平均值,直接按组首行存储
          const pairBase = y % 2 === 1 ? y - 1 : y;
          U = get('U', x, pairBase);
          V = get('V', x, pairBase);
        }
        r = Y + 1.402 * (V - 128);
        g = Y - 0.344136 * (U - 128) - 0.714136 * (V - 128);
        b = Y + 1.772 * (U - 128);
      }

      const idx = (y * width + x) * 4;
      out[idx] = clamp255(r);
      out[idx + 1] = clamp255(g);
      out[idx + 2] = clamp255(b);
      out[idx + 3] = 255;

      if (markPatched && img.patched[y * width + x]) {
        // 红色斜纹:每 4 个像素中的对角点染红,保持底图可见
        if ((x + y) % 4 === 0) {
          out[idx] = 255;
          out[idx + 1] = 40;
          out[idx + 2] = 40;
        }
      }
    }
  }
  return out;
}

/** 纯 GBR 平面合成(无标记),导出"干净版"PNG 用。 */
export function composeRgbaClean(img: ImageBuffer, out: Uint8ClampedArray): Uint8ClampedArray {
  return composeRgba(img, out, false);
}
