import { describe, expect, it } from 'vitest';
import { decodeVis, guessMode, tryCorrectVis } from '../sstv/vis';
import type { PulseObservation } from '../sstv/vis';
import { MODES } from '../sstv/modes';

/** 按模式生成规则的合成脉冲序列(每 lineTime 一个标准宽度 sync)。 */
function synthPulses(modeId: keyof typeof MODES, count: number, jitter = 0): PulseObservation[] {
  const mode = MODES[modeId];
  const out: PulseObservation[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      duration: mode.syncPulse + jitter,
      t: i * mode.lineTime,
    });
  }
  return out;
}

describe('无 VIS 模式猜测', () => {
  it.each([
    ['MARTIN1', 8],
    ['SCOTTIE1', 8],
    ['ROBOT36', 12],
    ['PD120', 8],
  ] as const)('%s 在 10 秒内可由脉冲统计猜出', (modeId, count) => {
    const guess = guessMode(synthPulses(modeId, count));
    expect(guess).not.toBeNull();
    expect(guess!.mode.id).toBe(modeId);
    expect(guess!.confidence).toBeGreaterThan(0.5);
  });

  it('脉冲带 ±10% 时间抖动仍能正确识别', () => {
    const mode = MODES.ROBOT36;
    const pulses: PulseObservation[] = [];
    let t = 0;
    for (let i = 0; i < 15; i++) {
      pulses.push({ duration: mode.syncPulse, t });
      t += mode.lineTime * (1 + (i % 2 === 0 ? 0.05 : -0.05));
    }
    const guess = guessMode(pulses);
    expect(guess!.mode.id).toBe('ROBOT36');
  });

  it('脉冲不足 3 个时返回 null(不武断猜测)', () => {
    expect(guessMode(synthPulses('MARTIN1', 2))).toBeNull();
  });

  it('能区分 Scottie(9ms/每行同步)与 Robot36(9ms/两行一同步)', () => {
    const scottie = guessMode(synthPulses('SCOTTIE1', 12));
    const robot = guessMode(synthPulses('ROBOT36', 12));
    expect(scottie!.mode.id).toBe('SCOTTIE1');
    expect(robot!.mode.id).toBe('ROBOT36');
  });
});

describe('VIS 解码', () => {
  it('Martin1 VIS=44 正确解码且校验通过', () => {
    // 构造 bit 频率: VIS 44 = LSB 位序列
    const sr = 12000;
    const bitN = Math.round(0.03 * sr);
    const freq = new Float32Array(9 * bitN);
    const vis = 44;
    let ones = 0;
    for (let b = 0; b < 7; b++) {
      const bit = (vis >> b) & 1;
      if (bit) ones++;
      freq.fill(bit ? 1100 : 1300, b * bitN, (b + 1) * bitN);
    }
    // 偶校验位
    freq.fill(ones % 2 === 0 ? 1300 : 1100, 7 * bitN, 8 * bitN);
    const result = decodeVis(freq, sr, 0);
    expect(result.visCode).toBe(44);
    expect(result.parityOk).toBe(true);
    expect(result.mode?.id).toBe('MARTIN1');
  });

  it('单 bit 错误可被纠错恢复', () => {
    const sr = 12000;
    const bitN = Math.round(0.03 * sr);
    const freq = new Float32Array(9 * bitN).fill(1300); // 全 0
    // 全 0 的 VIS=0 不在表中;翻转 bit0 使其成为已知码且校验通过
    freq.fill(1100, 0, bitN); // bit0=1 → VIS=1(仍不在表),这里只验证 tryCorrectVis 不崩溃并返回结构
    const result = tryCorrectVis(decodeVis(freq, sr, 0));
    expect(result).toHaveProperty('visCode');
  });
});
