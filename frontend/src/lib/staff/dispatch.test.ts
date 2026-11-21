import { describe, expect, it } from 'vitest';
import type { DeliveryStatus } from './delivery-types';
import {
  attemptLabel,
  canMockAdvance,
  columnOf,
  courierChoices,
  DEFAULT_UTC_OFFSET_HOURS,
  defaultCourierId,
  DELIVERY_STATUS_LABELS,
  deliveryOf,
  DISPATCH_COLUMN_LABELS,
  DISPATCH_COLUMNS,
  DISPATCH_STATUSES,
  failureLabel,
  formatClock,
  groupDispatch,
  parseOffsetHours,
  slotLabel,
  slotText,
  suggestionLabel,
  vehicleLabel,
  zoneSummary,
} from './dispatch';
import { courier, dispatchOrder, zone } from './dispatch-fixtures';
import { NOW, order } from './test-fixtures';

describe('列', () => {
  it('列は、割り当て待ち・割り当て済み・配達中・不在（要対応）の順', () => {
    expect(DISPATCH_COLUMNS.map((c) => DISPATCH_COLUMN_LABELS[c])).toEqual(['割り当て待ち', '割り当て済み（集荷前）', '配達中', '不在・要対応']);
  });

  it('API に渡す状態は、配車ボードの 5 つ（API の既定と同じ）', () => {
    expect([...DISPATCH_STATUSES]).toEqual(['ready', 'assigned', 'picked_up', 'delivering', 'delivery_failed']);
  });
});

describe('columnOf', () => {
  it.each([
    ['ready', 'ready'],
    ['assigned', 'assigned'],
    ['picked_up', 'moving'],
    ['delivering', 'moving'],
    ['delivery_failed', 'delivery_failed'],
  ])('%s は %s の列', (status, column) => {
    expect(columnOf(status)).toBe(column);
  });

  it.each(['paid', 'accepted', 'preparing', 'delivered', 'completed', 'cancelled', 'placed', '', 'READY'])('ボードに無い状態（%s）は null', (status) => {
    expect(columnOf(status)).toBeNull();
  });
});

describe('groupDispatch', () => {
  const o = (id: string, status: string) => dispatchOrder({ public_id: id, status });

  it('API の順（枠の開始が早い順）を、列の中でも保つ。picked_up と delivering は同じ列', () => {
    const groups = groupDispatch([o('A', 'ready'), o('B', 'assigned'), o('C', 'ready'), o('D', 'delivering'), o('E', 'picked_up'), o('F', 'delivery_failed')]);
    expect(groups.ready.map((x) => x.public_id)).toEqual(['A', 'C']);
    expect(groups.assigned.map((x) => x.public_id)).toEqual(['B']);
    expect(groups.moving.map((x) => x.public_id)).toEqual(['D', 'E']);
    expect(groups.delivery_failed.map((x) => x.public_id)).toEqual(['F']);
  });

  it('ボードに無い状態の注文は捨てる', () => {
    const groups = groupDispatch([o('A', 'paid'), o('B', 'completed'), o('C', 'cancelled'), o('D', 'ready'), o('E', 'unknown')]);
    expect(Object.values(groups).flat().map((x) => x.public_id)).toEqual(['D']);
  });

  it('空でも、4 列とも空の配列を返す。入力は変えない', () => {
    expect(groupDispatch([])).toEqual({ ready: [], assigned: [], moving: [], delivery_failed: [] });
    const input = [o('A', 'ready'), o('B', 'paid')];
    groupDispatch(input);
    expect(input.map((x) => x.public_id)).toEqual(['A', 'B']);
  });
});

describe('parseOffsetHours（LOCAL_UTC_OFFSET_HOURS）', () => {
  it('整数の時差を読む。前後の空白は無視する', () => {
    expect(parseOffsetHours('0')).toBe(0);
    expect(parseOffsetHours('-5')).toBe(-5);
    expect(parseOffsetHours(' 7 ')).toBe(7);
    expect(parseOffsetHours('-12')).toBe(-12);
    expect(parseOffsetHours('14')).toBe(14);
  });

  it('範囲（-12〜14）の外・数でないもの・未設定は、既定（9）にする', () => {
    expect(DEFAULT_UTC_OFFSET_HOURS).toBe(9);
    for (const bad of ['15', '-13', '99', 'abc', '', '  ', '9.5', '1e1', '--1', null, undefined]) {
      expect(parseOffsetHours(bad as string | null | undefined)).toBe(9);
    }
  });
});

describe('formatClock', () => {
  it('UTC の時刻を、店のローカル時刻の "HH:MM" にする', () => {
    expect(formatClock('2026-11-21T04:00:00Z', 9)).toBe('13:00');
    expect(formatClock('2026-11-21T04:05:00Z', 0)).toBe('04:05');
  });

  it('日をまたぐ（時差で前日・翌日になる）ときも、時刻は合う', () => {
    expect(formatClock('2026-11-21T20:30:00Z', 9)).toBe('05:30');
    expect(formatClock('2026-11-21T03:00:00Z', -5)).toBe('22:00');
  });

  it('読めない時刻は空文字', () => {
    expect(formatClock('', 9)).toBe('');
    expect(formatClock('あした', 9)).toBe('');
  });
});

describe('slotLabel', () => {
  const slot = (day: string) => ({ starts_at: `${day}T04:00:00Z`, ends_at: `${day}T04:30:00Z` });

  it('今日（ローカル日付）の枠は、時刻の範囲だけ', () => {
    expect(slotLabel(slot('2026-11-21'), NOW, 9)).toBe('13:00〜13:30');
  });

  it('別の日の枠は、月/日を添える', () => {
    expect(slotLabel(slot('2026-11-22'), NOW, 9)).toBe('11/22 13:00〜13:30');
    expect(slotLabel(slot('2027-01-01'), '2026-12-31T03:00:00Z', 9)).toBe('1/1 13:00〜13:30');
  });

  it('「今日」は店のローカル日付で決める（UTC の日付ではない）', () => {
    // 23:59（UTC+9）の now に対して、00:00（翌日）の枠は別の日
    const midnight = { starts_at: '2026-11-21T15:00:00Z', ends_at: '2026-11-21T15:30:00Z' };
    expect(slotLabel(midnight, '2026-11-21T14:59:00Z', 9)).toBe('11/22 00:00〜00:30');
    // 同じ UTC の時刻でも、時差が 0 なら同じ日
    expect(slotLabel(midnight, '2026-11-21T14:59:00Z', 0)).toBe('15:00〜15:30');
  });

  it('now が読めないときは、日付を決められないので、範囲だけ返す', () => {
    expect(slotLabel(slot('2026-11-22'), 'いま', 9)).toBe('13:00〜13:30');
  });
});

describe('slotText（画面で使う枠の文）', () => {
  it('読める枠は slotLabel と同じ', () => {
    expect(slotText({ starts_at: '2026-11-21T04:00:00Z', ends_at: '2026-11-21T04:30:00Z' }, NOW, 9)).toBe('13:00〜13:30');
  });

  it('開始が読めなければ「時刻不明」（"〜" だけを出さない）', () => {
    expect(slotText({ starts_at: '', ends_at: '' }, NOW, 9)).toBe('時刻不明');
  });
});

describe('failureLabel', () => {
  it('失敗の理由を日本語にする。無ければ null', () => {
    expect(failureLabel(null)).toBeNull();
    expect(failureLabel('absent')).toBe('不在');
    expect(failureLabel('cannot_receive')).toBe('受け取れない');
    expect(failureLabel('other')).toBe('その他');
    expect(failureLabel('pin_locked')).toBe('暗証コードの誤り（凍結）');
  });

  it('知らない理由は、そのまま返す（落とさない）', () => {
    expect(failureLabel('storm')).toBe('storm');
  });
});

describe('ラベル', () => {
  it('配達の状態は、7 つとも文言がある', () => {
    const all: DeliveryStatus[] = ['pending', 'assigned', 'picked_up', 'delivering', 'delivered', 'failed', 'cancelled'];
    for (const s of all) expect(DELIVERY_STATUS_LABELS[s]).toBeTruthy();
  });

  it('提案: 店にいる（0 分）か、店まで何分か', () => {
    expect(suggestionLabel({ courier_name: 'ラシード', minutes: 0 })).toBe('ラシード（店にいる）');
    expect(suggestionLabel({ courier_name: 'ラシード', minutes: 10 })).toBe('ラシード（店まで 10 分）');
  });

  it('乗り物: 知っているものは日本語、知らないものはそのまま', () => {
    expect(vehicleLabel('hover-scooter')).toBe('浮上スクーター');
    expect(vehicleLabel('sand-glider')).toBe('sand-glider');
  });

  it('配達の回数: 初回は出さない。再配達は何回目かを出す', () => {
    expect(attemptLabel(1)).toBeNull();
    expect(attemptLabel(0)).toBeNull();
    expect(attemptLabel(2)).toBe('配達 2 回目（再配達）');
    expect(attemptLabel(3)).toBe('配達 3 回目（再配達）');
  });
});

describe('courierChoices', () => {
  const couriers = [
    courier({ id: 7, store_id: 1, name: 'ラシード', active_count: 1 }),
    courier({ id: 8, store_id: 2, name: 'ナジャ' }),
    courier({ id: 9, store_id: 1, name: 'ハッサン', is_on_duty: false, active_count: 0 }),
    courier({ id: 10, store_id: 1, name: 'ユスラ', active_count: 3 }),
  ];

  it('注文の店の配達員だけを、API の順で出す（他店の配達員は選べない）', () => {
    const choices = courierChoices({ store: { id: 1, name: '居住区本店' } }, couriers);
    expect(choices.map((c) => c.id)).toEqual([7, 9, 10]);
    expect(courierChoices({ store: { id: 2, name: '発着場中央店' } }, couriers).map((c) => c.id)).toEqual([8]);
    expect(courierChoices({ store: { id: 3, name: '岩山店' } }, couriers)).toEqual([]);
  });

  it('勤務外は選べない（disabled）。文字でも「勤務外」と示す。担当の件数も出す', () => {
    const choices = courierChoices({ store: { id: 1, name: '居住区本店' } }, couriers);
    expect(choices[0]).toEqual({ id: 7, label: 'ラシード・担当 1 件', disabled: false });
    expect(choices[1]).toEqual({ id: 9, label: 'ハッサン（勤務外）・担当 0 件', disabled: true });
    expect(choices[2]).toEqual({ id: 10, label: 'ユスラ・担当 3 件', disabled: false });
  });
});

describe('defaultCourierId（割り当ての初期値）', () => {
  const store1 = { store: { id: 1, name: '居住区本店' } };
  const choices = courierChoices(store1, [courier({ id: 7 }), courier({ id: 9, is_on_duty: false })]);

  it('提案の配達員が選べるなら、その ID', () => {
    expect(defaultCourierId({ suggestion: { courier_id: 7, courier_name: 'ラシード', minutes: 0 } }, choices)).toBe('7');
  });

  it('提案が無い・勤務外・選択肢に無い（他店）なら、空（選ばせる）', () => {
    expect(defaultCourierId({ suggestion: null }, choices)).toBe('');
    expect(defaultCourierId({ suggestion: { courier_id: 9, courier_name: 'ハッサン', minutes: 0 } }, choices)).toBe('');
    expect(defaultCourierId({ suggestion: { courier_id: 99, courier_name: '他店', minutes: 0 } }, choices)).toBe('');
  });
});

describe('zoneSummary', () => {
  it('送料・無料の条件・最低注文額・基準の所要を、1 行にする（ルミ。「円」は使わない）', () => {
    const text = zoneSummary(zone({ fee_lumi: 150, free_over_lumi: 2000, min_order_lumi: 600, base_minutes: 25 }));
    expect(text).toBe('送料 150 ルミ・2,000 ルミ以上で無料・最低注文 600 ルミ・基準 25 分');
    expect(text).not.toContain('円');
  });

  it('無料の条件が無い区画は、その句を出さない', () => {
    expect(zoneSummary(zone({ free_over_lumi: null }))).toBe('送料 200 ルミ・最低注文 700 ルミ・基準 30 分');
  });
});

describe('deliveryOf（調理ボードの注文から、宅配の情報を読む）', () => {
  it('宅配の注文は、その配達を返す', () => {
    const o = dispatchOrder({ delivery: { status: 'assigned', attempt: 2 } });
    expect(deliveryOf(o)).toMatchObject({ status: 'assigned', attempt: 2 });
  });

  it('店頭の注文（delivery が無い・null）は null', () => {
    expect(deliveryOf(order())).toBeNull();
    expect(deliveryOf({ ...order(), delivery: null })).toBeNull();
  });

  it('形が違う（枠が無い・状態が文字でない）ものは、描けないので null（例外にしない）', () => {
    expect(deliveryOf({ delivery: { status: 'pending', attempt: 1 } })).toBeNull();
    expect(deliveryOf({ delivery: { status: 1, attempt: 1, slot: { starts_at: 'a', ends_at: 'b' } } })).toBeNull();
    expect(deliveryOf({ delivery: 'pending' })).toBeNull();
  });
});

describe('canMockAdvance（模擬で 1 つ進める）', () => {
  it('配達の提供者が mock で、進められる状態のときだけ', () => {
    for (const s of ['ready', 'assigned', 'picked_up', 'delivering']) expect(canMockAdvance('mock', s)).toBe(true);
    for (const s of ['delivery_failed', 'completed', 'cancelled', 'paid']) expect(canMockAdvance('mock', s)).toBe(false);
  });

  it('mock 以外は、どの状態でも出さない', () => {
    for (const s of ['ready', 'assigned', 'picked_up', 'delivering']) expect(canMockAdvance('inhouse', s)).toBe(false);
  });
});
