/**
 * 解码 Worker: 在后台线程跑完整接收链路,保证 UI 不卡顿。
 *
 * 消息协议(主线程 → worker):
 *   { type: 'audio', samples: Float32Array }   声卡音频块(12kHz)
 *   { type: 'pcm', samples: Float32Array }     测试信号(回放/离线解码)
 *   { type: 'reset' }
 *   { type: 'setFrequency', hz: number }       预留:频率微调
 *
 * worker → 主线程:
 *   { type: 'status', status }
 *   { type: 'imageStart', modeId, source }
 *   { type: 'progress', width, height, rgba, patched, linesDone } (节流)
 *   { type: 'imageComplete', rgba, width, height, meta, patchedMark }
 *   { type: 'dropout', active }
 */
import { SstvReceiver, INTERNAL_RATE } from '../sstv/receiver';
import type { ImageMeta, ReceiverStatus } from '../sstv/receiver';
import type { ImageBuffer } from '../sstv/stream-decoder';
import { composeRgba, composeRgbaClean } from '../sstv/colorspace';

export interface WorkerProgress {
  width: number;
  height: number;
  rgba: ArrayBuffer;
  rgbaClean: ArrayBuffer;
  linesDone: number;
}

const receiver = new SstvReceiver({
  onStatus: (status) => postMessage({ type: 'status', status }),
  onImageStart: (mode, source) => postMessage({ type: 'imageStart', modeId: mode.id, source }),
  onImageProgress: throttle((img: ImageBuffer, linesDone: number) => {
    const rgba = new Uint8ClampedArray(img.width * img.height * 4);
    const rgbaClean = new Uint8ClampedArray(img.width * img.height * 4);
    composeRgba(img, rgba, true);
    composeRgbaClean(img, rgbaClean);
    const msg: WorkerProgress = {
      width: img.width,
      height: img.height,
      rgba: rgba.buffer as ArrayBuffer,
      rgbaClean: rgbaClean.buffer as ArrayBuffer,
      linesDone,
    };
    postMessage({ type: 'progress', ...msg }, [rgba.buffer, rgbaClean.buffer]);
  }, 150),
  onImageComplete: (img: ImageBuffer, meta: ImageMeta) => {
    const rgba = new Uint8ClampedArray(img.width * img.height * 4);
    const rgbaClean = new Uint8ClampedArray(img.width * img.height * 4);
    composeRgba(img, rgba, true);
    composeRgbaClean(img, rgbaClean);
    // 每行来源标记,供 UI 画侧栏
    const lineSource = Array.from(img.lineSource);
    postMessage(
      {
        type: 'imageComplete',
        width: img.width,
        height: img.height,
        rgba: rgba.buffer,
        rgbaClean: rgbaClean.buffer,
        lineSource,
        meta,
      },
      [rgba.buffer, rgbaClean.buffer],
    );
  },
  onDropout: (active) => postMessage({ type: 'dropout', active }),
});

function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let last = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    const now = Date.now();
    const remain = ms - (now - last);
    if (remain <= 0) {
      last = now;
      fn(...args);
    } else if (!trailing) {
      trailing = setTimeout(() => {
        last = Date.now();
        trailing = null;
        fn(...args);
      }, remain);
    }
  };
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case 'audio':
    case 'pcm': {
      const samples = msg.samples as Float32Array;
      receiver.processBlock(samples, performance.now());
      break;
    }
    case 'reset':
      receiver.reset();
      postMessage({ type: 'status', status: getStatus() });
      break;
    case 'setFrequency':
      // 预留:本实现解调中心固定 1700Hz,频率偏差由同步网格吸收
      break;
  }
};

function getStatus(): ReceiverStatus {
  return {
    phase: receiver.phase,
    mode: null,
    modeGuess: null,
    guessing: false,
    guessDeadlineSec: null,
    snrDb: 0,
    rms: 0,
    dropout: false,
    linesDone: 0,
    totalLines: 0,
    visCode: null,
    visParityOk: null,
    globalSample: 0,
  };
}

void INTERNAL_RATE;
