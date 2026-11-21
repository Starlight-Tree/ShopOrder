import Link from 'next/link';
import type { OrderSummary } from '../../lib/contract';
import { formatLumi } from '../../lib/format';
import { formatDateTime } from '../../lib/shop/format';
import { pickupNoLabel } from '../../lib/shop/delivery-labels';
import { statusLabel } from '../../lib/shop/order-steps';

/** 注文履歴（新しい順。50 件まで） */
export function OrderList({ orders }: { orders: OrderSummary[] }) {
  if (orders.length === 0) {
    return (
      <div className="notice">
        <p>まだ注文がありません。</p>
        <p>
          <Link href="/" className="shop-btn shop-btn-primary">
            メニューを見る
          </Link>
        </p>
      </div>
    );
  }
  return (
    <ul className="shop-order-list">
      {orders.map((o) => (
        <li key={o.public_id} className="card">
          <Link href={`/orders/${encodeURIComponent(o.public_id)}`} className="shop-order-link">
            <span className="shop-order-no">
              <span className="muted">{pickupNoLabel(o.fulfillment)}</span>
              <strong>{o.pickup_no}</strong>
            </span>
            <span className="shop-order-meta">
              <span className="card-title">
                {o.store.name}
                {o.fulfillment === 'delivery' ? <span className="tag shop-tag-delivery">宅配</span> : null}
              </span>
              <span className="muted">{formatDateTime(o.placed_at)}</span>
              <span className="price">{formatLumi(o.total_lumi)}</span>
            </span>
            <span className={`shop-status-badge shop-status-${o.status}`}>{statusLabel(o.status, o.fulfillment)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
