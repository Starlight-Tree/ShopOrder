// 開発用ログイン名（Cookie oasis_dev_user）。API の X-Dev-User と同じ規則: [a-z0-9-]{1,40}
import { DEFAULT_DEV_USER } from './constants';

const DEV_USER_PATTERN = /^[a-z0-9-]{1,40}$/;

export function isValidDevUser(value: unknown): value is string {
  return typeof value === 'string' && DEV_USER_PATTERN.test(value);
}

/** Cookie の値から、API へ渡す名前を取り出す。規則に合わない値は捨てる（ヘッダーへ入れない） */
export function devUserFromCookie(value: string | undefined): string | undefined {
  return isValidDevUser(value) ? value : undefined;
}

/** 開発用の道具（ログイン名の切替・模擬の支払い失敗）を出してよいか。本番ビルドでは出さない */
export function devToolsEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'production';
}

export function currentDevUserLabel(devUser: string | undefined): string {
  return devUser ?? `${DEFAULT_DEV_USER}（既定）`;
}
