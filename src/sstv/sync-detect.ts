/**
 * 同步脉冲检测与校准头搜索。
 *
 * 输入为解调后的瞬时频率序列(Hz),输出 1200Hz 同步脉冲的位置/时长,
 * 以及 1900/1200Hz 校准头(leader-break-leader + VIS)。
 *
 * 设计目标: SNR 低至 10dB、同步脉冲时有时无的条件下仍能稳定工作。
 * 手段: 滞回阈值 + 最短时长校验 + 脉冲时长一致性打分。
 */

export const SYNC_FREQ_MAX = 1300; // 低于此频率视为"同步区"(含噪声余量)
export const TONE_FREQ_MIN = 1400; // 高于此频率视为"离开同步区"
export const LEADER_FREQ_MIN = 1750;
export const LEADER_FREQ_MAX = 2050;
export const BREAK_FREQ_MAX = 1300;

export interface SyncPulse {
  /** 脉冲起点样本索引(全局流位置) */
  startSample: number;
  /** 脉冲终点样本索引( exclusive ) */
  endSample: number;
  /** 时长(秒) */
  duration: number;
  /** 脉冲内平均频率,用于可信度评估 */
  meanFreq: number;
}

export class SyncDetector {
  private inSync = false;
  private pulseStart = 0;
  private pulseFreqSum = 0;
  private pulseFreqN = 0;
  /** 连续脱锁样本计数,单个毛刺不结束脉冲 */
  private escapeCount = 0;
  /** 连续多少样本高于退出阈值才真正结束同步区(约 1ms) */
  private readonly escapeNeed: number;

  constructor(
    private sampleRate: number,
    /** 判定为有效同步脉冲的最短时长(秒),默认 3ms */
    private minPulseSec = 0.003,
    /** 判定为有效同步脉冲的最长时长(秒),默认 30ms(PD 为 20ms) */
    private maxPulseSec = 0.03,
  ) {
    this.escapeNeed = Math.max(2, Math.round(sampleRate * 0.001));
  }

  /**
   * 扫描一整块频率序列,返回检测到的同步脉冲。
   * @param freq       瞬时频率
   * @param baseSample 本块第一个样本在全局流中的索引
   */
  detect(freq: Float32Array, baseSample: number): SyncPulse[] {
    const pulses: SyncPulse[] = [];
    const minN = this.minPulseSec * this.sampleRate;
    const maxN = this.maxPulseSec * this.sampleRate;
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i];
      if (!this.inSync && f < SYNC_FREQ_MAX) {
        this.inSync = true;
        this.pulseStart = baseSample + i;
        this.pulseFreqSum = f;
        this.pulseFreqN = 1;
        this.escapeCount = 0;
      } else if (this.inSync) {
        if (f < TONE_FREQ_MIN) {
          this.pulseFreqSum += f;
          this.pulseFreqN++;
          this.escapeCount = 0;
        } else {
          this.escapeCount++;
          if (this.escapeCount >= this.escapeNeed) {
            // 脉冲结束
            const endSample = baseSample + i - this.escapeCount + 1;
            const len = endSample - this.pulseStart;
            if (len >= minN && len <= maxN) {
              pulses.push({
                startSample: this.pulseStart,
                endSample,
                duration: len / this.sampleRate,
                meanFreq: this.pulseFreqSum / this.pulseFreqN,
              });
            }
            this.inSync = false;
            this.pulseFreqN = 0;
            this.escapeCount = 0;
          }
        }
      }
    }
    return pulses;
  }

  /** 流结束时若仍处在同步区,丢弃半截脉冲(不完整不可信)。 */
  reset(): void {
    this.inSync = false;
    this.pulseStart = 0;
    this.pulseFreqSum = 0;
    this.pulseFreqN = 0;
    this.escapeCount = 0;
  }
}

/** 在给定频率窗口内估计平均频率(恒音区判读用)。 */
export function meanFreqInRange(freq: Float32Array, start: number, end: number): number {
  const s = Math.max(0, start);
  const e = Math.min(freq.length, end);
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) sum += freq[i];
  return sum / (e - s);
}

export interface HeaderHit {
  /** VIS 第一个 bit 的起始样本(全局) */
  visStartSample: number;
  /** 校准头起点样本(全局) */
  headerStartSample: number;
}

/**
 * 搜索校准头: 1900Hz×300ms → 1200Hz×10ms → 1900Hz×300ms。
 * 只做粗粒度(5ms 步进)模板匹配,找到后 VIS 的精确判读在解码器里做。
 *
 * @returns 命中时返回 header 起点与 VIS 起点(全局样本索引),否则 null
 */
export function findCalibrationHeader(
  freq: Float32Array,
  sampleRate: number,
  baseSample: number,
): HeaderHit | null {
  const step = Math.max(1, Math.round(sampleRate * 0.005));
  const leaderN = Math.round(0.3 * sampleRate);
  const breakN = Math.round(0.01 * sampleRate);
  const leader2N = leaderN;
  const totalMin = leaderN + breakN + leader2N;
  if (freq.length < totalMin) return null;

  const inBand = (f: number, lo: number, hi: number) => f >= lo && f <= hi;

  for (let i = 0; i + totalMin < freq.length; i += step) {
    // 快速门限: leader 中段、break 中段、leader2 中段三个探针
    const p1 = i + Math.round(leaderN * 0.5);
    const p2 = i + leaderN + Math.round(breakN * 0.5);
    const p3 = i + leaderN + breakN + Math.round(leader2N * 0.5);
    if (
      !inBand(freq[p1], LEADER_FREQ_MIN, LEADER_FREQ_MAX) ||
      !(freq[p2] < BREAK_FREQ_MAX) ||
      !inBand(freq[p3], LEADER_FREQ_MIN, LEADER_FREQ_MAX)
    ) {
      continue;
    }
    // 精细确认: 三段各自 80% 以上样本落在目标频带
    if (
      bandRatio(freq, i, i + leaderN, LEADER_FREQ_MIN, LEADER_FREQ_MAX) > 0.8 &&
      bandRatio(freq, i + leaderN, i + leaderN + breakN, 0, BREAK_FREQ_MAX) > 0.8 &&
      bandRatio(freq, i + leaderN + breakN, i + totalMin, LEADER_FREQ_MIN, LEADER_FREQ_MAX) > 0.8
    ) {
      const visStart = i + totalMin;
      return {
        headerStartSample: baseSample + i,
        visStartSample: baseSample + visStart,
      };
    }
  }
  return null;
}

function bandRatio(freq: Float32Array, s: number, e: number, lo: number, hi: number): number {
  let hit = 0;
  const n = e - s;
  for (let i = s; i < e; i++) {
    const f = freq[i];
    if (f >= lo && f <= hi) hit++;
  }
  return hit / n;
}
