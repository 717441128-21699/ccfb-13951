/**
 * VIS 校准码解码与无 VIS 情况下的模式猜测。
 *
 * VIS 结构: start(1200Hz,30ms) + 8 bit(每 bit 30ms, 1300Hz=0 / 1100Hz=1)
 *           + stop(1200Hz,30ms)。bit0..6 为 LSB 在前的 7 位模式码,bit7 偶校验。
 */
import { ALL_MODES, visParityOk, VIS_TO_MODE } from './modes';
import type { SSTVModeSpec } from './modes';
import { meanFreqInRange } from './sync-detect';

export const VIS_BIT_MS = 30;
const VIS_ONE_MAX = 1200; // ≤1200 判 1
// >1200 判 0

export interface VisResult {
  mode: SSTVModeSpec | null;
  visCode: number;
  parityOk: boolean;
  /** 每 bit 的原始平均频率,供调试/可信度评估 */
  bitFreqs: number[];
}

/**
 * 从 VIS start 之后第一个 bit 的位置解码 8 个 bit。
 * @param freq       全局频率缓冲(可能为环形,这里要求线性可见覆盖 visStart 之后 ≥270ms)
 * @param visStart   第一个 bit 起点的全局样本索引
 * @param offset     visStart 在 freq 缓冲中的局部偏移
 */
export function decodeVis(
  freq: Float32Array,
  sampleRate: number,
  localStart: number,
): VisResult {
  const bitN = Math.round((VIS_BIT_MS / 1000) * sampleRate);
  const bitFreqs: number[] = [];
  let raw = 0;
  for (let b = 0; b < 8; b++) {
    const s = localStart + b * bitN;
    // 去掉每 bit 前后各 15% 的过渡区,取中段 70% 平均
    const margin = Math.round(bitN * 0.15);
    const f = meanFreqInRange(freq, s + margin, s + bitN - margin);
    bitFreqs.push(f);
    if (f <= VIS_ONE_MAX) raw |= 1 << b;
  }
  const parityOk = visParityOk(raw);
  // VIS 按 LSB 在前发送,bit0 就是数据最低位,无需反转
  const code = raw & 0x7f;
  return {
    mode: VIS_TO_MODE[code] ?? null,
    visCode: code,
    parityOk,
    bitFreqs,
  };
}

/**
 * 校验失败时尝试单 bit 纠错: 翻转一个 bit 使奇偶校验通过且命中已知模式。
 */
export function tryCorrectVis(result: VisResult): VisResult {
  if (result.parityOk && result.mode) return result;
  // 重建原始字节
  let raw = 0;
  result.bitFreqs.forEach((f, i) => {
    if (f <= VIS_ONE_MAX) raw |= 1 << i;
  });
  for (let flip = 0; flip < 8; flip++) {
    const candidate = raw ^ (1 << flip);
    if (!visParityOk(candidate)) continue;
    const mode = VIS_TO_MODE[candidate & 0x7f];
    if (mode) {
      return { ...result, mode, visCode: candidate & 0x7f, parityOk: true };
    }
  }
  return result;
}

/**
 * 无 VIS 模式猜测。
 *
 * 依据 (实测样本为 SyncDetector 输出的脉冲序列):
 *  1. 同步脉冲宽度:  ~4.86ms → Martin; ~9ms → Scottie/Robot36; ~20ms → PD
 *  2. 相邻同步间隔:  Martin1≈446.6ms / Martin2≈228.9ms
 *                   Scottie1≈428.2ms / Scottie2≈277.7ms(每行都有 sync)
 *                   Robot36≈238ms(每两行一个 sync)
 *                   PD120≈508.5ms(每两行一个 sync)
 *  3. 9ms 档区分 Scottie 与 Robot36: Scottie 每行有 sync(间隔≈行周期),
 *     Robot36 间隔内还会出现一个 4.5ms 的 1500/2300Hz 分离脉冲特征——
 *     这里用"间隔与 238ms 的吻合度 + 是否等间隔"判定。
 *
 * 决策时间预算: 10 秒。最慢的 PD120 行组 0.51s,10 秒内至少 19 个脉冲,
 * M1 也有 22 个,统计量充足。
 */
export interface PulseObservation {
  /** 脉冲时长(秒) */
  duration: number;
  /** 相对第一个脉冲的时间(秒) */
  t: number;
}

export interface ModeGuess {
  mode: SSTVModeSpec;
  confidence: number; // 0..1
  reasons: string[];
}

export function guessMode(pulses: PulseObservation[]): ModeGuess | null {
  if (pulses.length < 3) return null;

  // 脉冲宽度中位数(抗个别毛刺)
  const widths = pulses.map((p) => p.duration).sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)];

  // 相邻间隔
  const intervals: number[] = [];
  for (let i = 1; i < pulses.length; i++) {
    intervals.push(pulses[i].t - pulses[i - 1].t);
  }
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)];

  const scored: { mode: SSTVModeSpec; score: number; reasons: string[] }[] = [];

  for (const mode of ALL_MODES) {
    const reasons: string[] = [];
    let score = 0;

    // —— 宽度分(0..5) ——
    const widthErr = Math.abs(medianWidth - mode.syncPulse) / mode.syncPulse;
    const widthScore = Math.max(0, 5 * (1 - widthErr / 0.35));
    score += widthScore;
    if (widthScore > 3) reasons.push(`同步脉宽 ${(medianWidth * 1000).toFixed(1)}ms≈${mode.name} 的 ${(mode.syncPulse * 1000).toFixed(1)}ms`);

    // —— 间隔分(0..5) ——
    const intervalErr = Math.abs(medianInterval - mode.lineTime) / mode.lineTime;
    const intervalScore = Math.max(0, 5 * (1 - intervalErr / 0.2));
    score += intervalScore;
    if (intervalScore > 3) reasons.push(`同步间隔 ${(medianInterval * 1000).toFixed(0)}ms≈行周期 ${(mode.lineTime * 1000).toFixed(0)}ms`);

    // —— 间隔稳定性分(0..2): 等间隔越整齐越可信 ——
    const meanIv = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + (b - meanIv) ** 2, 0) / intervals.length;
    const cv = Math.sqrt(variance) / meanIv;
    const stabilityScore = Math.max(0, 2 * (1 - cv / 0.15));
    score += stabilityScore;

    scored.push({ mode, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  // 归一化置信度,并要求与第二名有明显差距
  const confidence = Math.min(1, best.score / 10) * (second ? Math.min(1, 0.5 + (best.score - second.score) / 4) : 1);
  return {
    mode: best.mode,
    confidence: Math.round(confidence * 100) / 100,
    reasons: best.reasons,
  };
}
