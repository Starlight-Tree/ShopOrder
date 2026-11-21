// 配達員の書き込み（集荷・出発・暗証コードでの完了・不在）。Server Action から呼ぶ。Cookie・redirect はここで扱わない（action 側）。
// Server Action の引数はクライアントから来る（信用しない）ので、形をここで確かめてから API へ送る。API も毎回、権限と状態を確かめる。
// 暗証コードは、API への本文にだけ入れる。ログ・URL・エラー文・戻り値には入れない。
import { apiRequest } from '../server-api';
import { isFailReason, normalizePin } from './courier';
import { COURIER_MSG, courierFailureFrom, courierSuccessMessage } from './courier-messages';
import type { CourierAction, CourierActionInput, DeliveryOutcome } from './delivery-types';
import type { StaffApi } from './loaders';
import { MSG } from './messages';

const PUBLIC_ID_RE = /^[A-Za-z0-9]{4,32}$/;
const ACTIONS: readonly CourierAction[] = ['pickup', 'depart', 'deliver', 'fail'];

const invalid = (message: string): DeliveryOutcome => ({ ok: false, kind: 'invalid', message, refresh: false });

export async function performCourierAction(token: string, input: CourierActionInput, api: StaffApi = apiRequest): Promise<DeliveryOutcome> {
  const { publicId, action } = input ?? {};
  if (typeof publicId !== 'string' || !PUBLIC_ID_RE.test(publicId) || !ACTIONS.includes(action)) return invalid(MSG.generic);

  let body: { pin: string } | { reason: string } | undefined;
  if (action === 'deliver') {
    const pin = normalizePin(input.pin);
    if (pin === null) return invalid(COURIER_MSG.pinFormat);
    body = { pin };
  } else if (action === 'fail') {
    // 自由記述は受けない（個人情報を入れさせない）。決まった理由だけ
    if (!isFailReason(input.reason)) return invalid(COURIER_MSG.reasonRequired);
    body = { reason: input.reason };
  }

  const res = await api<{ pickup_no?: unknown }>(`/api/courier/deliveries/${publicId}/${action}`, { method: 'POST', body, staffToken: token });
  if (!res.ok) return courierFailureFrom(res, action);
  const pickupNo = res.data?.pickup_no;
  return { ok: true, message: courierSuccessMessage(typeof pickupNo === 'number' && Number.isInteger(pickupNo) ? pickupNo : null, action) };
}
