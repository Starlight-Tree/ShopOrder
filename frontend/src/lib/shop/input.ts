// Server Action へ届く値（FormData）は、ブラウザーから来る信用できない入力。型と範囲を確かめてから使う。
import type { Fulfillment } from '../contract';
import { ADDRESS_LABEL_MAX, ADDRESS_LINE_MAX, ADDRESS_NOTE_MAX, MAX_LINE_QTY } from './constants';

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

export function parseFulfillment(raw: unknown): Fulfillment | null {
  return raw === 'pickup' || raw === 'delivery' ? raw : null;
}

/** エリア番号（1〜99） */
export function parseAreaCode(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[1-9][0-9]?$/.test(raw)) return null;
  return Number(raw);
}

export type AddressInput = { label: string; areaCode: number; line: string; note: string | null };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const lengthOf = (s: string) => [...s].length; // API は文字数（コードポイント）で数える

/**
 * 住所の入力（FormData）。前後の空白を除き、API と同じ範囲（ラベル 1〜20・住所 1〜100・メモ 100 まで・制御文字なし）だけ通す。
 * 範囲外は null（理由は返さない。入力の中身を、エラー文・ログに出さないため）
 */
export function parseAddressInput(form: FormData): AddressInput | null {
  const label = formString(form, 'label')?.trim() ?? '';
  const line = formString(form, 'line')?.trim() ?? '';
  const note = formString(form, 'note')?.trim() ?? '';
  const areaCode = parseAreaCode(formString(form, 'area_code'));
  if (areaCode === null) return null;
  if (lengthOf(label) < 1 || lengthOf(label) > ADDRESS_LABEL_MAX) return null;
  if (lengthOf(line) < 1 || lengthOf(line) > ADDRESS_LINE_MAX) return null;
  if (lengthOf(note) > ADDRESS_NOTE_MAX) return null;
  if ([label, line, note].some((v) => CONTROL_CHARS.test(v))) return null;
  return { label, areaCode, line, note: note === '' ? null : note };
}
