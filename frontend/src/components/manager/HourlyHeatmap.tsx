'use client';
import { buildHeatmap, count, HEAT_LEVELS, WEEKDAYS } from '../../lib/manager/series';
import type { Hourly } from '../../lib/manager/types';
import { ChartCard } from './ChartCard';

/** 曜日 × 時間帯の注文数。ヒートマップは HTML の表で、セルの色の段階（0〜5）は CSS の変数。数字も必ず書く（色だけに頼らない）。「表で見る」は、色なしの表（合計つき） */
export function HourlyHeatmap({ hourly }: { hourly: Hourly }) {
  const { rows, weekdayTotals, grand } = buildHeatmap(hourly);
  const head = (
    <tr>
      <th scope="col">時間帯</th>
      {WEEKDAYS.map((w) => (
        <th key={w} scope="col" className="num">
          {w}
        </th>
      ))}
    </tr>
  );
  return (
    <ChartCard
      title="曜日 × 時間帯の注文数"
      chartLabel="色で見る"
      summary={`${hourly.from} 〜 ${hourly.to}（${hourly.days} 日）の合計。色が濃いほど注文が多い時間帯です（0〜${HEAT_LEVELS} の 5 段階。最大 ${count(hourly.max_orders, ' 件')}）。`}
      chart={
        rows.length === 0 ? (
          <p className="mg-empty">この期間の注文はありません。</p>
        ) : (
          <table className="mg-table mg-table-compact mg-heat-table" data-testid="heatmap">
            <caption className="sr-only">曜日と時間帯ごとの注文数（色の段階つき）</caption>
            <thead>{head}</thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hour}>
                  <th scope="row">{r.hour}:00</th>
                  {r.cells.map((c) => (
                    <td key={c.weekday} className={`mg-heat mg-heat-${c.level} num`} data-level={c.level} data-label={WEEKDAYS[c.weekday - 1]}>
                      {c.orders}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      table={
        <table className="mg-table mg-table-compact" data-testid="heat-plain">
          <caption className="sr-only">曜日と時間帯ごとの注文数</caption>
          <thead>{head}</thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.hour}>
                <th scope="row">{r.hour}:00</th>
                {r.cells.map((c) => (
                  <td key={c.weekday} className="num" data-label={WEEKDAYS[c.weekday - 1]}>
                    {c.orders}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">計 {count(grand)}</th>
              {weekdayTotals.map((t, i) => (
                <td key={WEEKDAYS[i]} className="num" data-label={WEEKDAYS[i]}>
                  {t}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      }
      note="店の現地時刻の時間帯（受付の時刻）。受け取り済み（completed）の注文だけ。休業日は数えません。"
    />
  );
}
