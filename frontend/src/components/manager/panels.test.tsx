import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { customers, hourly, overview, products, sales, stock } from '../../lib/manager/test-fixtures';
import { ChartCard } from './ChartCard';
import { CustomersPanel } from './CustomersPanel';
import { HourlyHeatmap } from './HourlyHeatmap';
import { ProductsPanel } from './ProductsPanel';
import { SalesPanel } from './SalesPanel';
import { StockPanel } from './StockPanel';
import { Tiles } from './Tiles';

// Recharts は、動的 import の先（jsdom では描かない）。差し替えた部品は、渡された行の数だけを出す
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  return {
    default: () => (props: { rows?: unknown[] }) => React.createElement('div', { 'data-testid': 'lazy-chart', 'data-rows': String(props.rows?.length ?? 0) }),
  };
});

const switchToTable = () => fireEvent.click(screen.getByRole('button', { name: '表で見る' }));

describe('ChartCard（グラフ / 表で見る）', () => {
  it('最初はグラフ。「表で見る」で表に変わり、押した側に aria-pressed', () => {
    render(<ChartCard title="売上" chart={<div>グラフ本体</div>} table={<table><tbody><tr><td>表の数字</td></tr></tbody></table>} />);
    expect(screen.getByText('グラフ本体')).toBeInTheDocument();
    expect(screen.queryByText('表の数字')).toBeNull();
    expect(screen.getByRole('button', { name: 'グラフ' })).toHaveAttribute('aria-pressed', 'true');
    switchToTable();
    expect(screen.getByText('表の数字')).toBeInTheDocument();
    expect(screen.queryByText('グラフ本体')).toBeNull(); // 表のときは、グラフの部品を出さない（読み込まない）
    expect(screen.getByRole('button', { name: '表で見る' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }));
    expect(screen.getByText('グラフ本体')).toBeInTheDocument();
  });
});

describe('Tiles（今日の概況）', () => {
  it('タイル 4 つ: 売上・注文数・客単価・対応中の注文。昨日の値を添える', () => {
    render(<Tiles overview={overview()} />);
    const tiles = screen.getAllByRole('listitem');
    expect(tiles).toHaveLength(4);
    expect(within(tiles[0]!).getByText('15,550 ルミ')).toBeInTheDocument();
    expect(within(tiles[0]!).getByText('昨日: 26,640 ルミ')).toBeInTheDocument();
    expect(within(tiles[1]!).getByText('18 件')).toBeInTheDocument();
    expect(within(tiles[2]!).getByText('864 ルミ')).toBeInTheDocument();
    expect(within(tiles[3]!).getByText('3 件')).toBeInTheDocument();
  });
  it('注文がまだ無い日は、客単価が「—」。昨日が休業・未集計なら、その文字（0 と区別する）', () => {
    render(<Tiles overview={overview({ orders: 0, sales_lumi: 0, avg_ticket_lumi: null, yesterday: { business_date: '2026-11-20', state: 'closed', sales_lumi: null, orders: null, avg_ticket_lumi: null } })} />);
    const tiles = screen.getAllByRole('listitem');
    expect(within(tiles[2]!).getByText('—')).toBeInTheDocument();
    expect(within(tiles[0]!).getByText('0 ルミ')).toBeInTheDocument();
    expect(within(tiles[0]!).getByText('昨日: 休業')).toBeInTheDocument();
  });
  it('1 店の画面で、今日が休業なら、その旨と理由を出す', () => {
    render(<Tiles overview={overview({ scope: { all_stores: false, store_id: 4, store_name: '岩山展望店' }, open_stores: 0, store_count: 1, closed_reason: 'temporary_closure', sales_lumi: 0, orders: 0, avg_ticket_lumi: null })} />);
    expect(screen.getByRole('status')).toHaveTextContent('本日は休業日です（臨時休業）');
  });
});

describe('SalesPanel（売上の推移）', () => {
  it('グラフには、整形した行（移動平均つき）を渡す', () => {
    render(<SalesPanel series={sales()} />);
    expect(screen.getByTestId('lazy-chart')).toHaveAttribute('data-rows', '5');
  });
  it('表で見ると、休業・売上 0・未集計が別の文字。営業日の数も出る', () => {
    render(<SalesPanel series={sales()} />);
    switchToTable();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('1,000 ルミ')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('11/15（日）')).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute('data-state', 'closed');
    expect(within(rows[1]!).getAllByText('休業').length).toBeGreaterThan(0);
    expect(within(rows[2]!).getByText('0 ルミ')).toBeInTheDocument(); // 営業したが売上 0
    expect(within(rows[3]!).getByText('未集計')).toBeInTheDocument();
  });
  it('前期比: 比べられるときは割合、比べられないときは「比較不可」と理由', () => {
    const { unmount } = render(<SalesPanel series={sales()} />);
    expect(screen.getByText('+11.1%', { selector: 'strong' })).toBeInTheDocument();
    unmount();
    render(<SalesPanel series={sales({ comparison: { state: 'not_comparable', previous_sales_lumi: null, change_pct: null, reason: 'open_days_mismatch', message: 'x' } })} />);
    expect(screen.getByText('比較不可', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/営業日の数が前の期間と違う（休業があった）ため、比べられません/)).toBeInTheDocument();
  });
  it('週のときは、見出しと移動平均の名前が週ごと', () => {
    render(<SalesPanel series={sales({ grain: 'week', points: [{ start: '2026-11-09', sales_lumi: 5000, orders: 9, open_days: 7, state: 'open' }] })} />);
    switchToTable();
    expect(screen.getByText('11/9 の週')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '移動平均（4 週）' })).toBeInTheDocument();
  });
});

describe('ProductsPanel（商品別・ABC）', () => {
  it('グラフは上位の品の行。表は全品で、ABC・構成比・累積を持つ', () => {
    render(<ProductsPanel products={products()} />);
    expect(screen.getByTestId('lazy-chart')).toHaveAttribute('data-rows', '3');
    switchToTable();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('オアシスブレンド')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('77.4%', { selector: '[data-label="構成比"]' })).toBeInTheDocument();
    expect(within(rows[2]!).getByText('B')).toBeInTheDocument();
    expect(screen.getByText('32 杯')).toBeInTheDocument(); // 杯数
    expect(screen.getByText('2 / 1 / 0')).toBeInTheDocument(); // A / B / C の品数
  });
  it('売上が無い期間は、空の文', () => {
    render(<ProductsPanel products={{ ...products(), items: [], totals: { sales_lumi: 0, qty: 0, cups: 0 } }} />);
    expect(screen.getByText('この期間の売上はありません。')).toBeInTheDocument();
  });
});

describe('HourlyHeatmap（曜日 × 時間帯）', () => {
  it('HTML の表。セルに数字と色の段階（0〜5）。最大のセルが 5、注文なしが 0', () => {
    render(<HourlyHeatmap hourly={hourly()} />);
    const table = screen.getByTestId('heatmap');
    const cells = within(table).getAllByRole('cell');
    expect(cells).toHaveLength(21); // 3 時間帯 × 7 曜日
    expect(cells[0]).toHaveTextContent('20');
    expect(cells[0]).toHaveAttribute('data-level', '5');
    expect(cells[0]).toHaveClass('mg-heat-5');
    expect(cells[1]).toHaveAttribute('data-level', '0'); // 火 8 時: 注文なし
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['時間帯', '月', '火', '水', '木', '金', '土', '日']);
  });
  it('「表で見る」は、色なしの表（合計つき）', () => {
    render(<HourlyHeatmap hourly={hourly()} />);
    switchToTable();
    const plain = screen.getByTestId('heat-plain');
    expect(plain.querySelector('.mg-heat')).toBeNull();
    expect(within(plain).getByText('計 36')).toBeInTheDocument();
  });
  it('注文のない期間は、空の文', () => {
    render(<HourlyHeatmap hourly={{ ...hourly(), hours: [], cells: [], max_orders: 0 }} />);
    expect(screen.getByText('この期間の注文はありません。')).toBeInTheDocument();
  });
});

describe('StockPanel（在庫）', () => {
  it('残日数の少ない順の表。発注点割れは文字でも示し、残日数なしは「消費なし」', () => {
    render(<StockPanel stock={stock()} />);
    expect(screen.getAllByTestId('lazy-chart')[0]).toHaveAttribute('data-rows', '2'); // 残日数のある品だけ
    fireEvent.click(screen.getAllByRole('button', { name: '表で見る' })[0]!);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('牛乳')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('発注点割れ')).toBeInTheDocument();
    expect(rows[0]).toHaveClass('is-low');
    expect(within(rows[0]!).getByText('900 ml 足りない')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('8.4 日')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('消費なし')).toBeInTheDocument();
    expect(screen.getByText('1 品', { selector: 'strong.mg-alert-text' })).toBeInTheDocument();
  });
  it('廃棄: 量・率・理由別', () => {
    render(<StockPanel stock={stock()} />);
    fireEvent.click(screen.getAllByRole('button', { name: '表で見る' })[1]!);
    const row = screen.getAllByRole('row').find((r) => r.textContent?.includes('1,200 ml'))!;
    expect(within(row).getByText('3.5%')).toBeInTheDocument();
    expect(row.textContent).toContain('800');
    expect(screen.getByRole('columnheader', { name: '期限切れ' })).toBeInTheDocument();
  });
  it('全店のときは、発注点割れの店の数の列が出る', () => {
    render(<StockPanel stock={stock({ scope: { all_stores: true, store_id: null, store_name: null } })} />);
    fireEvent.click(screen.getAllByRole('button', { name: '表で見る' })[0]!);
    expect(screen.getByRole('columnheader', { name: '発注点割れの店' })).toBeInTheDocument();
  });
});

describe('CustomersPanel（顧客）', () => {
  it('区分の人数・再購入率・利用額の目安・離れかけ', () => {
    render(<CustomersPanel customers={customers()} />);
    expect(screen.getByText('117 人')).toBeInTheDocument();
    expect(screen.getByText('87.2%')).toBeInTheDocument();
    expect(screen.getByText('13,000 ルミ')).toBeInTheDocument();
    expect(screen.getByText('17 人', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByTestId('lazy-chart')).toHaveAttribute('data-rows', '5');
  });
  it('5 人未満のセルは「5 人未満」。隠したセルがあれば、顧客の数（合計）も出さない', () => {
    const c = customers({ total_customers: null, repurchase_rate_pct: null, avg_spend_lumi: null });
    c.segments[4] = { segment: 'dormant', label: '休眠', customers: null, suppressed: true };
    c.grid[0] = { r: 3, f: 1, customers: null, suppressed: true };
    render(<CustomersPanel customers={c} />);
    expect(screen.getByText(/5 人未満のセルがあるため非表示/)).toBeInTheDocument();
    switchToTable();
    expect(screen.getByText('休眠').closest('tr')).toHaveTextContent('5 人未満');
    expect(within(screen.getByTestId('rfm-grid')).getAllByText('5 人未満').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0); // 再購入率・利用額の目安も出さない
  });
  it('コホートは HTML の表。割合と人数、隠したセル、当月は途中、最初の月の注記', () => {
    render(<CustomersPanel customers={customers()} />);
    const cohort = screen.getByTestId('cohort');
    expect(within(cohort).getByText(/83\.3%（20 人）/)).toBeInTheDocument();
    expect(within(cohort).getAllByText('5 人未満')).toHaveLength(2); // 2026-09 の +2 か月と、2026-11 の人数
    expect(within(cohort).getByText('（途中）')).toBeInTheDocument();
    expect(within(cohort).getByText(/データの開始前から来ていた人を含みます/)).toBeInTheDocument();
    expect(screen.getByText(/注文の履行・配達の連絡・購買履歴の分析による商品提案と店の改善/)).toBeInTheDocument();
  });
});
