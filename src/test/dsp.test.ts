import { describe, expect, it } from 'vitest';
import { FmDemodulator } from '../dsp/demod';
import { BandPass, HighPassIir, LowPassBiquad, MovingAverage } from '../dsp/filters';
import { Resampler } from '../dsp/resample';

const FS = 12000;

function sine(freq: number, n: number, sr = FS, phase0 = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(phase0 + (2 * Math.PI * freq * i) / sr);
  return out;
}

describe('FM 解调器', () => {
  it('恒音 1500/1900/2300Hz 解调频率误差 < 8Hz', () => {
    const demod = new FmDemodulator(FS);
    for (const target of [1200, 1500, 1900, 2300]) {
      const input = sine(target, FS * 0.2);
      const out = new Float32Array(input.length);
      demod.process(input, out);
      demod.reset();
      // 跳过前 40ms 瞬态
      const tail = out.subarray(Math.round(FS * 0.04));
      const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
      expect(Math.abs(mean - target)).toBeLessThan(8);
    }
  });

  it('频率跳变能在 5ms 内跟上', () => {
    const demod = new FmDemodulator(FS);
    const n = FS;
    const input = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = i < n / 2 ? 1500 : 2300;
      input[i] = Math.sin(phase);
      phase += (2 * Math.PI * f) / FS;
    }
    const out = new Float32Array(n);
    demod.process(input, out);
    const settleIdx = n / 2 + Math.round(FS * 0.005);
    const after = out.subarray(settleIdx, settleIdx + 100);
    const mean = after.reduce((a, b) => a + b, 0) / after.length;
    expect(Math.abs(mean - 2300)).toBeLessThan(15);
  });

  it('10dB 噪声下恒音频率抖动 RMS < 75Hz', () => {
    const demod = new FmDemodulator(FS);
    const n = FS;
    const sig = sine(1500, n);
    const noiseSigma = Math.sqrt(0.5 / 10 ** (10 / 10));
    let seed = 7;
    const rng = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };
    const noisy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = rng() || 1e-9;
      const v = rng();
      noisy[i] = sig[i] + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * noiseSigma;
    }
    const out = new Float32Array(n);
    demod.process(noisy, out);
    const tail = out.subarray(FS * 0.05);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    const variance = tail.reduce((a, b) => a + (b - mean) ** 2, 0) / tail.length;
    expect(Math.abs(mean - 1500)).toBeLessThan(20);
    expect(Math.sqrt(variance)).toBeLessThan(75);
  });
});

describe('滤波器', () => {
  it('低通 1000Hz 衰减 3kHz 分量', () => {
    const lp = new LowPassBiquad(1000, FS);
    const n = FS;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 3000 * i) / FS);
    const out = lp.processBlock(input, new Float32Array(n));
    const tail = out.subarray(n / 2);
    const rms = Math.sqrt(tail.reduce((a, b) => a + b * b, 0) / tail.length);
    expect(rms).toBeLessThan(0.1);
  });

  it('带通保留 1500Hz、压制 500Hz', () => {
    const n = FS;
    const inp1500 = new Float32Array(n);
    const inp500 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      inp1500[i] = Math.sin((2 * Math.PI * 1500 * i) / FS);
      inp500[i] = Math.sin((2 * Math.PI * 500 * i) / FS);
    }
    // 两个独立滤波器实例,避免共享内部状态
    const o1500 = new BandPass(900, 2700, FS).processBlock(inp1500, new Float32Array(n));
    const o500 = new BandPass(900, 2700, FS).processBlock(inp500, new Float32Array(n));
    const rmsOf = (a: Float32Array) => Math.sqrt(a.subarray(n / 2).reduce((s, v) => s + v * v, 0) / (n / 2));
    const r1500 = rmsOf(o1500);
    const r500 = rmsOf(o500);
    // 带内保留(允许滤波器插入损耗),带外一阶高通有明显衰减
    expect(r1500).toBeGreaterThan(0.5);
    expect(r500).toBeLessThan(0.4);
  });

  it('高通去除直流偏移', () => {
    const hp = new HighPassIir(200, FS);
    const out: number[] = [];
    for (let i = 0; i < FS * 0.5; i++) out.push(hp.process(0.5 + Math.sin((2 * Math.PI * 1500 * i) / FS)));
    const tail = out.slice(-1000);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
  });

  it('滑动平均平滑阶跃', () => {
    const ma = new MovingAverage(10);
    const vals: number[] = [];
    for (let i = 0; i < 20; i++) vals.push(ma.process(i < 10 ? 0 : 10));
    expect(vals[14]).toBeGreaterThan(3);
    expect(vals[14]).toBeLessThan(8);
    expect(vals[19]).toBeCloseTo(10, 5);
  });
});

describe('重采样', () => {
  it('48k → 12k 四分频保持波形幅度', () => {
    const r = new Resampler(48000, 12000);
    const chunks: number[] = [];
    for (let b = 0; b < 4; b++) {
      const block = sine(1000, 1200, 48000, b * 1200 * (2 * Math.PI * 1000) / 48000);
      const out = r.push(block);
      for (const v of out) chunks.push(v);
    }
    // 4800 输入样本应产出约 1200 个
    expect(chunks.length).toBeGreaterThan(1150);
    expect(chunks.length).toBeLessThan(1250);
    const rms = Math.sqrt(chunks.reduce((a, b) => a + b * b, 0) / chunks.length);
    expect(rms).toBeGreaterThan(0.65);
  });
});
