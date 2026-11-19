/**
 * UI 主控制器: 连接声卡采集 / 解码 Worker / 画布渲染 / 测试信号 / 日志。
 */
import { AudioCapture } from '../audio/capture';
import { LogStore } from '../audio/log-store';
import { exportAdif, makeId } from '../sstv/adif';
import type { QsoRecord } from '../sstv/adif';
import { buildTestSignal, chunkPcm } from '../test/generator';
import type { TestSignalConfig } from '../test/generator';

interface WorkerImageMessage {
  type: string;
  width: number;
  height: number;
  linesDone?: number;
  rgba?: ArrayBuffer;
  rgbaClean?: ArrayBuffer;
  lineSource?: number[];
  meta?: {
    mode: { id: string; name: string };
    startedAt: number;
    completedAt: number;
    durationSec: number;
    patchedLineCount: number;
    totalLines: number;
    visCode: number | null;
    meanSnrDb: number;
  };
  status?: {
    phase: string;
    mode: { id: string; name: string } | null;
    guessing: boolean;
    guessDeadlineSec: number | null;
    modeGuess: { mode: { name: string }; confidence: number; reasons: string[] } | null;
    snrDb: number;
    dropout: boolean;
    linesDone: number;
    totalLines: number;
  };
  active?: boolean;
  modeId?: string;
  source?: string;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const $btn = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;

class App {
  private worker: Worker;
  private capture: AudioCapture;
  private logStore = new LogStore();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;
  private records: QsoRecord[] = [];
  private recordSeq = 0;

  constructor() {
    this.worker = new Worker(new URL('../workers/decoder.worker.ts', import.meta.url), { type: 'module' });
    this.capture = new AudioCapture({
      onAudio: (samples) => this.worker.postMessage({ type: 'audio', samples }, [samples.buffer]),
    });
    this.canvas = $<HTMLCanvasElement>('live-canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.bindWorker();
    this.bindControls();
    void this.logStore.init().then(() => this.refreshLog());
    void this.populateDevices();
  }

  private bindWorker(): void {
    this.worker.onmessage = (e: MessageEvent<WorkerImageMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'status':
          this.onStatus(msg);
          break;
        case 'progress':
          this.onProgress(msg);
          break;
        case 'imageStart':
          $('live-overlay').hidden = true;
          $('chip-mode').textContent = `模式: ${msg.modeId} (${msg.source === 'vis' ? 'VIS' : '猜测'})`;
          break;
        case 'imageComplete':
          this.onImageComplete(msg);
          break;
        case 'dropout':
          $('chip-dropout').classList.toggle('hidden', !msg.active);
          break;
      }
    };
  }

  private onStatus(msg: WorkerImageMessage): void {
    const s = msg.status!;
    $('chip-phase').textContent = s.phase === 'RECEIVING' ? '接收中' : '搜索信号';
    $('chip-snr').textContent = `SNR: ${s.snrDb.toFixed(1)} dB`;
    $('chip-mode').textContent = s.mode ? `模式: ${s.mode.name}` : '模式: -';
    const guessBox = $('guess-box');
    guessBox.hidden = !(s.guessing && s.phase === 'SEARCH_CALIB');
    if (s.guessing && s.modeGuess) {
      $('guess-detail').textContent =
        `当前最可能: ${s.modeGuess.mode.name}(置信度 ${(s.modeGuess.confidence * 100).toFixed(0)}%)`;
      $('guess-countdown').textContent =
        s.guessDeadlineSec !== null ? `判定倒计时: ${s.guessDeadlineSec.toFixed(1)}s` : '';
    }
    if (s.totalLines > 0) {
      $('progress-text').textContent = `${s.linesDone} / ${s.totalLines} 行`;
      $('progress-fill').style.width = `${(s.linesDone / s.totalLines) * 100}%`;
    }
  }

  private onProgress(msg: WorkerImageMessage): void {
    const rgba = new Uint8ClampedArray(msg.rgba!);
    if (!this.imageData || this.imageData.width !== msg.width || this.imageData.height !== msg.height) {
      this.canvas.width = msg.width;
      this.canvas.height = msg.height;
      this.imageData = this.ctx.createImageData(msg.width, msg.height);
    }
    this.imageData.data.set(rgba);
    this.ctx.putImageData(this.imageData, 0, 0);
    const lines = msg.linesDone ?? 0;
    $('progress-text').textContent = `${lines} / ${msg.height} 行`;
    $('progress-fill').style.width = `${(lines / msg.height) * 100}%`;
  }

  private onImageComplete(msg: WorkerImageMessage): void {
    const meta = msg.meta!;
    // 最终渲染(带补全标记版)
    this.onProgress(msg);
    const now = new Date();
    const record: QsoRecord = {
      id: makeId(this.recordSeq++),
      call: '',
      freqHz: 14230000,
      timeOn: new Date(now.getTime() - meta.durationSec * 1000).toISOString(),
      timeOff: now.toISOString(),
      mode: meta.mode.id,
      adifMode: 'SSTV',
      rstReceived: '599',
      operator: '',
      comment: `${meta.mode.name}; 补全行 ${meta.patchedLineCount}/${meta.totalLines}; 平均SNR ${meta.meanSnrDb.toFixed(1)}dB`,
      thumbnail: this.bufferToDataUrl(msg.rgbaClean!, msg.width, msg.height, 160),
      hasPatchedLines: meta.patchedLineCount > 0,
      patchedLineCount: meta.patchedLineCount,
      meanSnrDb: meta.meanSnrDb,
    };
    void this.logStore.add(record).then(() => this.refreshLog());
  }

  private bufferToDataUrl(buffer: ArrayBuffer, w: number, h: number, thumbW: number): string {
    const src = new Uint8ClampedArray(buffer);
    const thumbH = Math.round((h / w) * thumbW);
    const c = document.createElement('canvas');
    c.width = thumbW;
    c.height = thumbH;
    const cx = c.getContext('2d')!;
    const full = document.createElement('canvas');
    full.width = w;
    full.height = h;
    const fx = full.getContext('2d')!;
    fx.putImageData(new ImageData(src, w, h), 0, 0);
    cx.drawImage(full, 0, 0, thumbW, thumbH);
    return c.toDataURL('image/png');
  }

  private bindControls(): void {
    $('btn-start').addEventListener('click', () => void this.startCapture());
    $('btn-stop').addEventListener('click', () => void this.stopCapture());
    $('btn-reset').addEventListener('click', () => {
      this.worker.postMessage({ type: 'reset' });
      this.resetCanvas();
    });
    $('btn-test-play').addEventListener('click', () => void this.playTestSignal());
    $('btn-export-adif').addEventListener('click', () => this.exportAdif());
    $('btn-clear-log').addEventListener('click', () => {
      if (confirm('确认清空全部通联日志?')) void this.logStore.clear().then(() => this.refreshLog());
    });
    $('device-select').addEventListener('change', (e) => {
      AudioCapture.saveDevice((e.target as HTMLSelectElement).value);
    });
  }

  private async populateDevices(): Promise<void> {
    try {
      const devices = await AudioCapture.enumerateInputs();
      const select = $<HTMLSelectElement>('device-select');
      select.innerHTML = '';
      for (const d of devices) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `声卡 ${d.deviceId.slice(0, 8)}`;
        select.appendChild(opt);
      }
      const saved = AudioCapture.loadDevice();
      if (saved) select.value = saved;
    } catch {
      // 未授权麦克风时设备列表为空,用户点开始后浏览器会弹授权
    }
  }

  private async startCapture(): Promise<void> {
    try {
      const deviceId = $<HTMLSelectElement>('device-select').value || AudioCapture.loadDevice() || undefined;
      await this.capture.start(deviceId);
      $btn('btn-start').disabled = true;
      $btn('btn-stop').disabled = false;
      $('live-overlay').textContent = '等待 SSTV 信号…';
    } catch (err) {
      alert(`无法打开声卡: ${(err as Error).message}`);
    }
  }

  private async stopCapture(): Promise<void> {
    await this.capture.stop();
    $btn('btn-start').disabled = false;
    $btn('btn-stop').disabled = true;
  }

  private resetCanvas(): void {
    this.ctx.fillStyle = '#05070a';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    $('live-overlay').hidden = false;
    $('live-overlay').textContent = '等待信号…';
    $('progress-fill').style.width = '0';
    $('chip-dropout').classList.add('hidden');
  }

  private async playTestSignal(): Promise<void> {
    const modeId = $<HTMLSelectElement>('test-mode').value as TestSignalConfig['modeId'];
    const pattern = $<HTMLSelectElement>('test-pattern').value as TestSignalConfig['pattern'];
    const snrDb = Number($<HTMLSelectElement>('test-snr').value);
    const dropoutKind = $<HTMLSelectElement>('test-dropout').value;
    const dropouts =
      dropoutKind === 'single'
        ? [{ startSec: 3, durationSec: 3 }]
        : dropoutKind === 'multi'
          ? [
              { startSec: 2, durationSec: 1.5 },
              { startSec: 6, durationSec: 2 },
              { startSec: 11, durationSec: 1 },
            ]
          : [];
    // 测试信号在主线程生成(纯计算),分块送入 worker,模拟实时麦克风流但尽快喂入
    const sig = buildTestSignal({ modeId, pattern, snrDb, dropouts });
    this.worker.postMessage({ type: 'reset' });
    $('live-overlay').hidden = true;
    for (const chunk of chunkPcm(sig.pcm, 1024)) {
      const copy = chunk.slice();
      this.worker.postMessage({ type: 'pcm', samples: copy }, [copy.buffer]);
    }
  }

  private async refreshLog(): Promise<void> {
    this.records = await this.logStore.all();
    const tbody = $('log-tbody');
    tbody.innerHTML = '';
    for (const r of this.records) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(r.timeOn).toLocaleString()}</td>
        <td><input data-id="${r.id}" data-field="call" value="${this.esc(r.call)}" placeholder="呼号"></td>
        <td>${r.mode}</td>
        <td><input data-id="${r.id}" data-field="freq" type="number" step="0.001" value="${(r.freqHz / 1e6).toFixed(3)}"></td>
        <td>-</td>
        <td>${r.patchedLineCount}</td>
        <td>${r.meanSnrDb.toFixed(1)}</td>
        <td>${r.thumbnail ? `<img src="${r.thumbnail}" alt="thumb">` : ''}</td>
        <td class="row-actions">
          <button data-action="png" data-id="${r.id}">PNG</button>
          <button data-action="del" data-id="${r.id}">删除</button>
        </td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', () => this.editRecord(input));
    });
    tbody.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => this.rowAction(btn));
    });
    this.renderGallery();
  }

  private esc(s: string): string {
    return s.replace(/"/g, '&quot;');
  }

  private async editRecord(input: Element): Promise<void> {
    const el = input as HTMLInputElement;
    const id = el.dataset.id!;
    const field = el.dataset.field!;
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    if (field === 'call') record.call = el.value.trim().toUpperCase();
    if (field === 'freq') record.freqHz = Math.round(Number(el.value) * 1e6);
    await this.logStore.update(record);
  }

  private rowAction(btn: Element): void {
    const el = btn as HTMLButtonElement;
    const id = el.dataset.id!;
    if (el.dataset.action === 'del') {
      void this.logStore.remove(id).then(() => this.refreshLog());
    } else if (el.dataset.action === 'png') {
      this.downloadPng(id);
    }
  }

  private downloadPng(id: string): void {
    const record = this.records.find((r) => r.id === id);
    if (!record?.thumbnail) return;
    const a = document.createElement('a');
    a.href = record.thumbnail;
    a.download = `sstv-${record.mode}-${id}.png`;
    a.click();
  }

  private renderGallery(): void {
    const gallery = $('gallery');
    gallery.innerHTML = '';
    for (const r of this.records.slice(0, 8)) {
      if (!r.thumbnail) continue;
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `<img src="${r.thumbnail}" alt=""><span class="tag">${r.mode}${r.hasPatchedLines ? ' ⚠' : ''}</span>`;
      gallery.appendChild(div);
    }
  }

  private exportAdif(): void {
    if (this.records.length === 0) {
      alert('暂无日志可导出');
      return;
    }
    const content = exportAdif(this.records);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sstv-log-${new Date().toISOString().slice(0, 10)}.adi`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

new App();
