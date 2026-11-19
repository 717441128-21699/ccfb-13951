/**
 * 声卡采集封装: AudioContext + AudioWorklet 管理。
 * 一次配置后可在多个页面会话间复用,避免"换软件重设声卡"的痛点——
 * 设备选择持久化在 localStorage。
 */

const DEVICE_STORAGE_KEY = 'sstv.inputDeviceId';

export interface CaptureEvents {
  onAudio?: (samples: Float32Array) => void;
  onState?: (running: boolean) => void;
  onError?: (err: Error) => void;
}

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private running = false;

  static enumerateInputs(): Promise<MediaDeviceInfo[]> {
    return navigator.mediaDevices.enumerateDevices().then((d) => d.filter((x) => x.kind === 'audioinput'));
  }

  static saveDevice(id: string): void {
    localStorage.setItem(DEVICE_STORAGE_KEY, id);
  }

  static loadDevice(): string | null {
    return localStorage.getItem(DEVICE_STORAGE_KEY);
  }

  constructor(private events: CaptureEvents = {}) {}

  async start(deviceId?: string): Promise<void> {
    if (this.running) return;
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
      video: false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/worklets/capture-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'sstv-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    const source = this.ctx.createMediaStreamSource(this.stream);
    source.connect(this.node);
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'audio') this.events.onAudio?.(e.data.samples as Float32Array);
    };
    this.node.port.postMessage({ type: 'enable', value: true });
    this.running = true;
    this.events.onState?.(true);
  }

  setEnabled(value: boolean): void {
    this.node?.port.postMessage({ type: 'enable', value });
  }

  async stop(): Promise<void> {
    this.node?.port.postMessage({ type: 'enable', value: false });
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.running = false;
    this.events.onState?.(false);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get contextSampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }
}
