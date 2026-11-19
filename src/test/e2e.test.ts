import { describe, expect, it } from 'vitest';
import { SstvReceiver } from '../sstv/receiver';
import type { ImageMeta } from '../sstv/receiver';
import type { ImageBuffer } from '../sstv/stream-decoder';
import { buildTestSignal, chunkPcm } from './generator';
import { SstvEncoder } from '../sstv/encoder';
import type { RgbImage } from '../sstv/encoder';
import { applyChannel } from './channel';

interface RunResult {
  image: ImageBuffer | null;
  meta: ImageMeta | null;
  modeId: string | null;
  dropoutEvents: boolean[];
}

type Cfg = Omit<Parameters<typeof buildTestSignal>[0], 'modeId'>;

function runReceiver(modeId: 'MARTIN1' | 'SCOTTIE1' | 'ROBOT36' | 'PD120', cfg: Cfg): RunResult {
  const sig = buildTestSignal({ ...cfg, modeId });
  const receiver = new SstvReceiver({}, 12000, true);
  let image: ImageBuffer | null = null;
  let meta: ImageMeta | null = null;
  let startedMode: string | null = null;
  const dropoutEvents: boolean[] = [];
  receiver.events = {
    ...receiver.events,
    onImageStart: (m) => {
      startedMode = m.id;
    },
    onImageComplete: (img, m) => {
      image = img;
      meta = m;
    },
    onDropout: (a) => dropoutEvents.push(a),
  };
  const chunks = chunkPcm(sig.pcm, 1024);
  let t = 0;
  for (const c of chunks) {
    receiver.processBlock(c, t);
    t += c.length / sig.sampleRate;
  }
  receiver.endStream(t);
  return { image, meta, modeId: startedMode, dropoutEvents };
}

describe('端到端: 编码 → 信道 → 解码', () => {
  const baseCfg = {
    pattern: 'bars' as const,
    snrDb: 30,
    dropouts: [],
  };

  it.each([
    ['MARTIN1', 320, 256],
    ['SCOTTIE1', 320, 256],
    ['ROBOT36', 320, 240],
    ['PD120', 640, 496],
  ] as const)('%s 干净信号下完整解码且尺寸正确', (modeId, w, h) => {
    const r = runReceiver(modeId, baseCfg);
    expect(r.modeId).toBe(modeId);
    expect(r.image).not.toBeNull();
    expect(r.image!.width).toBe(w);
    expect(r.image!.height).toBe(h);
    expect(r.meta!.totalLines).toBe(h);
  });

  it('10dB 弱信号下四种模式都能出图', () => {
    for (const modeId of ['MARTIN1', 'SCOTTIE1', 'ROBOT36', 'PD120'] as const) {
      const r = runReceiver(modeId, { ...baseCfg, snrDb: 10, seed: 99 });
      expect(r.image, `${modeId} 应完成解码`).not.toBeNull();
      expect(r.image!.height).toBe(r.image!.mode.height);
    }
  });

  it('信号中断 3 秒后恢复: 不另起新图、补全行被标记', () => {
    const sig = buildTestSignal({
      modeId: 'MARTIN1',
      pattern: 'bars',
      snrDb: 20,
      dropouts: [{ startSec: 3, durationSec: 3 }],
      seed: 7,
    });
    const receiver = new SstvReceiver({}, 12000, true);
    let starts = 0;
    let image: ImageBuffer | null = null;
    receiver.events = {
      ...receiver.events,
      onImageStart: () => starts++,
      onImageComplete: (img) => {
        image = img;
      },
    };
    for (const c of chunkPcm(sig.pcm, 1024)) receiver.processBlock(c, performance.now());
    receiver.endStream(performance.now());
    expect(starts).toBe(1); // 全程只启动一张图
    expect(image).not.toBeNull();
    let patched = 0;
    for (let y = 0; y < image!.height; y++) if (image!.lineSource[y] === 1) patched++;
    expect(patched).toBeGreaterThan(0); // 有补全行
    expect(patched).toBeLessThan(image!.height * 0.5); // 但不超过一半
  });

  it('多次断续(每次 1~2 秒)仍在同一张图上收完', () => {
    const sig = buildTestSignal({
      modeId: 'ROBOT36',
      pattern: 'grid',
      snrDb: 15,
      dropouts: [
        { startSec: 2, durationSec: 1.5 },
        { startSec: 6, durationSec: 2 },
        { startSec: 11, durationSec: 1 },
      ],
      seed: 13,
    });
    const receiver = new SstvReceiver({}, 12000, true);
    let starts = 0;
    let image: ImageBuffer | null = null;
    receiver.events = {
      ...receiver.events,
      onImageStart: () => starts++,
      onImageComplete: (img) => {
        image = img;
      },
    };
    for (const c of chunkPcm(sig.pcm, 1024)) receiver.processBlock(c, performance.now());
    receiver.endStream(performance.now());
    expect(starts).toBe(1);
    expect(image).not.toBeNull();
    expect(image!.mode.id).toBe('ROBOT36');
  });

  it('断续恢复后不错半行: 垂直斜坡行号严格对齐', () => {
    // 每行纯色、G 亮度随行号线性变化,任何半行/整行错位都会破坏 y→G 的映射
    const w = 320;
    const h = 256;
    const data = new Uint8ClampedArray(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        data[i] = 0;
        data[i + 1] = y;
        data[i + 2] = 0;
      }
    }
    const sourceImage: RgbImage = { width: w, height: h, data };
    const pcm = new SstvEncoder(12000).encode(sourceImage, 'SCOTTIE1');
    const noisy = applyChannel(pcm, 12000, { snrDb: 25, dropouts: [{ startSec: 4, durationSec: 2.5 }], seed: 21 });
    const receiver = new SstvReceiver({}, 12000, true);
    let image: ImageBuffer | null = null;
    receiver.events = {
      ...receiver.events,
      onImageComplete: (img) => {
        image = img;
      },
    };
    for (const c of chunkPcm(noisy, 1024)) receiver.processBlock(c, performance.now());
    receiver.endStream(performance.now());
    expect(image).not.toBeNull();
    const g = image!.plane('G');
    // 抽样若干行,解码 G 应等于行号(允许 ±6 的噪声/量化容差,但绝不能差半行)
    const checks = [10, 40, 80, 120, 160, 200, 240];
    let ok = 0;
    for (const y of checks) {
      if (Math.abs(g[y * w] - y) <= 6) ok++;
    }
    expect(ok / checks.length).toBeGreaterThan(0.85);
  });
});
