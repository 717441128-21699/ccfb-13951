/**
 * SSTV 测试信号编码器。
 *
 * 与解码器共用 modes.ts 的同一份时序常量,输出相位连续的正弦波 PCM,
 * 支持四种模式: Martin1/Scottie1/Robot36/PD120。
 * 用途: 生成标准测试音频,再经 channel.ts 加噪声/断续后喂给解码器做闭环测试。
 */
import {
  FREQ_LEADER,
  FREQ_SYNC,
  FREQ_VIS_0,
  FREQ_VIS_1,
  FREQ_PORCH,
  HEADER_BREAK,
  HEADER_LEADER,
  HEADER_VIS_BIT,
  HEADER_VIS_START,
  lumaToFreq,
  MODES,
} from './modes';
import type { SSTVModeSpec } from './modes';
import { rgbToYuv } from './colorspace';

export interface RgbImage {
  width: number;
  height: number;
  /** 行优先 RGB,每像素 3 字节 */
  data: Uint8ClampedArray;
}

export class SstvEncoder {
  private phase = 0;
  private out: number[] = [];

  constructor(public sampleRate = 12000) {}

  private tone(freq: number, durationSec: number): void {
    const n = Math.round(durationSec * this.sampleRate);
    const dPhase = (2 * Math.PI * freq) / this.sampleRate;
    for (let i = 0; i < n; i++) {
      this.out.push(Math.sin(this.phase));
      this.phase += dPhase;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    }
  }

  private calibrationHeader(vis: number): void {
    this.tone(FREQ_LEADER, HEADER_LEADER);
    this.tone(FREQ_SYNC, HEADER_BREAK);
    this.tone(FREQ_LEADER, HEADER_LEADER);
    this.tone(FREQ_SYNC, HEADER_VIS_START);
    let ones = 0;
    for (let b = 0; b < 7; b++) {
      const bit = (vis >> b) & 1;
      if (bit) ones++;
      this.tone(bit ? FREQ_VIS_1 : FREQ_VIS_0, HEADER_VIS_BIT);
    }
    // 偶校验位
    this.tone(ones % 2 === 0 ? FREQ_VIS_0 : FREQ_VIS_1, HEADER_VIS_BIT);
    this.tone(FREQ_SYNC, HEADER_VIS_BIT); // stop
  }

  private scan(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) {
      this.tone(lumaToFreq(values[i]), 1 / this.sampleRate);
    }
  }

  /**
   * 相位连续地生成一段指定频率的样本,写入给定数组的 [start, start+n)。
   * 段间通过传入/返回相位对象保持衔接,杜绝 sin(2πft) 绝对时间造成的相位跳变。
   */
  private writeTone(buf: number[], start: number, n: number, freq: number, phase: { p: number }): void {
    const dPhase = (2 * Math.PI * freq) / this.sampleRate;
    for (let i = 0; i < n; i++) {
      buf[start + i] = Math.sin(phase.p);
      phase.p += dPhase;
      if (phase.p > 2 * Math.PI) phase.p -= 2 * Math.PI;
    }
  }

  /** 相位连续地写入一段亮度扫描。 */
  private writeScan(buf: number[], start: number, values: ArrayLike<number>, phase: { p: number }): void {
    for (let i = 0; i < values.length; i++) {
      this.writeTone(buf, start + i, 1, lumaToFreq(values[i]), phase);
    }
  }

  /** 编码整张图,返回 PCM(幅度 ±1)。 */
  encode(image: RgbImage, modeId: keyof typeof MODES): Float32Array {
    const mode = MODES[modeId];
    this.out = [];
    this.phase = 0;
    this.calibrationHeader(mode.vis);

    if (mode.color === 'GBR') {
      this.encodeGbr(image, mode);
    } else {
      this.encodeYuv(image, mode);
    }
    return Float32Array.from(this.out);
  }

  private planeAt(image: RgbImage, x: number, y: number, c: number): number {
    return image.data[(y * image.width + x) * 3 + c];
  }

  /** 按模式时序在同步起点网格上排程各段,保证编码/解码网格一致。 */
  private emitSegment(image: RgbImage, mode: SSTVModeSpec, y: number, kind: string, width: number, halfRow?: number): void {
    const values = new Uint8ClampedArray(width);
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x / width) * image.width));
      if (mode.color === 'GBR') {
        const c = kind === 'G' ? 1 : kind === 'B' ? 2 : 0;
        values[x] = this.planeAt(image, sx, y, c);
      } else {
        const r = this.planeAt(image, sx, halfRow ?? y, 0);
        const g = this.planeAt(image, sx, halfRow ?? y, 1);
        const b = this.planeAt(image, sx, halfRow ?? y, 2);
        const [Y, U, V] = rgbToYuv(r, g, b);
        values[x] = kind === 'Y' || kind === 'Y_EVEN' ? Y : kind === 'U' ? U : V;
      }
    }
    this.scan(values);
  }

  private encodeGbr(image: RgbImage, mode: SSTVModeSpec): void {
    const lineN = Math.round(mode.lineTime * this.sampleRate);
    // 段按 offset 排序,顺序发射;段间空隙填 porch,全程相位连续
    const ordered = [...mode.segments].sort((a, b) => a.offset - b.offset);
    for (let y = 0; y < mode.height; y++) {
      const line = new Array<number>(lineN).fill(0);
      const phase = { p: this.phase };
      let cursor = 0;
      // 行首 sync
      const syncN = Math.round(mode.syncPulse * this.sampleRate);
      this.writeTone(line, cursor, syncN, FREQ_SYNC, phase);
      cursor += syncN;
      for (const seg of ordered) {
        const segStart = Math.round(seg.offset * this.sampleRate);
        // 段前空隙(porch / separator,均为 1500Hz)
        if (segStart > cursor) {
          this.writeTone(line, cursor, segStart - cursor, FREQ_PORCH, phase);
          cursor = segStart;
        }
        const values = this.segmentLuma(image, mode, y, seg.kind, seg.width);
        this.writeScan(line, cursor, values, phase);
        cursor += values.length;
      }
      // 行尾补 porch 到完整行周期
      if (cursor < lineN) this.writeTone(line, cursor, lineN - cursor, FREQ_PORCH, phase);
      this.phase = phase.p;
      for (const v of line) this.out.push(v);
    }
  }

  /** 取某一行某通道(GBR)的亮度数组。 */
  private segmentLuma(image: RgbImage, mode: SSTVModeSpec, y: number, kind: string, width: number): Uint8ClampedArray {
    const values = new Uint8ClampedArray(width);
    const c = kind === 'G' ? 1 : kind === 'B' ? 2 : 0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x / width) * image.width));
      values[x] = this.planeAt(image, sx, y, c);
    }
    void mode;
    return values;
  }

  private encodeYuv(image: RgbImage, mode: SSTVModeSpec): void {
    const groupN = Math.round(mode.lineTime * this.sampleRate);
    const groups = Math.ceil(mode.height / mode.linesPerGroup);
    for (let g = 0; g < groups; g++) {
      const groupStart = this.out.length;
      this.tone(FREQ_SYNC, mode.syncPulse);
      const y0 = g * mode.linesPerGroup;
      const y1 = Math.min(mode.height - 1, y0 + 1);

      for (const seg of mode.segments) {
        const pos = groupStart + Math.round(seg.offset * this.sampleRate);
        while (this.out.length < pos) this.tone(FREQ_PORCH, 1 / this.sampleRate);
        if (seg.kind === 'U' || seg.kind === 'V') {
          // 两行平均
          const avg = new Uint8ClampedArray(seg.width);
          for (let x = 0; x < seg.width; x++) {
            const sx = Math.min(image.width - 1, Math.floor((x / seg.width) * image.width));
            const p0 = rgbToYuv(
              this.planeAt(image, sx, Math.min(y0, image.height - 1), 0),
              this.planeAt(image, sx, Math.min(y0, image.height - 1), 1),
              this.planeAt(image, sx, Math.min(y0, image.height - 1), 2),
            );
            const p1 = rgbToYuv(
              this.planeAt(image, sx, y1, 0),
              this.planeAt(image, sx, y1, 1),
              this.planeAt(image, sx, y1, 2),
            );
            const ci = seg.kind === 'U' ? 1 : 2;
            avg[x] = (p0[ci] + p1[ci]) / 2;
          }
          this.scan(avg);
        } else {
          const row = seg.kind === 'Y_EVEN' ? y1 : y0;
          this.emitSegment(image, mode, Math.min(row, image.height - 1), seg.kind, seg.width);
        }
      }
      while (this.out.length < groupStart + groupN) this.tone(FREQ_PORCH, 1 / this.sampleRate);
    }
  }
}
