"""チャットの API エラーの固定の文。共有の app/errors.py の MESSAGES に、ここで足す（共有のファイルを触らずに済ませる）。

形は他と同じ: {"detail": {"code", "message"}}。例外の文字列・パスは含めない。
"""

from app.errors import MESSAGES

MESSAGES.update(
    {
        "chat_busy": "前の発言を処理しています。終わってから、もう一度送ってください。",
        "chat_thread_full": "この会話は、発言の上限に達しました。新しい会話を始めてください。",
        "chat_rate_limited": "今日の利用の上限に達しました。明日になってから、もう一度お試しください。",
    }
)
