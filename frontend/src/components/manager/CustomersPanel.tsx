'use client';
import { cohortTable, count, gridTable, lumi, pct, peopleText, segmentBars, SUPPRESSED } from '../../lib/manager/series';
import { MGMSG } from '../../lib/manager/messages';
import type { Customers } from '../../lib/manager/types';
import { ChartCard } from './ChartCard';
import { HorizontalBars } from './LazyCharts';

/**
 * 顧客: RFM の分布（横棒 + 表）、R × F の表、再購入率・利用額の目安、コホート（初回月 × 経過月。HTML の表）。
 * 仮名 ID の集計だけ。人数のセルは 5 人未満を出さない（隠したセルがあれば、合計も出さない）。
 */
export function CustomersPanel({ customers }: { customers: Customers }) {
  const bars = segmentBars(customers.segments).map((b) => ({ name: b.name, value: b.customers }));
  const grid = gridTable(customers.grid);
  const cohort = cohortTable(customers.cohorts);
  const withheld = customers.total_customers === null;
  return (
    <div>
      <ul className="mg-facts">
        <li>
          <span className="mg-fact-label">顧客の数</span>
          <strong>{withheld ? SUPPRESSED + 'のセルがあるため非表示' : count(customers.total_customers, ' 人')}</strong>
        </li>
        <li>
          <span className="mg-fact-label">再購入率</span>
          <strong>{pct(customers.repurchase_rate_pct)}</strong>
        </li>
        <li>
          <span className="mg-fact-label">1 人あたりの利用額（目安）</span>
          <strong>{lumi(customers.avg_spend_lumi)}</strong>
        </li>
        <li>
          <span className="mg-fact-label">離れかけの顧客（離脱の兆候）</span>
          <strong>{customers.at_risk_customers === null ? SUPPRESSED : `${customers.at_risk_customers} 人`}</strong>
        </li>
      </ul>
      <ChartCard
        title="RFM の分布（区分ごとの人数）"
        summary={`${customers.as_of ?? ''} 時点。最後の注文の新しさ（R）と、90 日の注文回数（F）で分けた区分です。`}
        chart={<HorizontalBars rows={bars} unit=" 人" valueName="人数" />}
        table={
          <table className="mg-table">
            <caption className="sr-only">RFM の区分ごとの人数</caption>
            <thead>
              <tr>
                <th scope="col">区分</th>
                <th scope="col" className="num">
                  人数
                </th>
              </tr>
            </thead>
            <tbody>
              {customers.segments.map((s) => (
                <tr key={s.segment}>
                  <th scope="row">{s.label}</th>
                  <td className="num" data-label="人数">
                    {peopleText(s)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        note="常連 = 直近 14 日以内で 30 回以上 / 通い = 同 10〜29 回 / ときどき = 同 9 回以下 / 離れかけ = 最後が 15〜30 日前 / 休眠 = 31 日以上前。"
      />
      <section className="mg-card" aria-labelledby="mg-rfm-grid">
        <div className="mg-card-head">
          <h2 id="mg-rfm-grid">R × F の人数</h2>
        </div>
        <table className="mg-table mg-table-compact" data-testid="rfm-grid">
          <caption className="sr-only">最後の注文の新しさ（行）と、注文回数（列）ごとの人数</caption>
          <thead>
            <tr>
              <th scope="col">最後の注文</th>
              {grid.rows[0]?.cells.map((c) => (
                <th key={c.f} scope="col" className="num">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r) => (
              <tr key={r.r}>
                <th scope="row">{r.label}</th>
                {r.cells.map((c) => (
                  <td key={c.f} className={`num${c.suppressed ? ' mg-suppressed' : ''}`} data-label={c.label}>
                    {c.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mg-note">{MGMSG.minCell}</p>
      </section>
      <section className="mg-card" aria-labelledby="mg-cohort">
        <div className="mg-card-head">
          <h2 id="mg-cohort">コホート（初回月 × 経過月）</h2>
        </div>
        <p className="mg-summary">初めて注文した月ごとに、その後の月にも注文した人の割合（人数）。当月は途中です。</p>
        <table className="mg-table" data-testid="cohort">
          <caption className="sr-only">初回月ごとの、経過月ごとの継続の割合</caption>
          <thead>
            <tr>
              <th scope="col">初回月</th>
              <th scope="col" className="num">
                人数
              </th>
              {cohort.headers.map((h, i) =>
                i === 0 ? null : (
                  <th key={h} scope="col" className="num">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {cohort.rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">
                  {r.label}
                  {r.note ? <span className="mg-cohort-note">（{r.note}）</span> : null}
                </th>
                <td className={`num${r.size === SUPPRESSED ? ' mg-suppressed' : ''}`} data-label="人数">
                  {r.size}
                </td>
                {r.cells.slice(1).map((c) => (
                  <td key={c.offset} className={`num${c.suppressed ? ' mg-suppressed' : ''}`} data-label={`+${c.offset} か月`}>
                    {c.text}
                    {c.inProgress ? <span className="mg-progress">（途中）</span> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mg-note">{MGMSG.purpose}</p>
      </section>
    </div>
  );
}
