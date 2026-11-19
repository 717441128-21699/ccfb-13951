/**
 * 测试信号生成: 标准图样 → SSTV 编码 → 信道损伤(噪声/断续/频偏)。
 * 浏览器端 Worker 与 Node 端 vitest 共用同一份逻辑。
 */
import { SstvEncoder } from '../sstv/encoder';
import type { RgbImage } from '../sstv/encoder';
import { MODES } from '../sstv/modes';
import type { SSTVModeSpec } from '../sstv/modes';
import { applyChannel } from './channel';
import type { ChannelOptions } from './channel';
import { makeGradient, makeGridPattern, makeTestPattern } from './patterns';

export type TestPatternKind = 'bars' | 'gradient' | 'grid';

export interface TestSignalConfig {
  modeId: keyof typeof MODES;
  pattern: TestPatternKind;
  snrDb: number;
  dropouts: ChannelOptions['dropouts'];
  freqOffsetHz?: number;
  sampleRate?: number;
  seed?: number;
}

export interface GeneratedSignal {
  pcm: Float32Array;
  cleanPcm: Float32Array;
  sampleRate: number;
  mode: SSTVModeSpec;
  sourceImage: RgbImage;
  durationSec: number;
}

export function buildTestSignal(cfg: TestSignalConfig): GeneratedSignal {
  const mode = MODES[cfg.modeId];
  const sampleRate = cfg.sampleRate ?? 12000;
  const image = makeImage(cfg.pattern, mode.width, mode.height);
  const encoder = new SstvEncoder(sampleRate);
  const cleanPcm = encoder.encode(image, cfg.modeId);
  const pcm = applyChannel(cleanPcm, sampleRate, {
    snrDb: cfg.snrDb,
    dropouts: cfg.dropouts,
    freqOffsetHz: cfg.freqOffsetHz,
    seed: cfg.seed,
  });
  return {
    pcm,
    cleanPcm,
    sampleRate,
    mode,
    sourceImage: image,
    durationSec: pcm.length / sampleRate,
  };
}

function makeImage(kind: TestPatternKind, w: number, h: number): RgbImage {
  switch (kind) {
    case 'gradient':
      return makeGradient(w, h);
    case 'grid':
      return makeGridPattern(w, h);
    case 'bars':
    default:
      return makeTestPattern(w, h);
  }
}

/** 把 PCM 切成小块,模拟实时麦克风流(供 Worker 回放)。 */
export function chunkPcm(pcm: Float32Array, chunkSize = 1024): Float32Array[] {
  const chunks: Float32Array[] = [];
  for (let i = 0; i < pcm.length; i += chunkSize) {
    chunks.push(pcm.subarray(i, Math.min(pcm.length, i + chunkSize)).slice());
  }
  return chunks;
}
