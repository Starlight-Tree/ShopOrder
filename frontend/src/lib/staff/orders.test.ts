import { describe, expect, it } from 'vitest';
import {
  actionButtons,
  elapsedMinutes,
  formatElapsed,
  groupByStatus,
  isOverdue,
  itemSpec,
  parseStoreParam,
  storeLabel,
} from './orders';
import { NOW, order } from './test-fixtures';

describe('elapsedMinutes / isOverdue / formatElapsed', () => {
  it('placed_at から now までを、分（切り捨て）で数える', () => {
    expect(elapsedMinutes('2026-11-21T03:00:00Z', NOW)).toBe(5);
    expect(elapsedMinutes('2026-11-21T03:00:01Z', NOW)).toBe(4);
    expect(elapsedMinutes('2026-11-21T03:00:00Z', Date.parse(NOW))).toBe(5);
    expect(elapsedMinutes('2026-11-21T03:00:00Z', new Date(NOW))).toBe(5);
  });

  it('時計のずれで未来の注文になったら 0 分。読めない日時は null', () => {
    expect(elapsedMinutes('2026-11-21T03:30:00Z', NOW)).toBe(0);
    expect(elapsedMinutes('壊れた日時', NOW)).toBeNull();
    expect(elapsedMinutes('2026-11-21T03:00:00Z', 'x')).toBeNull();
  });

  it('10 分ちょうどは強調しない。10 分を超えたら強調する', () => {
    expect(isOverdue(10)).toBe(false);
    expect(isOverdue(11)).toBe(true);
    expect(isOverdue(0)).toBe(false);
    expect(isOverdue(null)).toBe(false);
    // 10 分 59 秒は 10 分（切り捨て）。11 分ちょうどで超える
    expect(isOverdue(elapsedMinutes('2026-11-21T03:00:00Z', '2026-11-21T03:10:59Z'))).toBe(false);
    expect(isOverdue(elapsedMinutes('2026-11-21T03:00:00Z', '2026-11-21T03:11:00Z'))).toBe(true);
  });

  it('経過時間の文', () => {
    expect(formatElapsed(0)).toBe('1 分未満');
    expect(formatElapsed(7)).toBe('7 分');
    expect(formatElapsed(60)).toBe('1 時間');
    expect(formatElapsed(75)).toBe('1 時間 15 分');
    expect(formatElapsed(null)).toBe('経過時間を計算できません');
  });
});

describe('actionButtons（allowed_actions → ボタン）', () => {
  it('進める操作を先に、取消しを最後に。ラベルは画面の文', () => {
    expect(actionButtons(['cancel', 'accept'])).toEqual([
      { action: 'accept', label: '受ける', variant: 'primary' },
      { action: 'cancel', label: '取消し', variant: 'danger' },
    ]);
    expect(actionButtons(['start']).map((b) => b.label)).toEqual(['調理開始']);
    expect(actionButtons(['ready']).map((b) => b.label)).toEqual(['準備完了']);
    expect(actionButtons(['complete']).map((b) => b.label)).toEqual(['渡した']);
  });

  it('API が許していない操作・知らない操作は出さない。重複は 1 つ', () => {
    expect(actionButtons([])).toEqual([]);
    expect(actionButtons(['refund', 'delete', 'accept', 'accept']).map((b) => b.action)).toEqual(['accept']);
  });
});

describe('groupByStatus（列への振り分け）', () => {
  it('状態ごとに分け、API の順（古い順）を保つ', () => {
    const g = groupByStatus([
      order({ public_id: 'A0000001', status: 'ready' }),
      order({ public_id: 'A0000002', status: 'paid' }),
      order({ public_id: 'A0000003', status: 'paid' }),
      order({ public_id: 'A0000004', status: 'preparing' }),
      order({ public_id: 'A0000005', status: 'accepted' }),
    ]);
    expect(g.paid.map((o) => o.public_id)).toEqual(['A0000002', 'A0000003']);
    expect(g.accepted.map((o) => o.public_id)).toEqual(['A0000005']);
    expect(g.preparing.map((o) => o.public_id)).toEqual(['A0000004']);
    expect(g.ready.map((o) => o.public_id)).toEqual(['A0000001']);
  });

  it('ボードに無い状態（placed・completed・cancelled）は捨てる', () => {
    const g = groupByStatus([order({ status: 'placed' }), order({ status: 'completed' }), order({ status: 'cancelled' })]);
    expect(Object.values(g).flat()).toHaveLength(0);
  });
});

describe('表示用の文', () => {
  it('サイズと温度。フードの "-" は出さない', () => {
    expect(itemSpec({ size: 'M', temperature: 'hot' })).toBe('M・ホット');
    expect(itemSpec({ size: 'L', temperature: 'ice' })).toBe('L・アイス');
    expect(itemSpec({ size: '-', temperature: '-' })).toBe('');
    expect(itemSpec({ size: 'S', temperature: '-' })).toBe('S');
  });

  it('店名。全店の店長は「全店」、一覧が読めなければ「自店」', () => {
    const stores = [{ id: 1, name: '居住区本店' }];
    expect(storeLabel({ store_id: 1 }, stores)).toBe('居住区本店');
    expect(storeLabel({ store_id: null }, stores)).toBe('全店');
    expect(storeLabel({ store_id: 9 }, stores)).toBe('自店');
    expect(storeLabel({ store_id: 1 }, null)).toBe('自店');
  });

  it('?store= は、正の整数だけ受ける', () => {
    expect(parseStoreParam('3')).toBe(3);
    expect(parseStoreParam(['4', '5'])).toBe(4);
    for (const bad of [undefined, '', '0', '-1', '1e3', '3; drop', 'abc', '12345678901']) expect(parseStoreParam(bad)).toBeNull();
  });
});
