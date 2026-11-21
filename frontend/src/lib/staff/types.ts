// スタッフ画面の Server Action と、画面（クライアント）の間でやり取りする形。実行時の import を持たない（クライアントから import type で使う）。
import type { StaffAction } from '../contract';

export type FailureKind = 'unauthorized' | 'conflict' | 'not_found' | 'forbidden' | 'invalid' | 'unreachable' | 'error';

export type TransitionInput = { publicId: string; action: StaffAction; reason?: string };
export type TransitionResult = { ok: true } | { ok: false; kind: FailureKind; message: string };

export type StockOp = 'receive' | 'waste' | 'adjust';
export type StockOutcome = { ok: true; message: string } | { ok: false; kind: FailureKind; message: string };
/** フォームの結果。seq は、同じ内容の結果でも、画面が「新しい結果」と分かるための通し番号 */
export type StockFormState = { status: 'idle' | 'ok' | 'error'; message: string; seq: number };

export type LoginState = { error: string | null };
