// 画面の判断（純粋な関数）。どの店が選べるか・どの変種がカートに入れられるか・確認へ進めない理由。
import type { Cart } from '../contract';
import type { MenuItem, Store, Variant } from '../types';
import { formatLumi } from '../format';
import { MAX_ORDER_TOTAL_LUMI } from './constants';
import { describeError } from './errors';
import { closedReasonText, unavailableReasonText, type Category } from './labels';

export type StoreStatus = { selectable: boolean; reason: string | null };

/** 店を選べるか。営業中でなければ、理由つきで選べない。accepting_orders が無い古い応答は、モバイルオーダーの可否だけ見る */
export function storeStatus(store: Store): StoreStatus {
  if (store.accepting_orders === false) {
    const reason = store.closed_reason ?? (store.mobile_order ? null : 'mobile_order_unavailable');
    return { selectable: false, reason: closedReasonText(reason) };
  }
  if (store.accepting_orders === undefined && !store.mobile_order) {
    return { selectable: false, reason: closedReasonText('mobile_order_unavailable') };
  }
  return { selectable: true, reason: null };
}

export function groupStoresByArea(stores: Store[]): { area: string; stores: Store[] }[] {
  const areas = [...new Set(stores.map((s) => s.area))];
  return areas.map((area) => ({ area, stores: stores.filter((s) => s.area === area) }));
}

/** scope: 'store' は店のせい（未選択・営業外。メニューの上に 1 回だけ出す）、'variant' はその変種のせい（品ごとに出す） */
export type VariantState = { canAdd: boolean; reason: string | null; scope: 'store' | 'variant' | null };

/** 変種をカートに入れられるか。店が未選択・営業外・品切れ・季節外・時間外は、理由つきで無効 */
export function variantState(variant: Pick<Variant, 'available' | 'unavailable_reason'>, store: Store | null): VariantState {
  if (!store) return { canAdd: false, reason: '先に、受け取る店を選んでください', scope: 'store' };
  const status = storeStatus(store);
  if (!status.selectable) return { canAdd: false, reason: `選んだ店は今、注文できません（${status.reason}）`, scope: 'store' };
  if (variant.available === false) return { canAdd: false, reason: unavailableReasonText(variant.unavailable_reason), scope: 'variant' };
  return { canAdd: true, reason: null, scope: null };
}

/** メニューの上に 1 回だけ出す、店のせいで注文できない理由。注文できる店なら null */
export function storeNote(store: Store | null): string | null {
  if (!store) return '先に、受け取る店を選んでください。';
  const status = storeStatus(store);
  return status.selectable ? null : `選んだ「${store.name}」は、今は注文を受け付けていません（${status.reason}）。別の店を選んでください。`;
}

export function filterMenu(menu: MenuItem[], category: Category | null): MenuItem[] {
  return category ? menu.filter((i) => i.category === category) : menu;
}

/** 「注文内容を確認する」へ進めない理由（空なら進める）。宅配は、delivery.issues を API の順のまま、直し方つきの固定の文にする */
export function checkoutBlockers(cart: Cart, store: Store | null): string[] {
  const out: string[] = [];
  if (cart.lines.length === 0) {
    out.push('カートが空です');
    return out;
  }
  if (!cart.store) out.push('受け取る店を選んでください');
  else if (store) {
    const status = storeStatus(store);
    if (!status.selectable) out.push(`選んだ店は今、注文できません（${status.reason}）`);
  }
  if (cart.lines.some((l) => !l.available)) out.push('今は注文できない品があります。カートから削除してください');
  // 上限は品の小計で見る（送料は含めない。API と同じ）
  if (cart.subtotal_lumi > MAX_ORDER_TOTAL_LUMI) out.push(`品の小計が${formatLumi(MAX_ORDER_TOTAL_LUMI)} を超えています。数量を減らしてください`);
  // 店が未選択のときの issues は、店が無いことの結果なので出さない（上の「受け取る店を選んでください」だけ）
  if (cart.fulfillment === 'delivery' && cart.store && cart.delivery) {
    const extra = cart.delivery.min_order_lumi === null ? {} : { min_order_lumi: cart.delivery.min_order_lumi };
    for (const code of cart.delivery.issues) out.push(describeError({ code, ...extra }).text);
  }
  return out;
}
