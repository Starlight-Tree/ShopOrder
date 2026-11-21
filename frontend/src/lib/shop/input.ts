// Server Action へ届く値（FormData）は、ブラウザーから来る信用できない入力。型と範囲を確かめてから使う。
import { MAX_LINE_QTY } from './constants';

/** 正の整数（ID）。"12" → 12。それ以外は null */
export function parseId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

/** 数量 0..20 の整数 */
export function parseQty(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[0-9]{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 0 && n <= MAX_LINE_QTY ? n : null;
}

/** 注文の公開 ID（例: K7M2Q9XD）。URL のパスへ入れるので、記号を許さない */
export function isValidPublicId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9]{4,32}$/.test(raw);
}

/** 冪等キー・提案の ID（8〜64 文字の英数字とハイフン） */
export function isValidToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(raw);
}

export type Simulate = 'ok' | 'decline';

export function parseSimulate(raw: unknown): Simulate | null {
  return raw === 'ok' || raw === 'decline' ? raw : null;
}

/** FormData の文字列だけを取り出す（File は捨てる） */
export function formString(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === 'string' ? v : null;
}
