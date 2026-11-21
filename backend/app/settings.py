"""設定は環境変数だけで受け取る。足りなければ起動を失敗させ、別の値へ黙って切り替えない。値（秘密）をコード・ログ・Git に置かない。"""

import os


def database_url() -> str:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL が未設定です")
    return url


def cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "http://localhost:3400")
    return [o.strip() for o in raw.split(",") if o.strip()]


def app_env() -> str:
    """APP_ENV を strip().lower() で正規化して返す。未設定は空文字（開発とは見なさない。is_dev_environment を見る）。"""
    return os.environ.get("APP_ENV", "").strip().lower()


DEV_ENVIRONMENTS = ("development", "test")


def is_dev_environment() -> bool:
    """開発専用の設定（AUTH_MODE=dev・ORDER_HOURS_CHECK=off・模擬決済）を許す環境か。development / test と明示されたときだけ True（許可リスト）。"""
    return app_env() in DEV_ENVIRONMENTS


AUTH_MODES = ("dev",)  # 顧客の認証。dev = ヘッダー X-Dev-User（開発専用）。本物のログイン（Better Auth・JWT）は P6


def auth_mode() -> str:
    value = os.environ.get("AUTH_MODE", "dev")
    if value not in AUTH_MODES:
        raise RuntimeError(f"AUTH_MODE は {' / '.join(AUTH_MODES)} のどれかにしてください（本物のログインは P6）")
    return value


def order_hours_check() -> bool:
    """営業時間・定休日・ラストオーダー・販売時間帯を見るか。既定は on。off は開発の便宜（季節の期間は off でも見る）。環境変数は呼ぶたびに読む。"""
    value = os.environ.get("ORDER_HOURS_CHECK", "on")
    if value not in ("on", "off"):
        raise RuntimeError("ORDER_HOURS_CHECK は on / off のどちらかにしてください")
    return value == "on"


def local_utc_offset_hours() -> int:
    raw = os.environ.get("LOCAL_UTC_OFFSET_HOURS", "9")
    try:
        hours = int(raw)
    except ValueError as exc:
        raise RuntimeError("LOCAL_UTC_OFFSET_HOURS は整数にしてください") from exc
    if not -12 <= hours <= 14:
        raise RuntimeError("LOCAL_UTC_OFFSET_HOURS は -12〜14 の整数にしてください")
    return hours


def db_pool_max() -> int:
    return max(2, int(os.environ.get("DB_POOL_MAX", "10")))


def required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} が未設定です")
    return value


# ---- 差し替え口（決済・配達・通知・チャットの LLM）。既定はすべて模擬。本物への切り替えは、承認を得てから環境変数で選ぶ。 ----

PROVIDERS: dict[str, tuple[str, ...]] = {
    "PAYMENT_PROVIDER": ("mock",),  # 本物（stripe など）は、実際に使うときに足す（docs/decisions/0005）
    "DELIVERY_PROVIDER": ("mock", "inhouse"),
    "NOTIFIER": ("inapp",),
    "CHAT_MODEL": ("mock", "gemini"),
}


def provider(name: str) -> str:
    """差し替え口の選択。許す値の一覧にない値は例外（別の実装へ黙って落とさない）。未設定は、一覧の先頭（模擬）。"""
    allowed = PROVIDERS[name]
    value = os.environ.get(name, allowed[0])
    if value not in allowed:
        raise RuntimeError(f"{name} は {' / '.join(allowed)} のどれかにしてください")
    return value


def require_demo_data_allowed() -> None:
    """ダミーデータの投入（seed_demo）は、DEMO_DATA=allow を明示した環境だけ。本番の環境には、この値を渡さない。"""
    if os.environ.get("DEMO_DATA") != "allow":
        raise SystemExit("ダミーデータの投入は、DEMO_DATA=allow を渡した開発・テストの環境だけです。実行しませんでした。")
    if os.environ.get("APP_ENV", "").strip().lower() == "production":
        raise SystemExit("APP_ENV=production では、ダミーデータの投入（特に --reset）を実行しません。")
