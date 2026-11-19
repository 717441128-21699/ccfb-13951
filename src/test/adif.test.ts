import { describe, expect, it } from 'vitest';
import { exportAdif, recordToAdif } from '../sstv/adif';
import type { QsoRecord } from '../sstv/adif';

function baseRecord(over: Partial<QsoRecord> = {}): QsoRecord {
  return {
    id: 'qso_test_1',
    call: 'BG7XYZ',
    freqHz: 14230000,
    timeOn: '2026-11-20T08:30:00.000Z',
    timeOff: '2026-11-20T08:31:14.000Z',
    mode: 'ROBOT36',
    adifMode: 'SSTV',
    rstReceived: '599',
    operator: 'BG1ABC',
    comment: '测试',
    hasPatchedLines: false,
    patchedLineCount: 0,
    meanSnrDb: 18.5,
    ...over,
  };
}

describe('ADIF 导出', () => {
  it('单条记录包含必需字段和 EOR', () => {
    const out = recordToAdif(baseRecord());
    expect(out).toContain('<CALL:6>BG7XYZ');
    expect(out).toContain('<MODE:4>SSTV');
    expect(out).toContain('<SUBMODE:7>ROBOT36');
    expect(out).toContain('<FREQ:9>14.230000');
    expect(out).toContain('<QSO_DATE:8>20261120');
    expect(out).toContain('<TIME_ON:6>083000');
    expect(out).toContain('<EOR>');
  });

  it('空呼号字段被省略而不是输出空标签', () => {
    const out = recordToAdif(baseRecord({ call: '' }));
    expect(out).not.toContain('<CALL:');
    expect(out).toContain('<EOR>');
  });

  it('多条记录导出带 EOH 头', () => {
    const adif = exportAdif([baseRecord(), baseRecord({ id: 'qso_test_2', call: 'JA1TEST' })]);
    expect(adif).toContain('<EOH>');
    const eorCount = (adif.match(/<EOR>/g) || []).length;
    expect(eorCount).toBe(2);
    expect(adif).toContain('JA1TEST');
  });

  it('时间按 UTC 格式化', () => {
    const out = recordToAdif(baseRecord({ timeOn: '2026-01-02T00:05:09.000Z' }));
    expect(out).toContain('<QSO_DATE:8>20260102');
    expect(out).toContain('<TIME_ON:6>000509');
  });
});
