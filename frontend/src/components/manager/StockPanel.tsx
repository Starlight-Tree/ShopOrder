'use client';
import { count, coverText, gapText, pct, sortByCover, stockBars } from '../../lib/manager/series';
import type { Stock } from '../../lib/manager/types';
import { ChartCard } from './ChartCard';
import { HorizontalBars } from './LazyCharts';

const REASONS = [
  ['expired', '期限切れ'],
  ['damaged', '破損'],
  ['quality', '品質'],
  ['other', 'その他'],
] as const;

/** 在庫: 残日数の少ない品（横棒 + 表）、発注点との差、廃棄の量と理由（表 + 横棒）。残量は今の残高（当日を含む）、消費は直近 14 営業日の平均、廃棄は直近 30 日 */
export function StockPanel({ stock }: { stock: Stock }) {
  const allStores = stock.scope.all_stores;
  const items = sortByCover(stock.items);
  const low = stock.items.filter((i) => i.low).length;
  const bars = stockBars(stock.items, 10).map((b) => ({ name: b.name, value: b.days, alert: b.low }));
  const wasteBars = stock.waste.slice(0, 10).map((w) => ({ name: w.name, value: w.waste_rate_pct }));
  return (
    <div>
      <ul className="mg-facts">
        <li>
          <span className="mg-fact-label">発注点を下回る品</span>
          <strong className={low ? 'mg-alert-text' : undefined}>{low} 品</strong>
        </li>
        <li>
          <span className="mg-fact-label">品目</span>
          <strong>{stock.items.length} 品</strong>
        </li>
      </ul>
      <ChartCard
        title="在庫の残日数"
        summary={`残日数が少ない順に上位 10 品（${allStores ? '全店で最も厳しい店の値' : stock.scope.store_name ?? ''}）。赤い棒は、発注点を下回っています（名前にも「発注点割れ」と書きます）。`}
        chart={bars.length ? <HorizontalBars rows={bars} unit=" 日" valueName="残日数" /> : <p className="mg-empty">消費の記録がまだありません。</p>}
        table={
          <table className="mg-table">
            <caption className="sr-only">在庫の残日数と発注点との差</caption>
            <thead>
              <tr>
                <th scope="col">品目</th>
                <th scope="col" className="num">
                  残量
                </th>
                <th scope="col" className="num">
                  1 日の消費
                </th>
                <th scope="col" className="num">
                  残日数
                </th>
                <th scope="col" className="num">
                  発注点との差
                </th>
                {allStores ? (
                  <th scope="col" className="num">
                    発注点割れの店
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.item_id} className={i.low ? 'is-low' : undefined}>
                  <th scope="row">
                    {i.name}
                    {i.low ? <span className="mg-tag-low">発注点割れ</span> : null}
                  </th>
                  <td className="num" data-label="残量">
                    {count(i.on_hand)} {i.unit}
                  </td>
                  <td className="num" data-label="1 日の消費">
                    {i.avg_daily_use.toLocaleString('ja-JP')} {i.unit}
                  </td>
                  <td className="num" data-label="残日数">
                    {coverText(i)}
                  </td>
                  <td className="num" data-label="発注点との差">
                    {gapText(i)}
                  </td>
                  {allStores ? (
                    <td className="num" data-label="発注点割れの店">
                      {i.low_stores} / {i.store_count} 店
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        }
        note={`残日数 = (残量 − 確保中) ÷ 1 日の消費（${stock.use_from}〜${stock.use_to} の営業日の平均）。発注点との差 = 出せる量（残量 − 確保中 − 安全在庫）− 発注点。全店のときは、最も厳しい店の値。原価率は、原価の列が無いので、まだ出しません。`}
      />
      <ChartCard
        title="廃棄の量と理由"
        summary={`${stock.waste_from} 〜 ${stock.waste_to}。廃棄の率 = 廃棄 ÷ (消費 + 廃棄)。理由は台帳の記述を、固定の区分（期限切れ・破損・品質・その他）に写したものです。`}
        chart={wasteBars.length ? <HorizontalBars rows={wasteBars} unit="%" valueName="廃棄の率" /> : <p className="mg-empty">この期間の廃棄はありません。</p>}
        table={
          stock.waste.length ? (
            <table className="mg-table">
              <caption className="sr-only">廃棄の量と理由</caption>
              <thead>
                <tr>
                  <th scope="col">品目</th>
                  <th scope="col" className="num">
                    廃棄の量
                  </th>
                  <th scope="col" className="num">
                    廃棄の率
                  </th>
                  {REASONS.map(([, label]) => (
                    <th key={label} scope="col" className="num">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stock.waste.map((w) => (
                  <tr key={w.item_id}>
                    <th scope="row">{w.name}</th>
                    <td className="num" data-label="廃棄の量">
                      {count(w.total)} {w.unit}
                    </td>
                    <td className="num" data-label="廃棄の率">
                      {pct(w.waste_rate_pct)}
                    </td>
                    {REASONS.map(([key, label]) => (
                      <td key={key} className="num" data-label={label}>
                        {count(w.by_reason[key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mg-empty">この期間の廃棄はありません。</p>
          )
        }
      />
    </div>
  );
}
