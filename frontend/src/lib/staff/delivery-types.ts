// 宅配（P2）の、配車・配達員の画面が使う API の形（docs/api.md「宅配（P2）」）。共有の contract.ts は触らないので、ここに足す。
// 実行時の import を持たない（クライアントから import type で使う）。
import type { FailureKind } from './types';

export type DeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'delivering' | 'delivered' | 'failed' | 'cancelled';
export type FailureReason = 'absent' | 'cannot_receive' | 'other' | 'pin_locked';

export type ZoneRef = { id: number; name: string };
export type SlotRef = { id: number; starts_at: string; ends_at: string };

export type Zone = {
  id: number;
  name: string;
  area_code: number;
  fee_lumi: number;
  free_over_lumi: number | null;
  min_order_lumi: number;
  base_minutes: number;
  is_suspended: boolean;
};

/** 店のスタッフが見る配達（住所・暗証コードは含まれない） */
export type StaffDelivery = {
  status: DeliveryStatus;
  zone: ZoneRef;
  slot: SlotRef;
  courier: { id: number; name: string } | null;
  attempt: number;
  failure_reason: FailureReason | null;
};

export type DispatchSuggestion = { courier_id: number; courier_name: string; minutes: number };

/**
 * 配車ボードの注文。宅配だけ。status は ready / assigned / picked_up / delivering / delivery_failed など（宅配の状態は P1 の contract.ts に無い）。
 * 画面が使う項目だけ（loader がこの形に詰め替える。API が余計な項目を返しても、ブラウザーへ渡る props には残らない）。
 */
export type DispatchOrder = {
  public_id: string;
  pickup_no: number;
  status: string;
  store: { id: number; name: string };
  items: Array<{ name: string; size: string; temperature: string; qty: number }>;
  allowed_actions: string[];
  delivery: StaffDelivery;
  suggestion: DispatchSuggestion | null;
};

export type Courier = {
  id: number;
  store_id: number;
  name: string;
  vehicle: string;
  is_on_duty: boolean;
  active_count: number;
  zone: ZoneRef | null;
};

export type DispatchBoardData = { provider: 'mock' | 'inhouse'; couriers: Courier[]; orders: DispatchOrder[] };

export type CourierDeliveryStatus = 'assigned' | 'picked_up' | 'delivering' | 'delivery_failed' | 'completed';
export type CourierAction = 'pickup' | 'depart' | 'deliver' | 'fail';

/** 配達員が見る配達。address は集荷後だけ（個人情報） */
export type CourierDelivery = {
  public_id: string;
  pickup_no: number;
  status: CourierDeliveryStatus | string;
  store: { id: number; name: string };
  zone: ZoneRef;
  slot: SlotRef;
  items: Array<{ name: string; size: string; temperature: string; qty: number }>;
  address: { label: string; line: string; note: string | null } | null;
  attempt: number;
  pin_attempts_left: number | null;
  eta_at: string | null;
  allowed_actions: string[];
};

// ---- Server Action と画面の間 ----

export type AssignInput = { publicId: string; courierId: number };
export type RedeliverInput = { publicId: string };
export type MockAdvanceInput = { publicId: string };
export type SuspensionInput = { zoneId: number; suspended: boolean };
export type CourierActionInput = { publicId: string; action: CourierAction; pin?: string; reason?: 'absent' | 'cannot_receive' | 'other' };

/** 操作の結果。refresh は、他の人が先に操作した・状態が変わったときに、画面を最新に取り直すための印 */
export type DeliveryOutcome =
  | { ok: true; message: string }
  | { ok: false; kind: FailureKind; message: string; refresh: boolean };

/** 配車ボードの取消し（既存の transition の cancel）。理由は必須（performTransition が確かめる） */
export type DispatchCancelInput = { publicId: string; reason?: string };
