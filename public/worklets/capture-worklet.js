/**
 * AudioWorklet: 声卡原始音频 → 单声道 → 线性重采样到 12kHz → 端口输出。
 *
 * 纯 JS(public/worklets/ 下由浏览器直接加载),不依赖任何打包模块。
 * 重采样用线性插值;输入端在 AudioContext 图里已做限带,
 * 且 SSTV 只占 1.1~2.3kHz,12kHz 采样率余量充足。
 */
const TARGET_RATE = 12000;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = 0; // 输入率/目标率,首个块按 sampleRate 初始化
    this.pos = 0;
    this.prev = 0;
    this.chunk = [];
    this.enabled = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'enable') this.enabled = !!e.data.value;
    };
  }

  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    if (this.ratio === 0) {
      this.ratio = sampleRate / TARGET_RATE;
    }

    // 多声道混音为单声道(不就地修改输入缓冲)
    let mixed = ch0;
    if (input.length > 1) {
      mixed = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        let sum = 0;
        for (let c = 0; c < input.length; c++) sum += input[c][i];
        mixed[i] = sum / input.length;
      }
    }

    // 线性插值重采样
    for (;;) {
      const i0 = Math.floor(this.pos);
      if (i0 >= mixed.length) break;
      const frac = this.pos - i0;
      const s0 = i0 === 0 ? this.prev : mixed[i0 - 1];
      const s1 = mixed[i0];
      this.chunk.push(s0 + (s1 - s0) * frac);
      this.pos += this.ratio;
    }
    this.pos -= mixed.length - 1;
    this.prev = mixed[mixed.length - 1];

    // 每 1024 个目标样本(约 85ms)发一块,平衡延迟与消息开销
    while (this.chunk.length >= 1024) {
      const block = new Float32Array(this.chunk.splice(0, 1024));
      this.port.postMessage({ type: 'audio', samples: block }, [block.buffer]);
    }
    return true;
  }
}

registerProcessor('sstv-capture', CaptureProcessor);
