"""API のエラー。本文は固定の文（例外の文字列・パス・SQL を含めない）。形は {"detail": {"code", "message", ...}}（docs/api.md）。"""

from fastapi import HTTPException

MESSAGES: dict[str, str] = {
    # 認証・権限
    "unauthorized": "認証が必要です。",
    "forbidden": "この操作はできません。",
    "invalid_credentials": "メールアドレスかパスワードが違います。",
    "too_many_attempts": "失敗が続いたため、しばらくしてからもう一度お試しください。",
    # 見つからない・他人のもの（存在を教えない）
    "not_found": "見つかりません。",
    "store_not_found": "店が見つかりません。",
    "variant_not_found": "その品は見つかりません。",
    "proposal_not_found": "確認の内容が見つかりません。",
    # カート
    "delivery_unsupported": "宅配はまだ使えません。",
    "too_many_lines": "1 回の注文は 30 種類までです。",
    # 確定の検証
    "cart_empty": "カートが空です。",
    "store_not_selected": "受け取る店を選んでください。",
    "store_closed": "この店は今、注文を受けられません。",
    "item_unavailable": "今は出せない品があります。",
    "sold_out": "売り切れの品があります。",
    "over_limit": "1 回の注文は 30,000 ルミまでです。",
    "proposal_expired": "確認の有効期限が切れました。もう一度確認してください。",
    "proposal_stale": "カートの内容が変わりました。もう一度確認してください。",
    "idempotency_conflict": "同じキーで、違う内容の注文は送れません。",
    "idempotency_in_progress": "同じキーの注文を処理中です。",
    # 支払い・状態の変更
    "payment_declined": "支払いが承認されませんでした。注文は取り消されました。",
    "reservation_expired": "支払いの期限が過ぎたため、注文は取り消されました。",
    "not_cancellable": "この注文は、今は取り消せません。",
    "invalid_transition": "今の状態では、この操作はできません。",
    "reason_required": "理由を入力してください。",
    # スタッフの在庫・一覧
    "store_required": "店を選んでください。",
    "invalid_status": "状態の指定が正しくありません。",
    "insufficient_stock": "在庫が足りないため、この操作はできません。",
    "invalid_delta": "0 の調整はできません。",
    # 予期しない失敗
    "internal_error": "サーバーでエラーが起きました。時間をおいてもう一度お試しください。",
}


class ApiError(HTTPException):
    def __init__(self, status_code: int, code: str, **extra):
        super().__init__(status_code=status_code, detail={"code": code, "message": MESSAGES[code], **extra})
