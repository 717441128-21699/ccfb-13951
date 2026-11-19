/**
 * 流式 SSTV 图像解码器(行网格状态机)。
 *
 * 核心设计:
 *  - 以"同步脉冲起点"为网格锚点,每个模式的行/行组周期固定;
 *  - 同步丢失时按内部时钟继续推进网格(绝不另起新图、不错半行);
 *  - 信号恢复后用新同步脉冲做相位微调(只微调,不跳行);
 *  - 每个像素/每行记录数据来源: 实测 / 补全,渲染层据此打标记。
 */
import { freqToLuma } from './modes';
import type {
  SegmentSpec,
  SSTVModeSpec,
} from './modes';
import type { SyncPulse } from './sync-detect';
import { DEMOD_GROUP_DELAY } from '../dsp/demod';

export type SegmentKind = SegmentSpec['kind'];

export type LineSource = 'live' | 'patched' | 'empty';

export interface DecodedLine {
  index: number;
  source: LineSource;
  /** 该行同步锚点对应的全局样本时间(秒) */
  anchorTime: number;
}

export interface DecoderEvents {
  onLine?: (line: DecodedLine) => void;
  onComplete?: (image: ImageBuffer) => void;
  onResync?: (info: { missedGroups: number; driftSec: number }) => void;
  onDropout?: (active: boolean) => void;
}

/** 一张正在接收的图:所有通道的像素值 + 每像素来源标记。 */
export class ImageBuffer {
  readonly width: number;
  readonly height: number;
  /** 平面存储: plane[channelKind][y*width+x] */
  planes: Map<SegmentKind, Uint8ClampedArray> = new Map();
  /** 像素级来源: 0=实测, 1=补全(沿用最后已知值) */
  patched: Uint8Array;
  lineSource: Uint8Array; // 0 live, 1 patched, 2 empty
  /** 组锚点时间(秒),每行一个 */
  anchorTimes: Float64Array;
  receivedLines = 0;

  constructor(public readonly mode: SSTVModeSpec) {
    this.width = mode.width;
    this.height = mode.height;
    const kinds = new Set(mode.segments.map((s) => s.kind));
    for (const k of kinds) {
      this.planes.set(k, new Uint8ClampedArray(this.width * this.height));
    }
    this.patched = new Uint8Array(this.width * this.height);
    this.lineSource = new Uint8Array(this.height).fill(2);
    this.anchorTimes = new Float64Array(this.height).fill(NaN);
  }

  plane(kind: SegmentKind): Uint8ClampedArray {
    const p = this.planes.get(kind);
    if (!p) throw new Error(`no plane ${kind}`);
    return p;
  }

  markLine(y: number, source: LineSource): void {
    const code = source === 'live' ? 0 : source === 'patched' ? 1 : 2;
    this.lineSource[y] = code;
    this.anchorTimes[y] = this.anchorTimes[y] || NaN;
    if (source !== 'empty') this.receivedLines = Math.max(this.receivedLines, y + 1);
  }
}

type Phase = 'idle' | 'receiving' | 'done';

const LINE_SOURCE_LIVE = 0;
const LINE_SOURCE_PATCHED = 1;
const LINE_SOURCE_EMPTY = 2;

export class StreamDecoder {
  private phase: Phase = 'idle';
  private image: ImageBuffer | null = null;
  /** 下一个待处理行组的索引(按"组"计数,每组 linesPerGroup 行) */
  private groupIndex = 0;
  /** 当前组锚点(同步起点)在全局样本流中的位置 */
  private anchorSample = 0;
  private nextExpectedSyncSample = 0;
  /** 连续未见到真实同步的组数 */
  private freeRunGroups = 0;
  /** 首组真实 sync 是否已锁定 */
  private lockedFirstSync = false;
  private dropoutActive = false;
  /** 待匹配的同步脉冲队列(块级输入) */
  private pendingPulses: SyncPulse[] = [];
  /** 最近实测像素值,断流时沿用(每个 kind 一列) */
  private lastKnown: Map<SegmentKind, Uint8ClampedArray> = new Map();
  /** 起始时间(秒),用于日志 */
  startWallTime = 0;

  constructor(
    public mode: SSTVModeSpec,
    private sampleRate: number,
    private events: DecoderEvents = {},
    /** 超过此时长没检测到有效同步 → 判定信号丢失 */
    private dropoutThresholdSec = 0.6,
  ) {}

  begin(anchorSample: number, wallTime: number): ImageBuffer {
    this.phase = 'receiving';
    this.image = new ImageBuffer(this.mode);
    this.groupIndex = 0;
    this.anchorSample = anchorSample;
    this.nextExpectedSyncSample = anchorSample + Math.round(this.mode.lineTime * this.sampleRate);
    this.freeRunGroups = 0;
    this.lockedFirstSync = false;
    this.dropoutActive = false;
    this.startWallTime = wallTime;
    for (const kind of this.image.planes.keys()) {
      this.lastKnown.set(kind, new Uint8ClampedArray(this.mode.width).fill(128));
    }
    return this.image;
  }

  get currentImage(): ImageBuffer | null {
    return this.image;
  }

  get isReceiving(): boolean {
    return this.phase === 'receiving';
  }

  /**
   * 喂入一块解调后的频率数据 + 该块内检测到的同步脉冲。
   * 块之间按 baseSample 衔接,样本索引全局单调。
   */
  push(freq: Float32Array, baseSample: number, pulses: SyncPulse[], nowWall: number): void {
    if (this.phase !== 'receiving' || !this.image) return;
    const blockEnd = baseSample + freq.length;
    this.pendingPulses.push(...pulses);

    const groupSamples = Math.round(this.mode.lineTime * this.sampleRate);
    const maxGroup = Math.ceil(this.mode.height / this.mode.linesPerGroup);

    // 首组门控: 真实行 sync 出现前不解码,避免把 VIS stop 当成第一行起点
    if (this.groupIndex === 0 && !this.lockedFirstSync) {
      const origin = this.acquireFirstSync();
      if (origin === null) return; // 等后续块的脉冲
      this.anchorSample = origin;
      this.lockedFirstSync = true;
    }

    // 不断推进行组,直到组锚点超出本块数据范围。
    // 一个行组的最后一个像素位于 groupStart+groupSamples,再加解调群延迟,
    // 因此只有当缓冲覆盖到该位置时才解码,否则等后续块(防止越界补全)。
    const groupTail = groupSamples + DEMOD_GROUP_DELAY + 2;
    while (this.groupIndex < maxGroup) {
      const groupStart = this.anchorSample;
      if (groupStart + groupTail >= blockEnd) break;

      // —— 1. 在 [组起点附近] 找一个真实同步脉冲用于相位校正 ——
      const match = this.takeMatchingPulse(groupStart, groupSamples);
      let groupIsLive = true;
      if (match) {
        const drift = match.startSample - groupStart;
        const driftSec = drift / this.sampleRate;
        if (this.freeRunGroups > 0) {
          this.events.onResync?.({ missedGroups: this.freeRunGroups, driftSec });
        }
        // 只允许 ±25% 行周期的小幅相位微调,防止毛刺导致错行
        if (Math.abs(driftSec) < this.mode.lineTime * 0.25) {
          this.anchorSample = match.startSample;
        }
        this.freeRunGroups = 0;
        if (this.dropoutActive) {
          this.dropoutActive = false;
          this.events.onDropout?.(false);
        }
      } else {
        this.freeRunGroups++;
        const missingSec = (this.freeRunGroups * groupSamples) / this.sampleRate;
        if (!this.dropoutActive && missingSec >= this.dropoutThresholdSec) {
          this.dropoutActive = true;
          this.events.onDropout?.(true);
        }
        groupIsLive = false;
      }

      // —— 2. 解码该组覆盖的行(数据不足时能解多少解多少) ——
      this.decodeGroup(freq, baseSample, groupStart, groupIsLive);

      // —— 3. 推进网格 ——
      this.groupIndex++;
      this.anchorSample = groupStart + groupSamples;
      this.nextExpectedSyncSample = this.anchorSample + groupSamples;

      if (this.groupIndex >= maxGroup) {
        this.finish(nowWall);
        break;
      }
    }
  }

  /**
   * 流结束时强制收尾: 把所有剩余行组按自由运行方式补完并触发 onComplete。
   * 传入的 freq/baseSample 是当前滚动历史(覆盖尽量多的近期数据),
   * 历史够不到的行自然走补全路径。
   */
  flush(freq: Float32Array, baseSample: number, nowWall: number): void {
    if (this.phase !== 'receiving' || !this.image) return;
    const maxGroup = Math.ceil(this.mode.height / this.mode.linesPerGroup);
    const groupSamples = Math.round(this.mode.lineTime * this.sampleRate);
    const blockEnd = baseSample + freq.length;
    // 离线收尾时若首组始终未锁定,最后尝试一次,否则用当前锚点补全
    if (this.groupIndex === 0 && !this.lockedFirstSync) {
      const origin = this.acquireFirstSync();
      if (origin !== null) this.anchorSample = origin;
      this.lockedFirstSync = true;
    }
    while (this.groupIndex < maxGroup) {
      const groupStart = this.anchorSample;
      if (groupStart >= blockEnd) {
        // 历史也覆盖不到:纯补全
        this.freeRunGroups++;
        this.decodeGroup(freq, baseSample, groupStart, false);
      } else {
        this.freeRunGroups++;
        this.decodeGroup(freq, baseSample, groupStart, false);
      }
      this.groupIndex++;
      this.anchorSample = groupStart + groupSamples;
    }
    this.finish(nowWall);
  }

  /**
   * 首组同步捕获: 在已缓冲脉冲里找当前锚点之后、1.5 行周期内第一个
   * 脉宽匹配的真实行 sync。返回其全局起点,未出现则 null(调用方等待)。
   */
  private acquireFirstSync(): number | null {
    const widthTol = this.mode.syncPulse * 0.45;
    const maxAhead = Math.round(this.mode.lineTime * this.sampleRate * 1.5);
    let best: number | null = null;
    const keep: SyncPulse[] = [];
    for (const p of this.pendingPulses) {
      const widthOk = Math.abs(p.duration - this.mode.syncPulse) <= widthTol;
      const ahead = p.startSample - this.anchorSample;
      if (widthOk && ahead >= 0 && ahead <= maxAhead) {
        if (best === null || p.startSample < best) best = p.startSample;
      }
      keep.push(p);
    }
    this.pendingPulses = keep;
    return best;
  }

  /**
   * 取一个时间上最接近本组预期起点、且脉宽与模式相符的脉冲。
   * 常规窗口为 [-0.25, +0.6] 行周期;首组未锁定时放宽到前向 1.5 行周期,
   * 以吸收 VIS stop 与首个行 sync 之间的间隔(Scottie 接近一个行周期)。
   */
  private takeMatchingPulse(groupStart: number, groupSamples: number): SyncPulse | null {
    const firstGroup = this.groupIndex === 0;
    const lo = groupStart - Math.round(groupSamples * (firstGroup ? 0.25 : 0.25));
    const hi = groupStart + Math.round(groupSamples * (firstGroup ? 1.5 : 0.6));
    let best: SyncPulse | null = null;
    let bestDist = Infinity;
    const widthTol = this.mode.syncPulse * 0.45;
    const rest: SyncPulse[] = [];
    for (const p of this.pendingPulses) {
      const widthOk = Math.abs(p.duration - this.mode.syncPulse) <= widthTol;
      const inWindow = p.startSample >= lo && p.startSample < hi;
      if (widthOk && inWindow) {
        const d = Math.abs(p.startSample - groupStart);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
        rest.push(p);
      } else if (p.startSample >= hi) {
        rest.push(p); // 未来组的脉冲,保留
      }
      // 过早且不匹配的脉冲直接丢弃
    }
    this.pendingPulses = rest.filter((p) => p !== best);
    return best;
  }

  private decodeGroup(
    freq: Float32Array,
    baseSample: number,
    groupStart: number,
    groupIsLive: boolean,
  ): void {
    const img = this.image!;
    const { mode, sampleRate } = this;
    const linesInGroup = mode.linesPerGroup;
    const baseLine = this.groupIndex * linesInGroup;

    for (let li = 0; li < linesInGroup; li++) {
      const y = baseLine + li;
      if (y >= mode.height) return;
      img.anchorTimes[y] = groupStart / sampleRate;

      let rowHasSignal = false;
      for (const seg of mode.segments) {
        // Robot36 的 Y_EVEN 段属于组内第二行;其余段属于第一行。
        // PD120: Y→奇数索引行(组内行0),Y_EVEN→行1,U/V 两行共享。
        const targetRow = seg.kind === 'Y_EVEN' ? baseLine + 1 : y;
        if (targetRow >= mode.height) continue;
        this.sampleSegment(freq, baseSample, groupStart, seg, targetRow, groupIsLive, () => {
          rowHasSignal = true;
        });
      }

      const source: LineSource = groupIsLive || rowHasSignal ? (groupIsLive ? 'live' : 'patched') : 'patched';
      img.markLine(y, source);
      if (linesInGroup === 2 && baseLine + 1 < mode.height) {
        // 组内第二行:若没有独立 Y_EVEN 段(Robot36 有),也给个来源标记
        if (mode.segments.some((s) => s.kind === 'Y_EVEN')) {
          img.markLine(baseLine + 1, source);
        }
      }
      this.events.onLine?.({ index: y, source, anchorTime: groupStart / sampleRate });
    }
  }

  private sampleSegment(
    freq: Float32Array,
    baseSample: number,
    groupStart: number,
    seg: SegmentSpec,
    row: number,
    groupIsLive: boolean,
    markSignal: () => void,
  ): void {
    const img = this.image!;
    const plane = img.plane(seg.kind);
    const last = this.lastKnown.get(seg.kind)!;
    const segStart = groupStart + Math.round(seg.offset * this.sampleRate);
    const pixelTime = seg.duration / seg.width;
    // 每像素取其中段 40% 平均:Scottie 像素仅约 5 样本,窗口过宽会跨过段边界
    // 把 porch/sync 频率混入;40% 保证落在像素内部且至少 3 个样本。
    const avgFrac = 0.4;
    const minHalf = 1; // 至少覆盖 center±1 共 3 样本

    for (let x = 0; x < seg.width; x++) {
      // 网格锚点是补偿后的真实信号时间;频率数组滞后 DEMOD_GROUP_DELAY,
      // 故采样索引加回该固定延迟(唯一一处延迟补偿)
      const center = segStart + Math.round((x + 0.5) * pixelTime * this.sampleRate) + DEMOD_GROUP_DELAY;
      const half = Math.max(minHalf, Math.round((pixelTime * avgFrac * 0.5) * this.sampleRate));
      const ls = center - half;
      const le = center + half;
      const localS = ls - baseSample;
      const localE = le - baseSample;
      const idx = row * seg.width + x;

      if (localE <= 0 || localS >= freq.length) {
        // 完全在块外:自由运行补值
        plane[idx] = last[x];
        img.patched[idx] = 1;
        continue;
      }
      const s = Math.max(0, localS);
      const e = Math.min(freq.length, localE);
      let sum = 0;
      let n = 0;
      for (let i = s; i < e; i++) {
        const f = freq[i];
        // 明显异常(超出 SSTV 频带 ±200Hz)视为坏样本
        if (f > 900 && f < 2500) {
          sum += f;
          n++;
        }
      }
      if (n === 0) {
        plane[idx] = last[x];
        img.patched[idx] = 1;
        continue;
      }
      markSignal();
      const mean = sum / n;
      const luma = freqToLuma(mean);
      plane[idx] = luma;
      last[x] = luma;
      if (!groupIsLive) img.patched[idx] = 1;
    }
  }

  private finish(nowWall: number): void {
    if (this.phase !== 'receiving' || !this.image) return;
    this.phase = 'done';
    // 空行填灰并标记
    for (let y = 0; y < this.image.height; y++) {
      if (this.image.lineSource[y] === LINE_SOURCE_EMPTY) {
        this.image.markLine(y, 'patched');
        for (const plane of this.image.planes.values()) {
          for (let x = 0; x < this.image.width; x++) {
            plane[y * this.image.width + x] = 128;
            this.image.patched[y * this.image.width + x] = 1;
          }
        }
      }
    }
    this.events.onComplete?.(this.image);
    void nowWall;
  }

  reset(): void {
    this.phase = 'idle';
    this.image = null;
    this.pendingPulses.length = 0;
    this.freeRunGroups = 0;
    this.lockedFirstSync = false;
    this.dropoutActive = false;
  }

  get stats() {
    return {
      freeRunGroups: this.freeRunGroups,
      dropoutActive: this.dropoutActive,
      groupIndex: this.groupIndex,
      nextExpectedSyncSample: this.nextExpectedSyncSample,
    };
  }
}

export { LINE_SOURCE_LIVE, LINE_SOURCE_PATCHED, LINE_SOURCE_EMPTY };
