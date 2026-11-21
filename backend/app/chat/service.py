"""スレッド・発話の保存、1 日の上限、1 スレッド 1 ターンの貸し出し、保存期間と削除（docs/chat.md「会話ログ」）。

- 他人のスレッド・期限切れのスレッドは、無いのと同じ 404（存在を教えない）。利用者はセッション（API の認証）から決め、いつも user_id で絞る。
- ターンの始まり（begin_turn）は 1 つのトランザクション: 貸し出しを取る → 上限を数える → 利用者の発話を保存する。どれかが失敗すれば全部戻る（貸し出しも）。
- 会話の本文は個人情報。ログには出さない（種類と件数だけ）。保存期間（CHAT_RETENTION_DAYS。既定 30 日）を過ぎたスレッドは、読めなくなり、削除の対象になる。
"""

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from app import clock, stores
from app.chat import config, guardrails
from app.chat import errors as _errors  # noqa: F401（固定の文を MESSAGES に足す）
from app.chat.context import TurnContext
from app.chat.model import ChatMessage
from app.db import connection
from app.errors import ApiError

log = logging.getLogger("shop_order.chat")


@dataclass
class Turn:
    """begin_turn の結果。agent が使う。"""

    ctx: TurnContext
    user_text: str  # 保存した発話（入力ガードで拒否したときは、伏せた文）
    refused: str | None  # 入力ガードの理由コード
    history: list[ChatMessage]
    lease_until: datetime
    started: float


def _cutoff(now: datetime) -> datetime:
    return now - timedelta(days=config.retention_days())


def _thread_view(conn: Connection, thread_id: str, user_id: int, now: datetime) -> dict[str, Any]:
    """利用者の、期限内のスレッド。無ければ（他人のもの・期限切れ・存在しない）404。"""
    row = conn.execute(
        "SELECT t.id, t.store_id, t.created_at, t.busy_until, s.name AS store_name FROM chat_threads t JOIN stores s ON s.id = t.store_id "
        "WHERE t.id = %s AND t.user_id = %s AND t.last_activity_at > %s",
        (thread_id, user_id, _cutoff(now)),
    ).fetchone()
    if row is None:
        raise ApiError(404, "not_found")
    return row


def _bump_usage(conn: Connection, user_id: int, now_local: datetime, column: str, limit: int) -> None:
    """利用者・日ごとの件数を 1 増やす。上限に達していれば 429。column は固定の 2 つだけ。"""
    assert column in ("messages", "threads")
    row = conn.execute(
        f"INSERT INTO chat_usage (user_id, usage_date, {column}) VALUES (%s, %s, 1) "  # noqa: S608（固定の列名）
        f"ON CONFLICT (user_id, usage_date) DO UPDATE SET {column} = chat_usage.{column} + 1 WHERE chat_usage.{column} < %s RETURNING {column}",
        (user_id, now_local.date(), limit),
    ).fetchone()
    if row is None:
        raise ApiError(429, "chat_rate_limited")


# ---- スレッド ----

def create_thread(user_id: int, store_id: int) -> dict[str, Any]:
    purge_expired()  # 期限切れのスレッドを、アクセスのついでに消す（worker が無くても、保存期間が守られる）
    now, local = clock.utc_now(), clock.local_now()
    with connection() as conn:
        store = stores.load(conn, store_id)
        if store is None:
            raise ApiError(404, "store_not_found")
        _bump_usage(conn, user_id, local, "threads", config.DAILY_THREADS_PER_USER)
        row = conn.execute(
            "INSERT INTO chat_threads (user_id, store_id, created_at, last_activity_at) VALUES (%s, %s, %s, %s) RETURNING id, created_at",
            (user_id, store_id, now, now),
        ).fetchone()
    return {"id": str(row["id"]), "store": {"id": store["id"], "name": store["name"]}, "created_at": clock.iso(row["created_at"])}


def get_thread(user_id: int, thread_id: str) -> dict[str, Any]:
    now = clock.utc_now()
    with connection() as conn:
        thread = _thread_view(conn, thread_id, user_id, now)
        messages = conn.execute(
            "SELECT id, role, content, cards, created_at FROM chat_messages WHERE thread_id = %s ORDER BY id LIMIT %s",
            (thread_id, config.THREAD_MAX_USER_MESSAGES * 2 + 2),
        ).fetchall()
    return {
        "id": str(thread["id"]), "store": {"id": thread["store_id"], "name": thread["store_name"]}, "created_at": clock.iso(thread["created_at"]),
        "messages": [{"id": m["id"], "role": m["role"], "content": m["content"], "cards": m["cards"], "created_at": clock.iso(m["created_at"])} for m in messages],
    }


def _delete_rows(conn: Connection, thread_ids: list[str]) -> None:
    """子から親へ（外部キーは RESTRICT）。"""
    conn.execute("DELETE FROM chat_tool_calls WHERE thread_id = ANY(%s::uuid[])", (thread_ids,))
    conn.execute("DELETE FROM chat_messages WHERE thread_id = ANY(%s::uuid[])", (thread_ids,))
    conn.execute("DELETE FROM chat_threads WHERE id = ANY(%s::uuid[])", (thread_ids,))


def delete_thread(user_id: int, thread_id: str) -> None:
    """利用者が自分のスレッドを消す（発話・ツール呼び出しの記録ごと）。応答を作っている途中（貸し出し中）は 409。"""
    now = clock.utc_now()
    with connection() as conn:
        thread = conn.execute(
            "SELECT id, busy_until FROM chat_threads WHERE id = %s AND user_id = %s AND last_activity_at > %s FOR UPDATE",
            (thread_id, user_id, _cutoff(now)),
        ).fetchone()
        if thread is None:
            raise ApiError(404, "not_found")
        if thread["busy_until"] is not None and thread["busy_until"] > now:
            raise ApiError(409, "chat_busy")
        _delete_rows(conn, [str(thread["id"])])


def purge_expired(limit: int = config.PURGE_BATCH) -> int:
    """保存期間を過ぎたスレッドを、子の行ごと消す。消した数を返す。応答中のものと、別のプロセスが扱っているものは飛ばす。"""
    now = clock.utc_now()
    with connection() as conn:
        rows = conn.execute(
            "SELECT id FROM chat_threads WHERE last_activity_at <= %s AND (busy_until IS NULL OR busy_until <= %s) "
            "ORDER BY last_activity_at LIMIT %s FOR UPDATE SKIP LOCKED",
            (_cutoff(now), now, limit),
        ).fetchall()
        ids = [str(r["id"]) for r in rows]
        if ids:
            _delete_rows(conn, ids)
    if ids:
        log.info("保存期間を過ぎた会話を %s 件、削除しました", len(ids))
    return len(ids)


# ---- ターン ----

def begin_turn(user_id: int, thread_id: str, text: str) -> Turn:
    """利用者の発話を受ける。貸し出し・上限・保存を 1 つのトランザクションで行う（失敗すれば全部戻る）。404 / 409 / 429 は、応答を始める前に返す。"""
    now, local = clock.utc_now(), clock.local_now()
    lease_until = now + timedelta(seconds=config.TURN_LEASE_SECONDS)
    refused = guardrails.check_input(text)
    stored = guardrails.REDACTED_USER_TEXT if refused else text  # 攻撃文は、後の入力に残さない
    with connection() as conn:
        thread = conn.execute(
            "UPDATE chat_threads SET busy_until = %s, last_activity_at = %s "
            "WHERE id = %s AND user_id = %s AND last_activity_at > %s AND (busy_until IS NULL OR busy_until <= %s) RETURNING id, store_id",
            (lease_until, now, thread_id, user_id, _cutoff(now), now),
        ).fetchone()
        if thread is None:
            exists = conn.execute(
                "SELECT 1 FROM chat_threads WHERE id = %s AND user_id = %s AND last_activity_at > %s", (thread_id, user_id, _cutoff(now))
            ).fetchone()
            raise ApiError(409, "chat_busy") if exists else ApiError(404, "not_found")
        sent = conn.execute("SELECT count(*) AS n FROM chat_messages WHERE thread_id = %s AND role = 'user'", (thread_id,)).fetchone()["n"]
        if sent >= config.THREAD_MAX_USER_MESSAGES:
            raise ApiError(409, "chat_thread_full")
        _bump_usage(conn, user_id, local, "messages", config.DAILY_MESSAGES_PER_USER)
        past = conn.execute(
            "SELECT role, content, cards FROM chat_messages WHERE thread_id = %s ORDER BY id DESC LIMIT %s", (thread_id, config.HISTORY_MESSAGES)
        ).fetchall()
        message_id = conn.execute(
            "INSERT INTO chat_messages (thread_id, role, content, guard, created_at) VALUES (%s, 'user', %s, %s, %s) RETURNING id",
            (thread_id, stored, refused, now),
        ).fetchone()["id"]
    history = [
        ChatMessage(m["role"], m["content"], meta={"card_kinds": [c.get("kind") for c in (m["cards"] or [])]} if m["role"] == "assistant" else {})
        for m in reversed(past)
    ]
    ctx = TurnContext(thread_id=str(thread["id"]), user_id=user_id, store_id=thread["store_id"], user_message_id=message_id)
    return Turn(ctx=ctx, user_text=stored, refused=refused, history=history, lease_until=lease_until, started=time.monotonic())


def finish_turn(turn: Turn, text: str, cards: list[dict[str, Any]], guard: str | None) -> int:
    """応答（ガード後の本文と、サーバーが作ったカード）を保存して、貸し出しを返す。アシスタントの発話の ID を返す。"""
    now = clock.utc_now()
    with connection() as conn:
        message_id = conn.execute(
            "INSERT INTO chat_messages (thread_id, role, content, cards, guard, created_at) VALUES (%s, 'assistant', %s, %s, %s, %s) RETURNING id",
            (turn.ctx.thread_id, text, Jsonb(cards), guard, now),
        ).fetchone()["id"]
        _release(conn, turn, now)
    return message_id


def release(turn: Turn) -> None:
    """応答を保存せずに、貸し出しを返す（切断・失敗）。何度呼んでもよい。"""
    with connection() as conn:
        _release(conn, turn, clock.utc_now())


def _release(conn: Connection, turn: Turn, now: datetime) -> None:
    # 自分が取った貸し出し（期限が同じ）のときだけ返す。期限が切れて別のターンが取っていれば、触らない
    conn.execute(
        "UPDATE chat_threads SET busy_until = NULL, last_activity_at = %s WHERE id = %s AND busy_until = %s",
        (now, turn.ctx.thread_id, turn.lease_until),
    )
