/**
 * 测试信道模拟器:
 *  - 加性高斯白噪声(AWGN),按目标 SNR(dB)标定
 *  - 信号断续(模拟电台信号消失几秒后回来),可配置多段
 *  - 恒定频率偏移(电台频差)
 *  - 可选多径回声(短波选择性衰落的简化模型)
 */

/** 可复现的 PRNG (xorshift32),测试需要确定性。 */
export class Rng {
  private state: number;

  constructor(seed = 0x12345678) {
    this.state = seed >>> 0 || 1;
  }

  /** [0,1) 均匀分布 */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }

  /** 高斯分布 (Box-Muller) */
  gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export interface DropoutSegment {
  /** 起始时间(秒) */
  startSec: number;
  /** 持续时间(秒) */
  durationSec: number;
}

export interface ChannelOptions {
  /** 目标信噪比 dB(信号满幅正弦功率为 0.5) */
  snrDb: number;
  dropouts?: DropoutSegment[];
  /** 载波频率偏移 Hz,默认 0 */
  freqOffsetHz?: number;
  /** 回声幅度比例 0..1,默认 0(关闭) */
  echoAlpha?: number;
  /** 回声延迟(秒) */
  echoDelaySec?: number;
  seed?: number;
}

export function applyChannel(
  pcm: Float32Array,
  sampleRate: number,
  opts: ChannelOptions,
): Float32Array {
  const rng = new Rng(opts.seed ?? 42);
  const out = new Float32Array(pcm.length);

  // 信号功率(满幅正弦 ≈ 0.5)
  const signalPower = 0.5;
  const noisePower = signalPower / 10 ** (opts.snrDb / 10);
  const noiseSigma = Math.sqrt(noisePower);

  const echoAlpha = opts.echoAlpha ?? 0;
  const echoN = Math.round((opts.echoDelaySec ?? 0) * sampleRate);
  const dPhase = opts.freqOffsetHz
    ? (2 * Math.PI * opts.freqOffsetHz) / sampleRate
    : 0;
  let phase = 0;

  const dropouts = (opts.dropouts ?? [])
    .map((d) => ({
      start: Math.round(d.startSec * sampleRate),
      end: Math.round((d.startSec + d.durationSec) * sampleRate),
    }))
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i];
    if (echoAlpha > 0 && echoN > 0 && i >= echoN) {
      s += echoAlpha * pcm[i - echoN];
    }
    if (dPhase) {
      // 频偏: 频谱搬移(乘本振)
      s = s * Math.cos(phase);
      phase += dPhase;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
    // 噪声始终存在(包括断流段,模拟真实底噪)
    const noise = rng.gaussian() * noiseSigma;
    let sample = s + noise;

    for (const d of dropouts) {
      if (i >= d.start && i < d.end) {
        // 断流: 信号消失,只剩噪声;用 0.15 系数模拟电台静噪但非绝对零
        sample = noise * 0.15 + rng.gaussian() * noiseSigma * 0.25;
        break;
      }
    }
    // 软限幅,防止叠加后削顶过硬
    out[i] = Math.tanh(sample);
  }
  return out;
}

/** 测量一段 PCM 的实测 SNR(dB),用于测试断言。 */
export function measureSnr(clean: Float32Array, noisy: Float32Array): number {
  let sigPow = 0;
  let errPow = 0;
  for (let i = 0; i < clean.length; i++) {
    sigPow += clean[i] * clean[i];
    const e = noisy[i] - clean[i];
    errPow += e * e;
  }
  if (errPow === 0) return Infinity;
  return 10 * Math.log10(sigPow / errPow);
}
