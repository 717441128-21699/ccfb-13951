/**
 * FM 频偏解调器(复数混频正交法)。
 *
 * 原理:
 *   1. 输入分别乘 cos(ω₀t) 与 -sin(ω₀t),得到复基带 I/Q(ω₀=1700Hz);
 *   2. I/Q 各过低通,滤除 +2ω₀ 的镜像边带;
 *   3. atan2 求瞬时相位,一阶差分解缠绕 → 瞬时频率。
 *
 * 这是标准的 I/Q 解调结构,实数输入做复数混频后镜像分量位于 3400Hz,
 * 被 950Hz 基带低通干净滤除。逐样本 O(n)。
 * FIR 采用中心对齐(零群延迟)实现:内部保留 mid 个前瞻样本,
 * 使第 i 个输出严格对应第 i 个输入时刻,块边界由内部历史缓冲衔接。
 *
 * SSTV 是直接频率调制: 1500Hz=黑, 2300Hz=白, 1200Hz=同步。
 */

export const DEMOD_CARRIER = 1700;
/**
 * 基带低通截止。复数混频后镜像频率 = 2·f₀ - f_in:
 *   f_in=1200 → 镜像 2200Hz;f_in=2300 → 镜像 1100Hz。
 * 取 950Hz 截止可同时压住两侧镜像,而 SSTV 基带最高 2300-1700=600Hz,余量充足。
 */
const DEMOD_LP_CUTOFF = 950;
const LP_TAPS = 31;
const LP_MID = (LP_TAPS - 1) / 2;

/** 窗函数法 FIR 低通(sinc 加 Hann 窗),通带平坦、无自激谐振。 */
function makeFirLowpass(cutoffHz: number, sampleRate: number, taps: number): Float32Array {
  const wc = (2 * Math.PI * cutoffHz) / sampleRate;
  const mid = (taps - 1) / 2;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - mid;
    const sinc = k === 0 ? wc / Math.PI : Math.sin(wc * k) / (Math.PI * k);
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (taps - 1)));
    h[n] = sinc * win;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum; // 归一化,通带增益=1
  return h;
}

/**
 * 因果 FIR 低通,群延迟固定为 LP_MID 个样本。
 * 解调器总延迟(含 atan2 差分 1 样本)由 DEMOD_GROUP_DELAY 暴露,
 * 上层在定位 VIS/同步锚点时按此补偿,块间历史由内部缓冲自然衔接。
 */
class FirLowpass {
  private readonly taps: Float32Array;
  private readonly delay: Float32Array;

  constructor(cutoffHz: number, sampleRate: number) {
    this.taps = makeFirLowpass(cutoffHz, sampleRate, LP_TAPS);
    this.delay = new Float32Array(LP_TAPS);
  }

  process(x: number): number {
    this.delay.copyWithin(1, 0, LP_TAPS - 1);
    this.delay[0] = x;
    let acc = 0;
    for (let k = 0; k < LP_TAPS; k++) acc += this.delay[k] * this.taps[k];
    return acc;
  }

  reset(): void {
    this.delay.fill(0);
  }
}

/** 解调器固定群延迟(样本数): FIR 中心延迟 + 相位差分 1 样本。 */
export const DEMOD_GROUP_DELAY = LP_MID + 1;

export class FmDemodulator {
  private oscPhase = 0;
  private readonly dPhase: number;
  private lpI: FirLowpass;
  private lpQ: FirLowpass;
  private prevAngle = 0;
  private started = false;

  constructor(public readonly sampleRate: number = 12000) {
    this.dPhase = (2 * Math.PI * DEMOD_CARRIER) / sampleRate;
    this.lpI = new FirLowpass(DEMOD_LP_CUTOFF, sampleRate);
    this.lpQ = new FirLowpass(DEMOD_LP_CUTOFF, sampleRate);
  }

  /**
   * 输入一块音频样本,输出等长的瞬时频率序列(Hz)。
   * 输出缓冲由调用方提供并可复用。
   */
  process(input: Float32Array, out: Float32Array): Float32Array {
    const n = input.length;
    const dt = 1 / this.sampleRate;
    let { oscPhase, prevAngle } = this;
    const { dPhase } = this;

    for (let i = 0; i < n; i++) {
      const x = input[i];
      // 1. 复数混频: I=x·cos, Q=-x·sin
      const cos = Math.cos(oscPhase);
      const sin = Math.sin(oscPhase);
      oscPhase += dPhase;
      if (oscPhase > 2 * Math.PI) oscPhase -= 2 * Math.PI;

      // 2. 镜像边带低通(两路滤波器结构相同,群延迟一致)
      const bi = this.lpI.process(x * cos);
      const bq = this.lpQ.process(-x * sin);

      // 3. 瞬时相位 + 差分频率
      const angle = Math.atan2(bq, bi);
      let dAngle: number;
      if (!this.started) {
        dAngle = 0;
        this.started = true;
      } else {
        dAngle = angle - prevAngle;
        if (dAngle > Math.PI) dAngle -= 2 * Math.PI;
        else if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
      }
      prevAngle = angle;
      out[i] = DEMOD_CARRIER + dAngle / (2 * Math.PI * dt);
    }
    this.oscPhase = oscPhase;
    this.prevAngle = prevAngle;
    return out;
  }

  reset(): void {
    this.oscPhase = 0;
    this.prevAngle = 0;
    this.started = false;
    this.lpI.reset();
    this.lpQ.reset();
  }
}

/** 短时 RMS 电平估计,用于静音/信号丢失检测。 */
export class RmsEstimator {
  private acc = 0;
  private count = 0;
  private current = 0;

  constructor(private windowSamples: number) {}

  pushBlock(block: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    this.acc += sum;
    this.count += block.length;
    if (this.count >= this.windowSamples) {
      this.current = Math.sqrt(this.acc / this.count);
      this.acc = 0;
      this.count = 0;
    }
  }

  get rms(): number {
    return this.count > 4 ? Math.sqrt(this.acc / this.count) : this.current;
  }

  reset(): void {
    this.acc = 0;
    this.count = 0;
    this.current = 0;
  }
}

export interface SnrEstimate {
  snrDb: number;
  signalPower: number;
  noisePower: number;
}

/**
 * 轻量 SNR 估计:用恒音区(同步/porch)的解调频率方差衡量噪声。
 * 恒音区理论频率方差为 0,噪声越大抖动越大。
 */
export class SnrEstimator {
  private noiseAcc = 0;
  private signalAcc = 0;
  private signalN = 0;

  update(freq: Float32Array, rms: number, isTone: Uint8Array): void {
    let mean = 0;
    let cnt = 0;
    for (let i = 0; i < freq.length; i++) {
      if (isTone[i]) {
        mean += freq[i];
        cnt++;
      }
    }
    if (cnt < 8) return;
    mean /= cnt;
    let varSum = 0;
    for (let i = 0; i < freq.length; i++) {
      if (isTone[i]) {
        const d = freq[i] - mean;
        varSum += d * d;
      }
    }
    const freqVar = varSum / cnt;
    this.noiseAcc = this.noiseAcc * 0.9 + freqVar * 0.1;
    const p = rms * rms;
    this.signalAcc = this.signalAcc * 0.9 + p * 0.1;
    this.signalN++;
  }

  estimate(): SnrEstimate {
    // 经验标定: σ_f≈30Hz @10dB,σ_f≈95Hz @0dB(σ² 每 10dB 差约 10 倍)
    const noiseFreqVar = this.noiseAcc;
    const snrDb = noiseFreqVar < 1 ? 40 : 10 * Math.log10(90000 / noiseFreqVar);
    return {
      snrDb: this.signalN === 0 ? -Infinity : snrDb,
      signalPower: this.signalAcc,
      noisePower: this.noiseAcc,
    };
  }

  reset(): void {
    this.noiseAcc = 0;
    this.signalAcc = 0;
    this.signalN = 0;
  }
}
