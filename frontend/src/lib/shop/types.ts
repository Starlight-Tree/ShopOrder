// 画面側だけで使う型（共有の contract.ts・types.ts は変えず、足したい型はここに置く）
export type NextLink = { label: string; href: string };

/** Server Action の結果。フォームの下に出す文。null は「まだ何も送っていない」 */
export type ActionState = { ok: true; message?: string } | { ok: false; message: string; next?: NextLink } | null;

/** useActionState に渡す形の Server Action */
export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** API を呼ぶときの利用者（Cookie から取り出した開発用ログイン名） */
export type ShopCtx = { devUser?: string };
