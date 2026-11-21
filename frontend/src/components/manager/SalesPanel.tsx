'use client';
import { comparisonText, count, lumi, pct, salesCell, STATE_LABELS, toSalesRows } from '../../lib/manager/series';
import type { Grain, SalesSeries } from '../../lib/manager/types';
import { ChartCard } from './ChartCard';
import { SalesLineChart } from './LazyCharts';

const WINDOW: Record<Grain, number> = { day: 7, week: 4, month: 3 };
const AVG_LABEL: Record<Grain, string> = { day: '移動平均（7 日）', week: '移動平均（4 週）', month: '移動平均（3 か月）' };
const GRAIN_LABEL: Record<Grain, string> = { day: '日', week: '週', month: '月' };

/** 売上の推移: 折れ線（日々 + 移動平均）と、同じ数字の表。休業（—）と売上 0 と未集計を区別する。前期比は、比べられるときだけ */
export function SalesPanel({ series }: { series: SalesSeries }) {
  const rows = toSalesRows(series.points, series.grain, WINDOW[series.grain]);
  const cmp = comparisonText(series.comparison);
  const unbuilt = rows.filter((r) => r.state === 'not_built' || r.state === 'partial').length;
  const closed = rows.filter((r) => r.state === 'closed').length;
  return (
    <div>
      <ul className="mg-facts">
        <li>
          <span className="mg-fact-label">期間の売上</span>
          <strong>{lumi(series.total.sales_lumi)}</strong>
        </li>
        <li>
          <span className="mg-fact-label">注文数</span>
          <strong>{count(series.total.orders, ' 件')}</strong>
        </li>
        <li>
          <span className="mg-fact-label">前期比</span>
          <strong className={cmp.ok ? undefined : 'mg-muted'}>{cmp.ok ? pct(series.comparison.state === 'ok' ? series.comparison.change_pct : null, true) : '比較不可'}</strong>
        </li>
      </ul>
      <p className="mg-compare" data-comparable={cmp.ok}>
        {cmp.text}
      </p>
      <ChartCard
        title={`売上の推移（${GRAIN_LABEL[series.grain]}ごと）`}
        summary={`${series.from} 〜 ${series.to}。休業の日は線が途切れます（0 ではありません）。同じ数字を「表で見る」で確かめられます。`}
        chart={<SalesLineChart rows={rows} averageLabel={AVG_LABEL[series.grain]} />}
        table={
          <table className="mg-table">
            <caption className="sr-only">売上の推移（{GRAIN_LABEL[series.grain]}ごと）</caption>
            <thead>
              <tr>
                <th scope="col">期間</th>
                <th scope="col" className="num">
                  売上
                </th>
                <th scope="col" className="num">
                  {AVG_LABEL[series.grain]}
                </th>
                <th scope="col" className="num">
                  注文数
                </th>
                <th scope="col" className="num">
                  営業日
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-state={r.state}>
                  <th scope="row">{r.label}</th>
                  <td className="num" data-label="売上">
                    {salesCell(r)}
                  </td>
                  <td className="num" data-label={AVG_LABEL[series.grain]}>
                    {lumi(r.average)}
                  </td>
                  <td className="num" data-label="注文数">
                    {count(r.orders)}
                  </td>
                  <td className="num" data-label="営業日">
                    {r.state === 'closed' ? STATE_LABELS.closed : count(r.openDays)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        note={
          <>
            売上 = 受け取り済み（completed）の注文の合計。移動平均は営業日だけで平均します。
            {closed > 0 ? ` 休業は ${closed} 点（—）。` : ''}
            {unbuilt > 0 ? ` 未集計は ${unbuilt} 点。` : ''}
          </>
        }
      />
    </div>
  );
}
