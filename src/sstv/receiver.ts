/**
 * 接收链路总编排:
 *
 *   音频块 → 带通 → FM 解调 → 同步检测 ┬─ 校准头/VIS 解码(确定模式)
 *                                      └─ 行网格状态机(逐行出图、断流补全)
 *
 * 状态: SEARCH_CALIB(找头) → VIS(判模式,失败则 GUESS) → RECEIVING(收图)
 * 无 VIS 时在 10 秒窗口内用同步脉冲统计猜模式,猜对前先缓存脉冲。
 */
import { BandPass } from '../dsp/filters';
import { DEMOD_GROUP_DELAY, FmDemodulator, RmsEstimator, SnrEstimator } from '../dsp/demod';
import { findCalibrationHeader, SyncDetector } from './sync-detect';
import type { SyncPulse } from './sync-detect';
import { decodeVis, guessMode, tryCorrectVis } from './vis';
import type { ModeGuess, PulseObservation } from './vis';
import type { SSTVModeSpec } from './modes';
import { HEADER_VIS_START } from './modes';
import { ImageBuffer, StreamDecoder } from './stream-decoder';

export const INTERNAL_RATE = 12000;

export type ReceiverPhase = 'SEARCH_CALIB' | 'RECEIVING';

export interface ReceiverStatus {
  phase: ReceiverPhase;
  mode: SSTVModeSpec | null;
  modeGuess: ModeGuess | null;
  guessing: boolean;
  guessDeadlineSec: number | null;
  snrDb: number;
  rms: number;
  dropout: boolean;
  linesDone: number;
  totalLines: number;
  visCode: number | null;
  visParityOk: boolean | null;
  globalSample: number;
}

export interface ReceiverEvents {
  onImageStart?: (mode: SSTVModeSpec, source: 'vis' | 'guess') => void;
  onImageProgress?: (img: ImageBuffer, linesDone: number) => void;
  onImageComplete?: (img: ImageBuffer, meta: ImageMeta) => void;
  onStatus?: (s: ReceiverStatus) => void;
  onDropout?: (active: boolean) => void;
}

export interface ImageMeta {
  mode: SSTVModeSpec;
  startedAt: number;
  completedAt: number;
  durationSec: number;
  patchedLineCount: number;
  totalLines: number;
  visCode: number | null;
  meanSnrDb: number;
}

const GUESS_WINDOW_SEC = 10;
const GUESS_MIN_PULSES = 4;

export class SstvReceiver {
  private bandpass: BandPass;
  private demod: FmDemodulator;
  private syncDet: SyncDetector;
  private rms: RmsEstimator;
  private snr: SnrEstimator;
  private decoder: StreamDecoder | null = null;
  private filtered: Float32Array;
  private freq: Float32Array;
  private toneMark: Uint8Array;
  /**
   * 频率序列滚动历史: 校准头长 0.61s + VIS 0.27s ≈ 0.88s,
   * 保留 1.5s 使单块(85ms)到达时仍能在连续缓冲上搜到完整头部。
   * historyBase 是缓冲首样本对应的全局索引。
   */
  private history: Float32Array = new Float32Array(0);
  private historyBase = 0;
  private readonly historyCapacity: number;
  /** 最近一块检测到的(已补偿群延迟的)同步脉冲 */
  private lastPulses: SyncPulse[] = [];
  /** 近期脉冲滚动保留(最多 2000 个,覆盖最长 PD 模式一整张图) */
  private allRecentPulses: SyncPulse[] = [];

  phase: ReceiverPhase = 'SEARCH_CALIB';
  private globalSample = 0;
  private mode: SSTVModeSpec | null = null;
  private modeGuess: ModeGuess | null = null;
  private guessing = false;
  private guessStartSample = 0;
  private guessPulses: PulseObservation[] = [];
  private visCode: number | null = null;
  private visParityOk: boolean | null = null;
  private headerCooldown = 0;
  private snrAccum = 0;
  private snrCount = 0;
  private startedAt = 0;
  private statusThrottle = 0;

  constructor(
    public events: ReceiverEvents = {},
    public sampleRate = INTERNAL_RATE,
    /**
     * 保留完整频率历史(离线/文件解码)。实时麦克风流应保持 false 用滚动窗口,
     * 避免长时间运行内存无限增长。
     */
    private retainFullHistory = false,
  ) {
    this.bandpass = new BandPass(900, 2700, sampleRate);
    this.demod = new FmDemodulator(sampleRate);
    this.syncDet = new SyncDetector(sampleRate);
    this.rms = new RmsEstimator(Math.round(sampleRate * 0.1));
    this.snr = new SnrEstimator();
    this.filtered = new Float32Array(0);
    this.freq = new Float32Array(0);
    this.toneMark = new Uint8Array(0);
    // 4 秒滚动窗口: 足够覆盖首组锁定等待 + 任意模式若干行组的回读
    this.historyCapacity = Math.round(sampleRate * 4);
  }

  /** 把新频率块追加进滚动历史并裁剪到容量上限(离线模式不裁剪)。 */
  private appendHistory(block: Float32Array, baseSample: number): void {
    if (this.history.length === 0) this.historyBase = baseSample;
    const merged = new Float32Array(this.history.length + block.length);
    merged.set(this.history, 0);
    merged.set(block, this.history.length);
    if (this.retainFullHistory || merged.length <= this.historyCapacity) {
      this.history = merged;
      return;
    }
    const drop = merged.length - this.historyCapacity;
    this.history = merged.slice(drop);
    this.historyBase = baseSample - this.history.length + block.length;
  }

  /** 处理一块(已重采样到内部采样率的)音频。 */
  processBlock(input: Float32Array, wallTime: number): void {
    const n = input.length;
    if (n === 0) return;
    if (this.filtered.length !== n) {
      this.filtered = new Float32Array(n);
      this.freq = new Float32Array(n);
      this.toneMark = new Uint8Array(n);
    }
    const baseSample = this.globalSample;
    this.bandpass.processBlock(input, this.filtered);
    this.demod.process(this.filtered, this.freq);
    this.rms.pushBlock(this.filtered);

    // 恒音区标记(1200Hz 附近),供 SNR 估计
    for (let i = 0; i < n; i++) this.toneMark[i] = this.freq[i] < 1300 ? 1 : 0;
    this.snr.update(this.freq, this.rms.rms, this.toneMark);
    if (++this.snrCount % 10 === 0) {
      this.snrAccum += this.snr.estimate().snrDb;
    }

    // 同步检测在延迟后的频率序列上进行,位置统一补偿解调群延迟,
    // 使下游所有锚点(VIS、行网格、脉冲时间)都对齐真实信号时刻
    const rawPulses = this.syncDet.detect(this.freq, baseSample);
    const pulses: SyncPulse[] = rawPulses.map((p) => ({
      ...p,
      startSample: p.startSample - DEMOD_GROUP_DELAY,
      endSample: p.endSample - DEMOD_GROUP_DELAY,
    }));
    this.lastPulses = pulses;
    this.allRecentPulses.push(...pulses);
    if (this.allRecentPulses.length > 2000) {
      this.allRecentPulses = this.allRecentPulses.slice(-2000);
    }

    // 滚动历史供跨块头部搜索和行解码回读
    this.appendHistory(this.freq, baseSample);

    if (this.phase === 'SEARCH_CALIB') {
      this.handleSearch(wallTime);
    }
    if (this.phase === 'RECEIVING' && this.decoder) {
      this.decoder.push(this.history, this.historyBase, pulses, wallTime);
    }

    this.globalSample += n;
    this.headerCooldown = Math.max(0, this.headerCooldown - n);
    if (++this.statusThrottle >= 6) {
      this.statusThrottle = 0;
      this.emitStatus();
    }
  }

  /**
   * 通知接收流结束(离线解码/文件回放)。实时麦克风流不调用——
   * 实时模式靠收满行数自动完成。
   */
  endStream(wallTime: number): void {
    if (this.phase === 'RECEIVING' && this.decoder) {
      this.decoder.flush(this.history, this.historyBase, wallTime);
    }
  }

  private handleSearch(wallTime: number): void {
    const sr = this.sampleRate;
    // 1) 先试标准校准头(在 1.5s 滚动历史上搜索,完整头部 0.88s 可覆盖)
    if (this.headerCooldown === 0) {
      const hit = findCalibrationHeader(this.history, sr, this.historyBase);
      if (hit) {
        // hit 指向第二段 leader 结束;其后还有 30ms VIS start 位,再减群延迟
        const visStartGlobal =
          hit.visStartSample + Math.round(HEADER_VIS_START * sr) - DEMOD_GROUP_DELAY;
        const visLocal = visStartGlobal - this.historyBase;
        const visEndLocal = visLocal + Math.round(0.27 * sr);
        if (visLocal >= 0 && visEndLocal < this.history.length) {
          const vis = tryCorrectVis(decodeVis(this.history, sr, visLocal));
          this.visCode = vis.visCode;
          this.visParityOk = vis.parityOk;
          if (vis.mode) {
            const imageAnchor = visStartGlobal + Math.round(0.27 * sr);
            this.startReceiving(vis.mode, 'vis', imageAnchor, wallTime);
            return;
          }
        }
        this.headerCooldown = Math.round(sr * 0.5);
      }
    }

    // 2) 无 VIS 路径:累积同步脉冲(全局样本时间),10 秒窗口内猜模式
    if (!this.guessing) {
      this.guessing = true;
      this.guessStartSample = this.globalSample;
      this.guessPulses = [];
    }
    const newPulses = this.pulsesSinceGuess();
    for (const p of newPulses) {
      this.guessPulses.push({
        duration: p.duration,
        t: (p.startSample - this.guessStartSample) / sr,
      });
    }

    const elapsed = (this.globalSample - this.guessStartSample) / sr;
    if (this.guessPulses.length >= GUESS_MIN_PULSES) {
      const guess = guessMode(this.guessPulses);
      if (guess && guess.confidence >= 0.55) {
        this.modeGuess = guess;
        if (guess.confidence >= 0.8 || elapsed >= GUESS_WINDOW_SEC) {
          const anchor = this.guessPulses.length
            ? this.guessStartSample + Math.round(this.guessPulses[0].t * sr)
            : this.globalSample;
          this.startReceiving(guess.mode, 'guess', anchor, wallTime);
          return;
        }
      }
    }
    if (elapsed >= GUESS_WINDOW_SEC && this.modeGuess) {
      const anchor = this.guessPulses.length
        ? this.guessStartSample + Math.round(this.guessPulses[0].t * sr)
        : this.globalSample;
      this.startReceiving(this.modeGuess.mode, 'guess', anchor, wallTime);
    }
  }

  /** 本块新增、且时间晚于猜测窗口起点的同步脉冲。 */
  private pulsesSinceGuess(): SyncPulse[] {
    return this.lastPulses.filter((p) => p.startSample >= this.guessStartSample);
  }

  private startReceiving(
    mode: SSTVModeSpec,
    source: 'vis' | 'guess',
    anchorSample: number,
    wallTime: number,
  ): void {
    this.mode = mode;
    this.phase = 'RECEIVING';
    this.guessing = false;
    this.startedAt = wallTime;
    this.snrAccum = 0;
    this.snrCount = 0;
    // 用锚点之后第一个脉宽匹配的真实同步脉冲精确对齐行网格,
    // 消除 VIS stop 与首个行 sync 之间的时间不确定性
    const refined = this.refineAnchor(mode, anchorSample);
    this.decoder = new StreamDecoder(
      mode,
      this.sampleRate,
      {
        onLine: () => this.emitProgress(),
        onComplete: (img) => this.handleComplete(img),
        onDropout: (active) => this.events.onDropout?.(active),
      },
    );
    this.decoder.begin(refined, wallTime);
    this.events.onImageStart?.(mode, source);
    this.emitStatus();
  }

  /**
   * 在脉冲历史里找锚点之后第一个匹配模式脉宽的脉冲起点。
   * VIS stop 也是 1200Hz,可能落在锚点附近;行 sync 在 stop 之后,
   * 对 Scottie 间隔接近一个行周期,因此前向窗口取 1.5 个行周期。
   */
  private refineAnchor(mode: SSTVModeSpec, anchor: number): number {
    const tol = mode.syncPulse * 0.45;
    const maxAhead = Math.round(mode.lineTime * this.sampleRate * 1.5);
    let best: number | null = null;
    for (const p of this.allRecentPulses) {
      const widthOk = Math.abs(p.duration - mode.syncPulse) <= tol;
      const ahead = p.startSample - anchor;
      if (widthOk && ahead >= 0 && ahead <= maxAhead) {
        if (best === null || p.startSample < best) best = p.startSample;
      }
    }
    return best ?? anchor;
  }

  private handleComplete(img: ImageBuffer): void {
    const now = performance.now();
    let patched = 0;
    for (let y = 0; y < img.height; y++) if (img.lineSource[y] === 1) patched++;
    const meanSnr = this.snrCount ? this.snrAccum / Math.max(1, this.snrCount / 10) : 0;
    const meta: ImageMeta = {
      mode: img.mode,
      startedAt: this.startedAt,
      completedAt: now,
      durationSec: (now - this.startedAt) / 1000,
      patchedLineCount: patched,
      totalLines: img.height,
      visCode: this.visCode,
      meanSnrDb: meanSnr,
    };
    this.events.onImageComplete?.(img, meta);
    // 回到搜索态,准备收下一张
    this.phase = 'SEARCH_CALIB';
    this.mode = null;
    this.decoder = null;
    this.visCode = null;
    this.visParityOk = null;
    this.modeGuess = null;
    this.guessPulses = [];
    this.headerCooldown = Math.round(this.sampleRate * 1);
    this.emitStatus();
  }

  private emitProgress(): void {
    if (this.decoder?.currentImage) {
      const img = this.decoder.currentImage;
      this.events.onImageProgress?.(img, this.decoder.stats.groupIndex * this.mode!.linesPerGroup);
    }
  }

  private emitStatus(): void {
    const est = this.snr.estimate();
    this.events.onStatus?.({
      phase: this.phase,
      mode: this.mode,
      modeGuess: this.modeGuess,
      guessing: this.guessing,
      guessDeadlineSec: this.guessing
        ? GUESS_WINDOW_SEC - (this.globalSample - this.guessStartSample) / this.sampleRate
        : null,
      snrDb: Number.isFinite(est.snrDb) ? est.snrDb : 0,
      rms: this.rms.rms,
      dropout: this.decoder?.stats.dropoutActive ?? false,
      linesDone: this.decoder ? this.decoder.stats.groupIndex * (this.mode?.linesPerGroup ?? 1) : 0,
      totalLines: this.mode?.height ?? 0,
      visCode: this.visCode,
      visParityOk: this.visParityOk,
      globalSample: this.globalSample,
    });
  }

  reset(): void {
    this.phase = 'SEARCH_CALIB';
    this.globalSample = 0;
    this.mode = null;
    this.modeGuess = null;
    this.guessing = false;
    this.guessPulses = [];
    this.visCode = null;
    this.visParityOk = null;
    this.decoder = null;
    this.syncDet.reset();
    this.demod.reset();
    this.snr.reset();
    this.rms.reset();
  }
}
