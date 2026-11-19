/**
 * SSTV 模式常量定义。
 *
 * 数值来源:
 *  - Martin/Scottie/Robot: 与开源 sstv 包(spec.ts)及 node-sstv 编码器交叉核对
 *  - PD 系列: node-sstv 的 PD 编码器(基于 PD 规范 PDF)
 * 所有时间单位为秒,频率单位为 Hz。
 */

export const FREQ_SYNC = 1200;
export const FREQ_PORCH = 1500;
export const FREQ_LEADER = 1900;
export const FREQ_BLACK = 1500;
export const FREQ_WHITE = 2300;
export const FREQ_VIS_0 = 1300;
export const FREQ_VIS_1 = 1100;

/** 亮度值 0..255 与频率之间的换算斜率 (2300-1500)/255 */
export const FREQ_PER_LUMA = 800 / 255; // ≈ 3.1372549

export function lumaToFreq(luma: number): number {
  return FREQ_BLACK + luma * FREQ_PER_LUMA;
}

export function freqToLuma(freq: number): number {
  const v = (freq - FREQ_BLACK) / FREQ_PER_LUMA;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 校准头 (300ms leader + 10ms break + 300ms leader + 30ms start + 8×30ms VIS + 30ms stop) */
export const HEADER_LEADER = 0.3;
export const HEADER_BREAK = 0.01;
export const HEADER_VIS_START = 0.03;
export const HEADER_VIS_BIT = 0.03;
export const HEADER_VIS_BITS = 8;

export type ColorFormat = 'GBR' | 'YUV';
export type ChannelKind = 'G' | 'B' | 'R' | 'Y' | 'U' | 'V' | 'Y_EVEN';

export interface SegmentSpec {
  /** 相对本行网格起点(同步脉冲起点)的偏移,秒 */
  offset: number;
  /** 段时长,秒 */
  duration: number;
  kind: ChannelKind;
  /** 该段输出像素宽度(PD/Robot 的半扫描段为 640/320) */
  width: number;
  /** 半分辨率扫描段(U/V 平均、Y 半扫描)标记 */
  halfRate?: boolean;
}

export interface SSTVModeSpec {
  id: string;
  name: string;
  vis: number;
  width: number;
  height: number;
  color: ColorFormat;
  /** 同步脉冲时长 */
  syncPulse: number;
  /** 完整行周期(相邻同步脉冲起点间隔);Scottie 模式同样适用 */
  lineTime: number;
  /** 一行内的扫描段定义,offset 均相对同步脉冲起点 */
  segments: SegmentSpec[];
  /** 仅偶数索引行(0,2,4…)带同步脉冲(Robot36/PD 这种"两行一组"模式) */
  syncEveryTwoLines?: boolean;
  /** 行组大小:PD/Robot36 一个同步周期覆盖两行 */
  linesPerGroup: number;
}

// ---- 通用段构造辅助 ----

function gbrSegments(opts: {
  syncPulse: number;
  syncPorch: number;
  sep: number;
  scan: number;
  width: number;
  scottie?: boolean;
}): SegmentSpec[] {
  const { syncPulse, syncPorch, sep, scan, width, scottie } = opts;
  const chan = sep + scan;
  if (scottie) {
    // Scottie: 行网格 = sync 起点。G 在 sync 之后约一个 chan 处开始,
    // B 再后一个 chan,R(带 sync 前导)就在网格起点之后。
    const rStart = syncPulse + syncPorch;
    const gStart = rStart + chan;
    const bStart = gStart + chan;
    return [
      { offset: gStart, duration: scan, kind: 'G', width },
      { offset: bStart, duration: scan, kind: 'B', width },
      { offset: rStart, duration: scan, kind: 'R', width },
    ];
  }
  // Martin: sync + porch + G + sep + B + sep + R + sep
  const gStart = syncPulse + syncPorch;
  const bStart = gStart + chan;
  const rStart = bStart + chan;
  return [
    { offset: gStart, duration: scan, kind: 'G', width },
    { offset: bStart, duration: scan, kind: 'B', width },
    { offset: rStart, duration: scan, kind: 'R', width },
  ];
}

// ---- Martin M1 ----
const M1_SCAN = 0.146432;
const M1_SEP = 0.000572;
const M1_SYNC = 0.004862;
const M1_PORCH = 0.000572;

// ---- Martin M2 ----
const M2_SCAN = 0.073216;

// ---- Scottie S1 ----
const S1_SCAN = 0.13824;
const S_SYNC = 0.009;
const S_PORCH = 0.0015;
const S_SEP = 0.0015;

// ---- Scottie S2 ----
const S2_SCAN = 0.088064;

// ---- Robot 36 ----
const R36_Y = 0.088;
const R36_UV = 0.044;
const R36_PORCH = 0.003;
const R36_SEP = 0.0045;
const R36_SEP_PORCH = 0.0015;

function robot36Spec(): SSTVModeSpec {
  const width = 320;
  // 每组两行,只有组首行有 sync;网格按"带 sync 的行"定义。
  // 行 A(偶数行): sync+porch, Y_A(88ms), sep(4.5)+porch(1.5), U_平均(44ms)
  // 行 B(奇数行): Y_B(88ms), sep(4.5)+porch(1.5), V_平均(44ms)
  // 参考 sstv 包: LINE_TIME = CHAN_OFFSETS[1] + HALF_SCAN
  const yStart = S_SYNC + R36_PORCH; // 0.012
  const uvStartA = yStart + R36_Y + R36_SEP + R36_SEP_PORCH; // 0.106
  const lineBStart = yStart + R36_Y; // 0.100
  const uvStartB = lineBStart + R36_Y + R36_SEP + R36_SEP_PORCH; // 0.194
  const lineTime = uvStartB + R36_UV; // 0.238
  return {
    id: 'ROBOT36',
    name: 'Robot 36',
    vis: 8,
    width,
    height: 240,
    color: 'YUV',
    syncPulse: S_SYNC,
    lineTime,
    linesPerGroup: 2,
    syncEveryTwoLines: true,
    segments: [
      { offset: yStart, duration: R36_Y, kind: 'Y', width },
      { offset: uvStartA, duration: R36_UV, kind: 'U', width, halfRate: true },
      { offset: lineBStart, duration: R36_Y, kind: 'Y_EVEN', width },
      { offset: uvStartB, duration: R36_UV, kind: 'V', width, halfRate: true },
    ],
  };
}

// ---- PD120 ----
// 来源: node-sstv pd.js。两行一组: sync(20)+porch(2.08),
// Y_odd(121.6ms), U_avg, V_avg, Y_even,四段同宽 640,无段间分隔。
const PD120_SCAN = 0.1216;
const PD_SYNC = 0.02;
const PD_PORCH = 0.00208;

function pd120Spec(): SSTVModeSpec {
  const width = 640;
  const yStart = PD_SYNC + PD_PORCH; // 0.02208
  const uStart = yStart + PD120_SCAN;
  const vStart = uStart + PD120_SCAN;
  const y2Start = vStart + PD120_SCAN;
  const lineTime = y2Start + PD120_SCAN; // 0.50848
  return {
    id: 'PD120',
    name: 'PD120',
    vis: 95,
    width,
    height: 496,
    color: 'YUV',
    syncPulse: PD_SYNC,
    lineTime,
    linesPerGroup: 2,
    syncEveryTwoLines: true,
    segments: [
      { offset: yStart, duration: PD120_SCAN, kind: 'Y', width },
      { offset: uStart, duration: PD120_SCAN, kind: 'U', width },
      { offset: vStart, duration: PD120_SCAN, kind: 'V', width },
      { offset: y2Start, duration: PD120_SCAN, kind: 'Y_EVEN', width },
    ],
  };
}

export const MODES: Record<string, SSTVModeSpec> = {
  MARTIN1: {
    id: 'MARTIN1',
    name: 'Martin 1',
    vis: 44,
    width: 320,
    height: 256,
    color: 'GBR',
    syncPulse: M1_SYNC,
    lineTime: M1_SYNC + M1_PORCH + 3 * (M1_SEP + M1_SCAN),
    linesPerGroup: 1,
    segments: gbrSegments({ syncPulse: M1_SYNC, syncPorch: M1_PORCH, sep: M1_SEP, scan: M1_SCAN, width: 320 }),
  },
  MARTIN2: {
    id: 'MARTIN2',
    name: 'Martin 2',
    vis: 40,
    width: 320,
    height: 256,
    color: 'GBR',
    syncPulse: M1_SYNC,
    lineTime: M1_SYNC + M1_PORCH + 3 * (M1_SEP + M2_SCAN),
    linesPerGroup: 1,
    segments: gbrSegments({ syncPulse: M1_SYNC, syncPorch: M1_PORCH, sep: M1_SEP, scan: M2_SCAN, width: 320 }),
  },
  SCOTTIE1: {
    id: 'SCOTTIE1',
    name: 'Scottie 1',
    vis: 60,
    width: 320,
    height: 256,
    color: 'GBR',
    syncPulse: S_SYNC,
    // LINE_TIME = SYNC_PULSE + 3 * (SEP + SCAN)
    lineTime: S_SYNC + 3 * (S_SEP + S1_SCAN),
    linesPerGroup: 1,
    segments: gbrSegments({ syncPulse: S_SYNC, syncPorch: S_PORCH, sep: S_SEP, scan: S1_SCAN, width: 320, scottie: true }),
  },
  SCOTTIE2: {
    id: 'SCOTTIE2',
    name: 'Scottie 2',
    vis: 56,
    width: 320,
    height: 256,
    color: 'GBR',
    syncPulse: S_SYNC,
    lineTime: S_SYNC + 3 * (S_SEP + S2_SCAN),
    linesPerGroup: 1,
    segments: gbrSegments({ syncPulse: S_SYNC, syncPorch: S_PORCH, sep: S_SEP, scan: S2_SCAN, width: 320, scottie: true }),
  },
  ROBOT36: robot36Spec(),
  PD120: pd120Spec(),
};

/** VIS 码 → 模式 (含解码端需要识别的全部模式) */
export const VIS_TO_MODE: Record<number, SSTVModeSpec> = Object.fromEntries(
  Object.values(MODES).map((m) => [m.vis, m]),
);

export const ALL_MODES = Object.values(MODES);

/**
 * VIS 奇偶校验:7 位数据 + 1 位偶校验。
 * 返回校验是否通过。
 */
export function visParityOk(visByte: number): boolean {
  let ones = 0;
  for (let i = 0; i < 8; i++) if ((visByte >> i) & 1) ones++;
  return ones % 2 === 0;
}
