/**
 * 数字滤波器集合,全部为流式/可复用设计,无外部依赖。
 */

/** 一阶 IIR 高通,用于去除声卡直流偏移和亚音频噪声。 */
export class HighPassIir {
  private x1 = 0;
  private y1 = 0;
  private readonly alpha: number;

  constructor(cutoffHz: number, sampleRate: number) {
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sampleRate;
    this.alpha = rc / (rc + dt);
  }

  process(x: number): number {
    const y = this.alpha * (this.y1 + x - this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/** 二阶 IIR 低通 (RBJ biquad, LPF),用于抗混叠与解调后平滑。 */
export class LowPassBiquad {
  private b0 = 0; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0;
  private y1 = 0; private y2 = 0;

  constructor(cutoffHz: number, sampleRate: number, q = 0.707) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    const alpha = sinw / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cosw) / 2 / a0;
    this.b1 = (1 - cosw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  /** 整块处理,避免逐样本方法调用开销(热路径使用)。 */
  processBlock(inp: Float32Array, out: Float32Array): Float32Array {
    const { b0, b1, b2, a1, a2 } = this;
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
    for (let i = 0; i < inp.length; i++) {
      const x = inp[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
    return out;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** 带通:高通 + 低通级联,限定 SSTV 工作频带。 */
export class BandPass {
  private readonly hp: HighPassIir;
  private readonly lp: LowPassBiquad;

  constructor(lowHz: number, highHz: number, sampleRate: number) {
    this.hp = new HighPassIir(lowHz, sampleRate);
    this.lp = new LowPassBiquad(highHz, sampleRate);
  }

  processBlock(inp: Float32Array, out: Float32Array): Float32Array {
    for (let i = 0; i < inp.length; i++) out[i] = this.hp.process(inp[i]);
    return this.lp.processBlock(out, out);
  }

  reset(): void {
    this.hp.reset();
    this.lp.reset();
  }
}

/** 滑动平均(矩形窗),解调后去毛刺用。 */
export class MovingAverage {
  private buf: Float32Array;
  private sum = 0;
  private idx = 0;
  private filled = 0;

  constructor(windowSamples: number) {
    this.buf = new Float32Array(Math.max(1, windowSamples));
  }

  process(x: number): number {
    const n = this.buf.length;
    this.sum += x - this.buf[this.idx];
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % n;
    if (this.filled < n) this.filled++;
    return this.sum / this.filled;
  }

  reset(): void {
    this.buf.fill(0);
    this.sum = 0;
    this.idx = 0;
    this.filled = 0;
  }
}

/** 中值滤波(窗长 3 或 5),消除孤立频点跳变且不模糊同步边沿。 */
export class MedianFilter {
  private hist: number[];
  private readonly w: number;

  constructor(windowSize: 3 | 5 = 5) {
    this.w = windowSize;
    this.hist = new Array(windowSize).fill(0);
  }

  process(x: number): number {
    this.hist.copyWithin(0, 1);
    this.hist[this.w - 1] = x;
    const sorted = [...this.hist].sort((a, b) => a - b);
    return sorted[this.w >> 1];
  }

  reset(): void {
    this.hist.fill(0);
  }
}
