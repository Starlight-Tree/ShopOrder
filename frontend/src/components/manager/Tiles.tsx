import { count, lumi } from '../../lib/manager/series';
import type { Overview } from '../../lib/manager/types';

const CLOSED_TEXT: Record<string, string> = { temporary_closure: '臨時休業', weekly_closed: '定休日' };

function yesterdayText(y: Overview['yesterday'], kind: 'sales' | 'orders' | 'ticket'): string {
  if (y.state === 'closed') return '昨日: 休業';
  if (y.state !== 'open') return '昨日: 未集計';
  return `昨日: ${kind === 'sales' ? lumi(y.sales_lumi) : kind === 'orders' ? count(y.orders, ' 件') : lumi(y.avg_ticket_lumi)}`;
}

/** 今日の概況: 売上・注文数・客単価・対応中の注文（タイル 4 つ）。当日は元データから都度。売上 = 取消し・未完了を除く（docs/metrics.md） */
export function Tiles({ overview }: { overview: Overview }) {
  const closed = overview.store_count === 1 && overview.open_stores === 0;
  return (
    <section aria-label="今日の概況">
      {closed ? (
        <p className="mg-closed" role="status">
          本日は休業日です（{CLOSED_TEXT[overview.closed_reason ?? ''] ?? '休業'}）。
        </p>
      ) : null}
      <ul className="mg-tiles">
        <li className="mg-tile">
          <p className="mg-tile-label">今日の売上</p>
          <p className="mg-tile-value">{lumi(overview.sales_lumi)}</p>
          <p className="mg-tile-sub">{yesterdayText(overview.yesterday, 'sales')}</p>
        </li>
        <li className="mg-tile">
          <p className="mg-tile-label">注文数</p>
          <p className="mg-tile-value">{count(overview.orders, ' 件')}</p>
          <p className="mg-tile-sub">{yesterdayText(overview.yesterday, 'orders')}</p>
        </li>
        <li className="mg-tile">
          <p className="mg-tile-label">客単価</p>
          <p className="mg-tile-value">{lumi(overview.avg_ticket_lumi)}</p>
          <p className="mg-tile-sub">{overview.orders === 0 ? '注文がまだありません' : yesterdayText(overview.yesterday, 'ticket')}</p>
        </li>
        <li className="mg-tile">
          <p className="mg-tile-label">対応中の注文</p>
          <p className="mg-tile-value">{count(overview.in_progress, ' 件')}</p>
          <p className="mg-tile-sub">受付〜準備完了（宅配は後の段階）</p>
        </li>
      </ul>
      <p className="mg-note">
        {overview.business_date} の営業日。売上は受け取り済みの注文だけ（取消し・進行中は入りません）。
        {overview.scope.all_stores ? `全 ${overview.store_count} 店のうち ${overview.open_stores} 店が営業日です。` : ''}
      </p>
    </section>
  );
}
