import { describe, expect, it } from 'vitest';
import {
  abcCount,
  axisLabel,
  buildHeatmap,
  cohortTable,
  comparisonText,
  coverText,
  gapText,
  gridTable,
  heatLevel,
  lumi,
  movingAverage,
  peopleText,
  pct,
  pointLabel,
  productBars,
  salesCell,
  segmentBars,
  sortByCover,
  stockBars,
  toSalesRows,
} from './series';
import { customers, hourly, products, sales, stockItem } from './test-fixtures';

describe('金額・割合の表示', () => {
  it('null は「—」。0 は「0 ルミ」（休業・未集計と区別する）', () => {
    expect(lumi(null)).toBe('—');
    expect(lumi(0)).toBe('0 ルミ');
    expect(lumi(12150)).toBe('12,150 ルミ');
  });
  it('割合は小数 1 位。符号つきは + と −', () => {
    expect(pct(11.14)).toBe('11.1%');
    expect(pct(11.1, true)).toBe('+11.1%');
    expect(pct(-3.2, true)).toBe('−3.2%');
    expect(pct(0, true)).toBe('0.0%');
    expect(pct(null)).toBe('—');
  });
});

describe('移動平均', () => {
  it('直近 window 点の、値のある点だけの平均（休業・未集計の null を 0 として混ぜない）', () => {
    expect(movingAverage([100, 200, 300, 400], 3)).toEqual([null, null, 200, 300]); // 3 点そろうまでは null
    expect(movingAverage([100, null, 300, 500], 3, 2)).toEqual([null, null, 200, 400]); // null を飛ばして平均（0 として混ぜない。値が 2 点そろうまでは null）
  });
  it('0 は値（営業したが売上 0）。平均に入る', () => {
    expect(movingAverage([0, 0, 300], 3)).toEqual([null, null, 100]);
  });
  it('窓より短い系列は、値が足りるまで null', () => {
    expect(movingAverage([100, 200], 7)).toEqual([null, null]);
    expect(movingAverage([], 7)).toEqual([]);
  });
  it('窓の外の古い点は、平均に入らない', () => {
    expect(movingAverage([1000, 100, 100, 100], 3)).toEqual([null, null, 400, 100]);
  });
});

describe('日付の見出し', () => {
  it('日・週・月で形が違う（曜日つき）', () => {
    expect(pointLabel('2026-11-20', 'day')).toBe('11/20（金）');
    expect(pointLabel('2026-11-16', 'week')).toBe('11/16 の週');
    expect(pointLabel('2026-10-01', 'month')).toBe('2026 年 10 月');
    expect(axisLabel('2026-11-20', 'day')).toBe('11/20');
    expect(axisLabel('2026-10-01', 'month')).toBe('10月');
  });
});

describe('売上の行', () => {
  const rows = toSalesRows(sales().points, 'day', 3, 2);
  it('休業・売上 0・未集計を、別の文字にする', () => {
    expect(rows.map(salesCell)).toEqual(['1,000 ルミ', '休業', '0 ルミ', '未集計', '2,000 ルミ']);
  });
  it('移動平均は営業日だけで計算する（休業・未集計を飛ばす）', () => {
    expect(rows.map((r) => r.average)).toEqual([null, null, 500, null, 1000]); // 窓 3 点のうち値が 2 点以上のとき。{1000, —, 0} → 500（— は飛ばす）、{0, —, 2000} → 1000
  });
  it('見出しと営業日の数を持つ', () => {
    expect(rows[1]).toMatchObject({ key: '2026-11-15', label: '11/15（日）', axis: '11/15', state: 'closed', openDays: 0 });
  });
});

describe('前期比の文', () => {
  it('比べられるときは、符号つきの割合と前の期間の売上', () => {
    expect(comparisonText(sales().comparison)).toEqual({ ok: true, text: '前の期間より +11.1%（前の期間: 2,700 ルミ）' });
  });
  it('比べられないときは「比較不可」と理由（API の理由の文を使う）', () => {
    const t = comparisonText({ state: 'not_comparable', previous_sales_lumi: null, change_pct: null, reason: 'weekday_mismatch', message: 'x' });
    expect(t.ok).toBe(false);
    expect(t.text).toBe('比較不可。曜日の構成が前の期間と違うため、比べられません。');
    expect(comparisonText({ state: 'not_comparable', previous_sales_lumi: null, change_pct: null, reason: 'unknown_code', message: 'API の文' }).text).toBe('比較不可。API の文');
  });
});

describe('商品別', () => {
  it('横棒は上位 n 品で、名前に ABC を添える', () => {
    expect(productBars(products().items, 2)).toEqual([
      { name: 'オアシスブレンド（A）', sales: 12150, abc: 'A' },
      { name: 'カフェラテ（A）', sales: 2500, abc: 'A' },
    ]);
  });
  it('A / B / C の品数', () => {
    expect(abcCount(products().items)).toEqual({ A: 2, B: 1, C: 0 });
  });
});

describe('ヒートマップ', () => {
  it('段階: 0 件は 0、最大は 5、1 件以上は少なくとも 1', () => {
    expect(heatLevel(0, 20)).toBe(0);
    expect(heatLevel(20, 20)).toBe(5);
    expect(heatLevel(1, 20)).toBe(1);
    expect(heatLevel(4, 20)).toBe(1);
    expect(heatLevel(5, 20)).toBe(2);
    expect(heatLevel(10, 20)).toBe(3);
    expect(heatLevel(3, 0)).toBe(0);
  });
  it('行 = 時間帯、列 = 月〜日。無いセルは 0 件・段階 0。合計つき', () => {
    const { rows, weekdayTotals, grand } = buildHeatmap(hourly());
    expect(rows.map((r) => r.hour)).toEqual([8, 9, 10]);
    expect(rows[0]!.cells.map((c) => c.orders)).toEqual([20, 0, 0, 0, 10, 0, 0]);
    expect(rows[0]!.cells.map((c) => c.level)).toEqual([5, 0, 0, 0, 3, 0, 0]);
    expect(rows[2]!.cells[6]).toEqual({ weekday: 7, orders: 1, level: 1 });
    expect(weekdayTotals).toEqual([25, 0, 0, 0, 10, 0, 1]);
    expect(grand).toBe(36);
  });
});

describe('在庫', () => {
  const items = [stockItem({ item_id: 1, days_of_cover: 20 }), stockItem({ item_id: 2, name: '牛乳', days_of_cover: 8.4, low: true }), stockItem({ item_id: 3, name: '抹茶', days_of_cover: null })];
  it('残日数の少ない順（残日数なしは最後）', () => {
    expect(sortByCover(items).map((i) => i.item_id)).toEqual([2, 1, 3]);
  });
  it('棒は残日数のある品だけ。発注点割れは名前にも書く', () => {
    expect(stockBars(items, 10)).toEqual([
      { name: '牛乳（発注点割れ）', days: 8.4, low: true },
      { name: 'コーヒー豆', days: 20, low: false },
    ]);
  });
  it('残日数と発注点との差の文', () => {
    expect(coverText({ days_of_cover: null })).toBe('消費なし');
    expect(coverText({ days_of_cover: 8.4 })).toBe('8.4 日');
    expect(gapText({ gap_to_reorder: -900, unit: 'ml' })).toBe('900 ml 足りない');
    expect(gapText({ gap_to_reorder: 3500, unit: 'g' })).toBe('+3,500 g');
    expect(gapText({ gap_to_reorder: null, unit: 'g' })).toBe('—');
  });
});

describe('顧客（5 人未満は出さない）', () => {
  it('人数のセルは、隠されていれば「5 人未満」', () => {
    expect(peopleText({ customers: 20, suppressed: false })).toBe('20 人');
    expect(peopleText({ customers: null, suppressed: true })).toBe('5 人未満');
  });
  it('区分の棒は、隠された区分を値なし・名前に「5 人未満」', () => {
    const c = customers();
    c.segments[3] = { segment: 'at_risk', label: '離れかけ', customers: null, suppressed: true };
    expect(segmentBars(c.segments)[3]).toEqual({ name: '離れかけ（5 人未満）', customers: null, suppressed: true });
    expect(segmentBars(c.segments)[0]).toEqual({ name: '常連', customers: 20, suppressed: false });
  });
  it('R × F の表は 3 行 × 3 列。行は直近の順', () => {
    const g = gridTable(customers().grid);
    expect(g.rows.map((r) => r.label)).toEqual(['直近 14 日以内', '15〜30 日前', '31 日以上前']);
    expect(g.rows[0]!.cells.map((c) => c.text)).toEqual(['31 人', '32 人', '33 人']);
  });
  it('コホート表: 割合と人数、隠したセルは「5 人未満」、当月は途中、最初の月は注記', () => {
    const t = cohortTable(customers().cohorts);
    expect(t.headers).toEqual(['初回月', '+1 か月', '+2 か月']);
    expect(t.rows[0]).toMatchObject({ label: '2026 年 9 月', size: '24 人', note: 'データの開始前から来ていた人を含みます' });
    expect(t.rows[0]!.cells.map((c) => c.text)).toEqual(['100.0%（24 人）', '83.3%（20 人）', '5 人未満']);
    expect(t.rows[0]!.cells[2]).toMatchObject({ suppressed: true, inProgress: true });
    expect(t.rows[1]).toMatchObject({ size: '5 人未満', note: null });
  });
});
