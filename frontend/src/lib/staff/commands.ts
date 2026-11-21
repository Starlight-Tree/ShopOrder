// スタッフの書き込み（ログイン・状態の遷移・在庫の操作）。Server Action から呼ぶ。Cookie・redirect はここで扱わない（action 側）。
// Server Action の引数はクライアントから来る（信用しない）ので、形をここで確かめてから API へ送る。API も毎回、権限を確かめる。
import type { Staff, StaffAction, StockRow } from '../contract';
import { apiRequest } from '../server-api';
import type { StaffApi } from './loaders';
import { failureFrom, loginErrorMessage, MSG } from './messages';
import type { StockOp, StockOutcome, TransitionInput, TransitionResult } from './types';

const REASON_MAX = 100;
const EMAIL_MAX = 254;
const PASSWORD_MAX = 256;
const PUBLIC_ID_RE = /^[A-Za-z0-9]{4,32}$/;
const ACTIONS: readonly StaffAction[] = ['accept', 'start', 'ready', 'complete', 'cancel'];

// ---- ログイン ----

export type LoginOutcome =
  | { ok: true; token: string; expiresAt: string | null; staff: Staff }
  | { ok: false; message: string };

export async function performLogin(email: unknown, password: unknown, api: StaffApi = apiRequest): Promise<LoginOutcome> {
  const e = typeof email === 'string' ? email.trim() : '';
  const p = typeof password === 'string' ? password : '';
  if (!e || !p) return { ok: false, message: MSG.loginEmpty };
  // 長すぎる入力は、API へ送らず、誤りと同じ文で返す（理由を分けない）
  if (e.length > EMAIL_MAX || p.length > PASSWORD_MAX) return { ok: false, message: MSG.loginInvalid };
  const res = await api<{ token?: unknown; expires_at?: unknown; staff?: Staff }>('/api/staff/login', {
    method: 'POST',
    body: { email: e, password: p },
  });
  if (!res.ok) return { ok: false, message: loginErrorMessage(res.status) };
  const { token, expires_at: expiresAt, staff } = res.data ?? {};
  if (typeof token !== 'string' || token === '' || !staff) return { ok: false, message: MSG.loginFailed };
  return { ok: true, token, expiresAt: typeof expiresAt === 'string' ? expiresAt : null, staff };
}

/** トークンを API 側でも無効にする。失敗しても、Cookie は消すので、結果は見ない */
export async function performLogout(token: string, api: StaffApi = apiRequest): Promise<void> {
  await api<undefined>('/api/staff/logout', { method: 'POST', staffToken: token });
}

// ---- 注文の遷移 ----

export function normalizeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const r = value.trim();
  return r.length >= 1 && r.length <= REASON_MAX ? r : null;
}

export async function performTransition(token: string, input: TransitionInput, api: StaffApi = apiRequest): Promise<TransitionResult> {
  const { publicId, action } = input ?? {};
  if (typeof publicId !== 'string' || !PUBLIC_ID_RE.test(publicId) || !ACTIONS.includes(action)) {
    return { ok: false, kind: 'invalid', message: MSG.generic };
  }
  const body: { action: StaffAction; reason?: string } = { action };
  if (action === 'cancel') {
    const reason = normalizeReason(input.reason);
    if (reason === null) return { ok: false, kind: 'invalid', message: MSG.cancelReasonRequired };
    body.reason = reason;
  }
  const res = await api<unknown>(`/api/staff/orders/${publicId}/transition`, { method: 'POST', body, staffToken: token });
  if (res.ok) return { ok: true };
  return { ok: false, ...failureFrom(res, MSG.orderNotFound) };
}

// ---- 在庫の操作 ----

export type StockFields = { itemId: unknown; amount: unknown; reason: unknown };

/** 全角の数字・符号も受ける（NFKC）。U+2212 のマイナスは、NFKC では変わらないので置き換える */
function toInteger(value: unknown, allowNegative: boolean): number | null {
  if (typeof value !== 'string') return null;
  const s = value.normalize('NFKC').replace(/[−ー]/g, '-').trim();
  const re = allowNegative ? /^-?\d{1,7}$/ : /^\d{1,7}$/;
  return re.test(s) ? Number(s) : null;
}

type ParsedStock = { ok: true; itemId: number; body: Record<string, unknown>; amount: number } | { ok: false; message: string };

export function parseStockFields(op: StockOp, fields: StockFields): ParsedStock {
  const itemId = toInteger(fields.itemId, false);
  if (itemId === null || itemId < 1) return { ok: false, message: '品目を選んでください' };
  const amount = toInteger(fields.amount, op === 'adjust');
  if (op === 'adjust') {
    if (amount === null || amount === 0) return { ok: false, message: '差分は、0 ではない整数で入力してください（減っていれば負の数）' };
  } else if (amount === null || amount < 1) {
    return { ok: false, message: '数は、1 以上の整数で入力してください' };
  }
  const reasonRaw = typeof fields.reason === 'string' ? fields.reason.trim() : '';
  if (reasonRaw.length > REASON_MAX) return { ok: false, message: `理由は ${REASON_MAX} 文字までです` };
  if (op !== 'receive' && reasonRaw === '') return { ok: false, message: '理由を入力してください' };
  const key = op === 'adjust' ? 'delta' : 'qty';
  const body: Record<string, unknown> = { [key]: amount };
  if (reasonRaw !== '') body.reason = reasonRaw;
  return { ok: true, itemId, body, amount: amount as number };
}

const OP_TEXT: Record<StockOp, string> = { receive: '入荷しました', waste: '廃棄しました', adjust: '棚卸しで調整しました' };

export async function performStockOp(token: string, op: StockOp, fields: StockFields, api: StaffApi = apiRequest): Promise<StockOutcome> {
  if (op !== 'receive' && op !== 'waste' && op !== 'adjust') return { ok: false, kind: 'invalid', message: MSG.generic };
  const parsed = parseStockFields(op, fields);
  if (!parsed.ok) return { ok: false, kind: 'invalid', message: parsed.message };
  const res = await api<Partial<StockRow>>(`/api/staff/stock/${parsed.itemId}/${op}`, { method: 'POST', body: parsed.body, staffToken: token });
  if (!res.ok) return { ok: false, ...failureFrom(res, MSG.itemNotFound) };
  const row = res.data ?? {};
  const name = typeof row.name === 'string' ? `「${row.name}」を` : '';
  const unit = typeof row.unit === 'string' ? ` ${row.unit}` : '';
  const amountText = op === 'adjust' ? `（${parsed.amount > 0 ? '+' : ''}${parsed.amount}${unit}）` : `（${parsed.amount}${unit}）`;
  const after = typeof row.on_hand === 'number' ? `実在庫は ${row.on_hand}${unit}になりました` : '';
  return { ok: true, message: `${name}${OP_TEXT[op]}${amountText}。${after}`.replace(/。$/, '') };
}
