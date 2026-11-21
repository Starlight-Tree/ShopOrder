"""掃除（worker から呼ぶ）。期限切れ・使用済みの行を消して、表が増え続けないようにする。ログには件数だけを出す。

- checkout_proposals: 期限を過ぎて 1 日たったもの、使用済みで 1 日たったもの（提案は 10 分で無効。照会・監査の猶予に 1 日）。
- staff_login_attempts: 1 日より古い試行（制限の窓は 15 分）。
- staff_sessions: 期限切れ。
2026-11-21 の読み取りレビューで、ログインのたびの全件走査の DELETE と、提案の増え続けを指摘された（ログインの経路から外した）。
"""

import logging
from datetime import timedelta

from app import clock
from app.db import connection

log = logging.getLogger("shop_order.sweep")

KEEP = timedelta(days=1)


def run() -> int:
    """掃除を 1 回行い、消した行の合計を返す。"""
    cutoff = clock.utc_now() - KEEP
    now = clock.utc_now()
    with connection() as conn:
        proposals = conn.execute(
            "DELETE FROM checkout_proposals WHERE (used_at IS NOT NULL AND used_at < %s) OR expires_at < %s", (cutoff, cutoff)
        ).rowcount
        attempts = conn.execute("DELETE FROM staff_login_attempts WHERE at < %s", (cutoff,)).rowcount
        sessions = conn.execute("DELETE FROM staff_sessions WHERE expires_at < %s", (now,)).rowcount
    total = proposals + attempts + sessions
    if total:
        log.info("掃除: 提案 %s・ログイン試行 %s・セッション %s", proposals, attempts, sessions)
    return total
