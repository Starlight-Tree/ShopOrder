"""チャットの設定。設計の既定の数字（変えるときはここだけ）と、環境変数で決める値。実測ではなく、設計で決めた値。"""

import os

# ---- 入力・回数の上限 ----
MESSAGE_MAX_CHARS = 500  # 1 発話の文字数
HISTORY_MESSAGES = 20  # モデルに渡す、過去の発話の数（本文だけ。ツールの結果は渡さず、ターンの先頭で get_cart を読み直す）
THREAD_MAX_USER_MESSAGES = 60  # 1 スレッドの、利用者の発話の上限
DAILY_MESSAGES_PER_USER = 100  # 1 利用者・1 日（店のローカル日付）の、発話の上限
DAILY_THREADS_PER_USER = 20  # 1 利用者・1 日の、スレッドの作成の上限

# ---- 1 ターン（1 回の発話への応答）の上限 ----
MAX_MODEL_STEPS = 12  # モデルを呼ぶ回数
MAX_TOOL_CALLS_PER_TURN = 12  # ツールの呼び出し（ターンの先頭の get_cart を含む）
MAX_WRITES_PER_TURN = 3  # 書き込み（カートの下書き・提案）の回数（docs/chat.md）

# ---- ツールの結果（モデルに見せる値）----
TOOL_TEXT_MAX_CHARS = 120  # 商品名・説明などの文字数。超える分は切る（信頼できないデータなので、長さを制限する）
TOOL_RESULT_MAX_BYTES = 12_000  # DB に残す結果の大きさ
SEARCH_MAX_ITEMS = 8
ORDERS_MAX = 5  # list_my_orders の件数

# ---- 配信 ----
KEEPALIVE_SECONDS = 10.0  # イベントが無い間に SSE のコメント行（ping）を送る間隔
TEXT_CHUNK_CHARS = 24  # 本文を text-delta に分ける長さ
TURN_LEASE_SECONDS = 120  # 1 スレッド 1 ターンの貸し出しの期限（落ちても、この秒数で外れる）

RETENTION_DAYS_DEFAULT = 30  # 会話ログの保存期間（日）。設計の既定。環境変数 CHAT_RETENTION_DAYS で変える
PURGE_BATCH = 100  # 1 回に消すスレッドの数


def retention_days() -> int:
    """会話ログの保存期間（日）。1〜365 の整数。不正な値は例外（別の値へ黙って落とさない）。呼ぶたびに環境変数を読む。"""
    raw = os.environ.get("CHAT_RETENTION_DAYS", str(RETENTION_DAYS_DEFAULT))
    try:
        days = int(raw)
    except ValueError as exc:
        raise RuntimeError("CHAT_RETENTION_DAYS は整数にしてください") from exc
    if not 1 <= days <= 365:
        raise RuntimeError("CHAT_RETENTION_DAYS は 1〜365 の整数にしてください")
    return days
