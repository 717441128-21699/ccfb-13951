/**
 * 通联日志(QSO log)与 ADIF 导出。
 * 每张图收完自动生成一条记录,呼号/频率/时间可在 UI 补全。
 */

export interface QsoRecord {
  id: string;
  /** 对方呼号,未知时为空字符串 */
  call: string;
  /** 频率 Hz(如 14230000 表示 14.230 MHz) */
  freqHz: number;
  /** 接收开始时间 (ISO 8601) */
  timeOn: string;
  /** 接收结束时间 (ISO 8601) */
  timeOff: string;
  mode: string; // SSTV 子模式名,如 ROBOT36
  /** ADIF MODE 字段固定 SSTV */
  adifMode: 'SSTV';
  /** 信号报告 RST,默认 599 */
  rstReceived: string;
  /** 接收方(本台)呼号 */
  operator: string;
  /** 备注:补全行数、SNR 等 */
  comment: string;
  /** 缩略图 dataURL,可选 */
  thumbnail?: string;
  /** 本次接收的图像是否含补全行 */
  hasPatchedLines: boolean;
  patchedLineCount: number;
  meanSnrDb: number;
}

const ADIF_FIELDS: Array<[keyof QsoRecord, string, (v: QsoRecord) => string | number]> = [
  ['call', 'CALL', (v) => v.call],
  ['freqHz', 'FREQ', (v) => (v.freqHz / 1e6).toFixed(6)],
  ['operator', 'OPERATOR', (v) => v.operator],
  ['rstReceived', 'RST_RCVD', (v) => v.rstReceived],
  ['adifMode', 'MODE', (v) => v.adifMode],
  ['comment', 'COMMENT', (v) => v.comment],
];

function adifTag(field: string, value: string | number): string {
  const s = String(value);
  // ADIF 长度按字节计(ASCII 内容长度=字符数)
  return `<${field}:${s.length}>${s} `;
}

function adifDate(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function adifTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}${mi}${ss}`;
}

/** 单条记录 → ADIF record(以 <EOR> 结尾)。 */
export function recordToAdif(r: QsoRecord): string {
  let out = '';
  for (const [, field, getter] of ADIF_FIELDS) {
    const val = getter(r);
    if (val !== '' && val !== undefined) out += adifTag(field, val);
  }
  out += adifTag('QSO_DATE', adifDate(r.timeOn));
  out += adifTag('TIME_ON', adifTime(r.timeOn));
  out += adifTag('QSO_DATE_OFF', adifDate(r.timeOff));
  out += adifTag('TIME_OFF', adifTime(r.timeOff));
  out += adifTag('SUBMODE', r.mode);
  out += '<EOR>\n';
  return out;
}

/** 多条记录 → 完整 ADIF 文件(含头部)。 */
export function exportAdif(records: QsoRecord[], programId = 'WEB-SSTV'): string {
  const headerBody = `ADIF export from ${programId}\nCopyright (C) web-sstv`;
  const header = `${headerBody}\n<EOH>\n`;
  return header + records.map(recordToAdif).join('');
}

/** 简单确定性 ID 生成(不依赖 crypto.randomUUID 的旧环境也能用)。 */
export function makeId(seed: number): string {
  return `qso_${Date.now().toString(36)}_${seed.toString(36)}`;
}
