import { describe, expect, it } from 'vitest';
import { attemptsLeftText, COURIER_HOME, courierButtons, FAIL_REASONS, isFailReason, normalizePin, staffHomePath } from './courier';

describe('staffHomePath（ログイン後・業務画面の入口の振り分け）', () => {
  it('配達員は /staff/courier（Cookie の Path が /staff なので、/courier ではない）', () => {
    expect(staffHomePath('courier')).toBe('/staff/courier');
    expect(COURIER_HOME).toBe('/staff/courier');
  });

  it('スタッフ・店長・知らない role は /staff', () => {
    expect(staffHomePath('staff')).toBe('/staff');
    expect(staffHomePath('manager')).toBe('/staff');
    expect(staffHomePath('')).toBe('/staff');
    expect(staffHomePath('Courier')).toBe('/staff');
  });
});

describe('courierButtons', () => {
  it('assigned: 集荷だけ。picked_up: 出発だけ', () => {
    expect(courierButtons(['pickup']).map((b) => b.action)).toEqual(['pickup']);
    expect(courierButtons(['depart']).map((b) => b.action)).toEqual(['depart']);
  });

  it('delivering: 到着（暗証コード）→ 不在の順。ラベルは固定', () => {
    expect(courierButtons(['fail', 'deliver'])).toEqual([
      { action: 'deliver', label: '到着・暗証コードで確認' },
      { action: 'fail', label: '不在・受け取れない' },
    ]);
  });

  it('知らない action・店の操作（assign・cancel）は出さない。重複は 1 つ', () => {
    expect(courierButtons(['assign', 'cancel', 'complete', 'refund'])).toEqual([]);
    expect(courierButtons(['pickup', 'pickup', 'cancel']).map((b) => b.action)).toEqual(['pickup']);
  });

  it('空なら、ボタンなし', () => {
    expect(courierButtons([])).toEqual([]);
  });
});

describe('normalizePin', () => {
  it('4 桁の数字はそのまま', () => {
    expect(normalizePin('4821')).toBe('4821');
    expect(normalizePin('0000')).toBe('0000');
  });

  it('全角の数字は半角にする', () => {
    expect(normalizePin('４８２１')).toBe('4821');
    expect(normalizePin('4８2１')).toBe('4821');
  });

  it('前後の空白（半角・全角・改行）は除く。間の空白は不可', () => {
    expect(normalizePin(' 4821 ')).toBe('4821');
    expect(normalizePin('　4821　')).toBe('4821');
    expect(normalizePin('4821\n')).toBe('4821');
    expect(normalizePin('48 21')).toBeNull();
  });

  it('桁数が違えば null（3 桁・5 桁・空）', () => {
    expect(normalizePin('482')).toBeNull();
    expect(normalizePin('48211')).toBeNull();
    expect(normalizePin('')).toBeNull();
    expect(normalizePin('    ')).toBeNull();
  });

  it('数字以外は null（英字・記号・符号・小数・アラビア数字）', () => {
    for (const bad of ['48a1', 'abcd', '48-1', '-482', '+482', '4.21', '48２a', '٤٨٢١', '4821\u0000']) expect(normalizePin(bad)).toBeNull();
  });

  it('文字列でなければ null', () => {
    for (const bad of [undefined, null, 4821, {}, ['4821']]) expect(normalizePin(bad)).toBeNull();
  });
});

describe('isFailReason（自由記述は受けない）', () => {
  it('決まった 3 つだけ', () => {
    expect(FAIL_REASONS.map((r) => r.value)).toEqual(['absent', 'cannot_receive', 'other']);
    for (const r of ['absent', 'cannot_receive', 'other']) expect(isFailReason(r)).toBe(true);
  });

  it('それ以外（pin_locked は system だけ・ラベル・自由な文・空・型違い）は不可', () => {
    for (const bad of ['pin_locked', '不在', '玄関に誰もいなかった', '', ' absent', 'ABSENT', undefined, null, 1]) expect(isFailReason(bad)).toBe(false);
  });
});

describe('attemptsLeftText', () => {
  it('2 回以上は、回数だけ', () => {
    expect(attemptsLeftText(5)).toBe('残り 5 回');
    expect(attemptsLeftText(2)).toBe('残り 2 回');
  });

  it('1 回以下は、止まることを添える。負の数は 0', () => {
    expect(attemptsLeftText(1)).toBe('残り 1 回（間違えると配達が止まります）');
    expect(attemptsLeftText(0)).toBe('残り 0 回（間違えると配達が止まります）');
    expect(attemptsLeftText(-1)).toBe('残り 0 回（間違えると配達が止まります）');
  });

  it('delivering 以外（null）・数でない値は、何も出さない', () => {
    expect(attemptsLeftText(null)).toBeNull();
    expect(attemptsLeftText(Number.NaN)).toBeNull();
    expect(attemptsLeftText(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
