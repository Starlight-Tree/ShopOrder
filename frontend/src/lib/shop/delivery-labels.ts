// 宅配（P2）で画面に出す固定の日本語。API の応答の文言は信用せず、code から選ぶ。
import type { DeliveryFailureReason, Fulfillment } from '../contract';

export const FULFILLMENTS: readonly Fulfillment[] = ['pickup', 'delivery'];

/** 受け取り方法の選択肢の名前 */
export const FULFILLMENT_LABEL: Record<Fulfillment, string> = { pickup: '店頭でお渡し', delivery: '宅配' };

/** 確認・注文の画面の「受け取り方法」の行 */
export function fulfillmentText(fulfillment: Fulfillment): string {
  return fulfillment === 'delivery' ? '宅配（お届け）' : '店頭でお渡し';
}

/** 受け取り番号の見出し。宅配では、受け取りには使わない（お店での呼び名） */
export function pickupNoLabel(fulfillment: Fulfillment): string {
  return fulfillment === 'delivery' ? '受付番号' : '受け取り番号';
}

const SLOT_LIST_REASON: Record<string, string> = {
  delivery_unavailable: 'この店は宅配をしていません。',
  mobile_order_unavailable: 'この店はモバイルオーダーをご利用いただけないため、宅配もできません。',
  temporary_closure: 'この日は臨時休業のため、宅配を受け付けていません。',
  closed_today: 'この日は定休日のため、宅配を受け付けていません。',
  storm_warning: '砂嵐の警報が出ているため、選んだ住所の地域への宅配は、今は受け付けていません。',
  zone_unserved: 'この店は、選んだ住所の地域へは届けられません。',
};

/** 枠の一覧が空になる理由。未知の値・null でも、固定の文を返す */
export function slotListReasonText(reason: string | null | undefined): string {
  return (reason && SLOT_LIST_REASON[reason]) || '今は、宅配の時間枠をお出しできません。';
}

const FAILURE_REASON: Record<DeliveryFailureReason, string> = {
  absent: '不在のため、お届けできませんでした。',
  cannot_receive: 'お受け取りいただけなかったため、お届けできませんでした。',
  other: 'お届けできませんでした。',
  pin_locked: '暗証コードが続けて合わなかったため、配達を止めました。',
};

/** 配達できなかった理由。未知の値・null でも、固定の文を返す */
export function failureReasonText(reason: string | null | undefined): string {
  return (reason && (FAILURE_REASON as Record<string, string>)[reason]) || 'お届けできませんでした。';
}

/** 配達できなかったあとの案内。再配達・取消しはお店が行う（顧客の画面から再配達は頼めない） */
export const FAILED_GUIDANCE = '再配達の時間枠の調整や取消しは、お店が行います。お店からの連絡をお待ちください。お急ぎの場合は、お店へお問い合わせください。';

/** 暗証コードの案内（出すときの文と、確認画面で前もって伝える文） */
export const PIN_GUIDANCE = '配達員にお伝えください。ほかの人には教えないでください。';
export const PIN_PREVIEW = 'お品を集荷したあと、注文の画面に、受け取り用の暗証コード（4 桁）が表示されます。配達員にお伝えください。';
