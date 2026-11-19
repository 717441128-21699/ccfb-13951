import { describe, expect, it } from 'vitest';
import { SstvReceiver } from '../sstv/receiver';
import { FmDemodulator } from '../dsp/demod';
import { buildTestSignal, chunkPcm } from './generator';

/**
 * 实时性验证: 处理一段音频的 CPU 耗时必须远小于音频实际时长,
 * 否则浏览器里解码跟不上实时流。
 */
describe('实时性能', () => {
  it('FM 解调吞吐: 处理 10 秒音频耗时 < 1 秒(10x 实时余量)', () => {
    const sr = 12000;
    const demod = new FmDemodulator(sr);
    const tenSec = sr * 10;
    const input = new Float32Array(tenSec);
    for (let i = 0; i < tenSec; i++) input[i] = Math.sin((2 * Math.PI * 1500 * i) / sr);
    const out = new Float32Array(1024);
    const start = performance.now();
    for (let off = 0; off < tenSec; off += 1024) {
      demod.process(input.subarray(off, Math.min(tenSec, off + 1024)), out);
    }
    const elapsedMs = performance.now() - start;
    // 10 秒音频应在 1 秒内解完
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('完整接收链路实时系数 > 3(处理速度至少是实时的 3 倍)', () => {
    // Robot36 整张图约 57 秒音频,是计算量较大的模式之一
    const sig = buildTestSignal({
      modeId: 'ROBOT36',
      pattern: 'bars',
      snrDb: 20,
      dropouts: [],
    });
    const receiver = new SstvReceiver({});
    const chunks = chunkPcm(sig.pcm, 1024);
    const start = performance.now();
    let t = 0;
    for (const c of chunks) {
      receiver.processBlock(c, t);
      t += c.length / sig.sampleRate;
    }
    const elapsedSec = (performance.now() - start) / 1000;
    const audioSec = sig.pcm.length / sig.sampleRate;
    const realtimeFactor = audioSec / elapsedSec;
    // 宽松下限 3x,给 UI 渲染和浏览器调度留足余量
    expect(realtimeFactor).toBeGreaterThan(3);
  });

  it('PD120(640x496)单张解码内存与耗时可控', () => {
    const sig = buildTestSignal({
      modeId: 'PD120',
      pattern: 'gradient',
      snrDb: 25,
      dropouts: [],
    });
    const receiver = new SstvReceiver({}, 12000, true);
    let completed = false;
    receiver.events = { onImageComplete: () => { completed = true; } };
    const start = performance.now();
    let t = 0;
    for (const c of chunkPcm(sig.pcm, 1024)) {
      receiver.processBlock(c, t);
      t += c.length / sig.sampleRate;
    }
    receiver.endStream(t);
    const elapsedSec = (performance.now() - start) / 1000;
    expect(completed).toBe(true);
    // PD120 音频约 252 秒,解码 CPU 时间应远低于此
    expect(elapsedSec).toBeLessThan(sig.pcm.length / sig.sampleRate / 2);
  });
});
