// docs/api.md の応答の形（P1: 店頭受け取りの注文、P2: 宅配の項目）。API の約束が変わったら、ここと docs/api.md を一緒に直す。
import type { ClosedReason, SlotRef, UnavailableReason, Zone, ZoneRef } from './types';

export type Fulfillment = 'pickup' | 'delivery';

// ---- 宅配（P2）: 住所・カートと注文の配達 ----

export type AddressBrief = { id: number; label: string; area_code: number; area_name: string };

/** 顧客本人の住所（line・note は個人情報。ログ・URL・エラー文に出さない） */
export type Address = AddressBrief & { zone_id: number | null; line: string; note: string | null; created_at: string };

/** カートの宅配の選択の状態。issues は「今の確認・確定が 409 にするコード」（空なら通る。順は docs/api.md） */
export type CartDelivery = {
  address: AddressBrief | null;
  zone: Zone | null;
  slot: SlotRef | null;
  fee_lumi: number;
  free_over_lumi: number | null;
  min_order_lumi: number | null;
  issues: string[];
};

export type DeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'delivering' | 'delivered' | 'failed' | 'cancelled';
export type DeliveryFailureReason = 'absent' | 'cannot_receive' | 'other' | 'pin_locked';

/** 注文の配達。courier は名前だけ。pin は集荷後（picked_up・delivering）の本人の注文にだけ付く */
export type OrderDelivery = {
  status: DeliveryStatus;
  zone: ZoneRef;
  slot: SlotRef;
  courier: { name: string } | null;
  pin: string | null;
  eta_at: string | null;
  address: { label: string };
  attempt: number;
  failure_reason: DeliveryFailureReason | null;
};

export type CartLine = {
  variant_id: number;
  item_code: string;
  name: string;
  size: string;
  temperature: string;
  unit_price_lumi: number;
  qty: number;
  line_total_lumi: number;
  available: boolean;
  unavailable_reason: UnavailableReason | null;
};

export type Cart = {
  version: number;
  store: { id: number; name: string } | null;
  fulfillment: Fulfillment;
  lines: CartLine[];
  subtotal_lumi: number;
  delivery_fee_lumi: number;
  total_lumi: number;
  /** 宅配のときの選択の状態。店頭は null */
  delivery: CartDelivery | null;
};

export type CheckoutProposal = {
  id: string;
  cart_version: number;
  total_lumi: number;
  expires_at: string;
  store: { id: number; name: string };
  lines: CartLine[];
  /** 店頭のときの案内。宅配は null */
  pickup_note: string | null;
  fulfillment: Fulfillment;
  subtotal_lumi: number;
  delivery_fee_lumi: number;
  /** 宅配のとき（issues は空）。店頭は null */
  delivery: CartDelivery | null;
};

export type PickupStatus = 'placed' | 'paid' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled';
/** 宅配だけの状態（delivered は同じトランザクションで completed になるので、通常は見えない） */
export type DeliveryOrderStatus = 'assigned' | 'picked_up' | 'delivering' | 'delivered' | 'delivery_failed';
export type OrderStatus = PickupStatus | DeliveryOrderStatus;

export type OrderItem = {
  name: string;
  size: string;
  temperature: string;
  unit_price_lumi: number;
  qty: number;
  line_total_lumi: number;
};

export type OrderEvent = { to_status: OrderStatus; at: string; actor_type: 'customer' | 'staff' | 'system'; reason: string | null };

export type Order = {
  public_id: string;
  pickup_no: number;
  status: OrderStatus;
  fulfillment: Fulfillment;
  store: { id: number; name: string };
  items: OrderItem[];
  subtotal_lumi: number;
  delivery_fee_lumi: number;
  total_lumi: number;
  placed_at: string;
  reservation_expires_at: string | null;
  payment: { provider: string; status: 'pending' | 'paid' | 'failed' | 'refunded' } | null;
  events: OrderEvent[];
  cancel_reason: string | null;
  can_pay: boolean;
  can_cancel: boolean;
  /** 宅配の配達。店頭は null */
  delivery: OrderDelivery | null;
};

export type OrderSummary = Pick<Order, 'public_id' | 'pickup_no' | 'status' | 'fulfillment' | 'store' | 'total_lumi' | 'placed_at'>;

export type StaffRole = 'staff' | 'manager' | 'courier';
export type Staff = { id: number; name: string; role: StaffRole; store_id: number | null };
export type StaffAction = 'accept' | 'start' | 'ready' | 'complete' | 'cancel';
// delivery は顧客向けの形（住所のラベル・暗証コード）なので、スタッフの注文には含めない（スタッフの配達の形は staff/delivery-types.ts）
export type StaffOrder = Omit<Order, 'payment' | 'delivery'> & { allowed_actions: StaffAction[] };

export type StockRow = {
  item_id: number;
  code: string;
  name: string;
  kind: 'material' | 'sellable';
  unit: string;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number;
  low: boolean;
};

/** エラー本文の形（`detail` が { code, message } のとき）。入力の形の誤り（422 の配列）は code が無い。 */
export type ApiErrorBody = { code: string; message: string; [extra: string]: unknown };
export type { ClosedReason };
