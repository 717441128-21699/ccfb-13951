/**
 * 流式重采样器:任意输入采样率 → 内部固定 12kHz。
 * 采用线性插值,配合输入端抗混叠低通(音频接口侧或 worklet 内的 IIR)。
 * SSTV 有效频带 1100~2300Hz,12kHz 奈奎斯特频率 6kHz 余量充足。
 */
export class Resampler {
  private ratio: number;
  private pos = 0;
  private prev = 0;
  private out: number[] = [];

  constructor(
    public readonly inputRate: number,
    public readonly outputRate = 12000,
  ) {
    this.ratio = inputRate / outputRate;
  }

  push(samples: Float32Array): Float32Array {
    this.out.length = 0;
    // pos 以输入采样点为单位,表示下一个输出样本在输入流上的位置
    for (;;) {
      const i0 = Math.floor(this.pos);
      if (i0 >= samples.length) break;
      const frac = this.pos - i0;
      const s0 = i0 === 0 ? this.prev : samples[i0 - 1];
      const s1 = samples[i0];
      this.out.push(s0 + (s1 - s0) * frac);
      this.pos += this.ratio;
    }
    // 保留最后一个样本供下一块插值,并把 pos 移到块相对坐标
    this.pos -= samples.length - 1;
    this.prev = samples[samples.length - 1] ?? this.prev;
    return Float32Array.from(this.out);
  }

  reset(): void {
    this.pos = 0;
    this.prev = 0;
  }
}
