'use client';
import { abcCount, ABC_LABELS, CATEGORY_LABELS, count, lumi, pct, productBars } from '../../lib/manager/series';
import type { Products } from '../../lib/manager/types';
import { ChartCard } from './ChartCard';
import { HorizontalBars } from './LazyCharts';

/** 商品別: 売上の横棒（上位 10 品）と、全品の表（売上・個数・構成比・累積・ABC）。ABC は売上の累積 80% / 95%（docs/metrics.md） */
export function ProductsPanel({ products }: { products: Products }) {
  const bars = productBars(products.items, 10).map((b) => ({ name: b.name, value: b.sales }));
  const byClass = abcCount(products.items);
  return (
    <div>
      <ul className="mg-facts">
        <li>
          <span className="mg-fact-label">売上</span>
          <strong>{lumi(products.totals.sales_lumi)}</strong>
        </li>
        <li>
          <span className="mg-fact-label">杯数（ドリンク）</span>
          <strong>{count(products.totals.cups, ' 杯')}</strong>
        </li>
        <li>
          <span className="mg-fact-label">A / B / C の品数</span>
          <strong>
            {byClass.A} / {byClass.B} / {byClass.C}
          </strong>
        </li>
      </ul>
      <ChartCard
        title="商品別の売上"
        summary={`${products.from} 〜 ${products.to}（${products.days} 日）。上位 10 品。名前の（A）（B）（C）は、売上の累積による区分です。`}
        chart={products.items.length ? <HorizontalBars rows={bars} unit=" ルミ" valueName="売上" /> : <p className="mg-empty">この期間の売上はありません。</p>}
        table={
          <table className="mg-table">
            <caption className="sr-only">商品別の売上と ABC</caption>
            <thead>
              <tr>
                <th scope="col">品目</th>
                <th scope="col">区分</th>
                <th scope="col" className="num">
                  個数
                </th>
                <th scope="col" className="num">
                  売上
                </th>
                <th scope="col" className="num">
                  構成比
                </th>
                <th scope="col" className="num">
                  累積
                </th>
                <th scope="col">ABC</th>
              </tr>
            </thead>
            <tbody>
              {products.items.map((i) => (
                <tr key={i.item_id}>
                  <th scope="row">{i.name}</th>
                  <td data-label="区分">{CATEGORY_LABELS[i.category]}</td>
                  <td className="num" data-label="個数">
                    {count(i.qty)}
                  </td>
                  <td className="num" data-label="売上">
                    {lumi(i.sales_lumi)}
                  </td>
                  <td className="num" data-label="構成比">
                    {pct(i.share_pct)}
                  </td>
                  <td className="num" data-label="累積">
                    {pct(i.cum_share_pct)}
                  </td>
                  <td data-label="ABC">
                    <span className={`mg-abc mg-abc-${i.abc}`}>{i.abc}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        note={`${ABC_LABELS.A}・${ABC_LABELS.B}・${ABC_LABELS.C}。売上の大きい順に並べ、その品の手前までの累積が 80% 未満なら A、95% 未満なら B。`}
      />
    </div>
  );
}
