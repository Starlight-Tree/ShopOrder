import { formatLumi } from '../../lib/format';
import { feeText } from '../../lib/shop/delivery-view';

/**
 * 金額の内訳: 小計・送料・合計。店頭は送料が 0 のとき送料の行を出さない。宅配は、送料の行をいつも出す（0 は「無料」）。
 * compact は、合計だけ出す（店頭の確認カード）
 */
export function Totals({ subtotalLumi, feeLumi, totalLumi, delivery = false, compact = false }: { subtotalLumi: number; feeLumi: number; totalLumi: number; delivery?: boolean; compact?: boolean }) {
  return (
    <dl className="shop-totals">
      {compact ? null : (
        <div>
          <dt>小計</dt>
          <dd>{formatLumi(subtotalLumi)}</dd>
        </div>
      )}
      {!compact && (delivery || feeLumi > 0) ? (
        <div>
          <dt>送料</dt>
          <dd>{feeText(feeLumi)}</dd>
        </div>
      ) : null}
      <div className="shop-total-row">
        <dt>合計</dt>
        <dd>{formatLumi(totalLumi)}</dd>
      </div>
    </dl>
  );
}
