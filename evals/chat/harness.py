"""会話を流して、評価器に渡す記録（Trace）を作る。API は TestClient 経由（本番と同じ SSE の経路）。DB は、監査の読み取りと準備だけ。"""

from datetime import datetime, timedelta, timezone

from app import clock
from evals.chat.evaluators import Trace, TurnTrace
from tests.chat_helpers import Chat


def run_conversation(shop, headers: dict, store_code: str, utterances: list[str]) -> tuple[Trace, Chat]:
    chat = Chat(shop.client, headers, shop.store_id(store_code))
    replies = [(u, chat.say(u)) for u in utterances]
    return build_trace(shop, headers, chat, replies), chat


def build_trace(shop, headers: dict, chat: Chat, replies) -> Trace:
    with shop.db() as conn:
        user_ids = [r["id"] for r in conn.execute("SELECT id FROM chat_messages WHERE thread_id = %s AND role = 'user' ORDER BY id", (chat.id,)).fetchall()]
        audit = conn.execute("SELECT message_id, name, args, status, result FROM chat_tool_calls WHERE thread_id = %s ORDER BY id", (chat.id,)).fetchall()
        orders = conn.execute(
            "SELECT count(*) AS n FROM orders o JOIN users u ON u.id = o.user_id WHERE u.auth_user_id = %s", ("dev:" + headers["X-Dev-User"],)
        ).fetchone()["n"]
    turns = []
    for i, (utterance, reply) in enumerate(replies):
        rows = [a for a in audit if i < len(user_ids) and a["message_id"] == user_ids[i]]
        guard = (reply.finish or {}).get("messageMetadata", {}).get("guard")
        turns.append(TurnTrace(
            utterance=utterance, status=reply.status, tools=reply.tools, text=reply.text, cards=reply.cards, guard=guard,
            results=[a["result"] for a in rows if a["result"] is not None], audit=[{"name": a["name"], "status": a["status"], "args": a["args"]} for a in rows],
        ))
    return Trace(turns=turns, cart=chat.cart(), orders=orders, store_name=chat.thread["store"]["name"])


def run_replies(shop, headers: dict, chat: Chat, utterances: list[str]) -> Trace:
    """既にあるスレッドで、続けて発話する（偽のモデルを差した後など）。"""
    return build_trace(shop, headers, chat, [(u, chat.say(u)) for u in utterances])


# ---- 準備（golden の setup）----

PAST_ORDERS = [  # 古い順。いちばん新しいのが A。候補は、A（2 回）・C・B の順になる
    ("A", [("oasis-blend", "M", "hot", 2)]),
    ("B", [("cafe-latte", "L", "ice", 1), ("hot-sandwich", "-", "-", 1)]),
    ("C", [("americano", "S", "hot", 1)]),
    ("A", [("oasis-blend", "M", "hot", 2)]),
]


def apply_setup(name: str | None, shop, headers: dict, monkeypatch):
    """準備を行い、元に戻す関数を返す。"""
    if name is None:
        return lambda: None
    if name == "past_orders":
        for _, items in PAST_ORDERS:
            shop.paid_order(headers, "residential-main", [(shop.variant(code, size, temp), qty) for code, size, temp, qty in items])  # 未払いの上限（2 件）に当たらないよう、払っておく
        return lambda: None
    if name == "one_order":
        shop.order(headers, "residential-main", [(shop.variant("cheesecake"), 1)])
        return lambda: None
    if name == "sold_out_gateau":
        on_hand, reserved = shop.balance("rock-lookout", "gateau-chocolat")
        shop.set_available("rock-lookout", "gateau-chocolat", 0)
        return lambda: shop.set_available("rock-lookout", "gateau-chocolat", on_hand - reserved)
    if name == "after_hours":
        monkeypatch.setenv("ORDER_HOURS_CHECK", "on")
        clock.freeze(datetime(2026, 11, 18, 23, 0, tzinfo=timezone(timedelta(hours=9))))  # 居住区本店は 21:00 閉店
        return lambda: clock.freeze(None)
    raise ValueError(name)


def expected_orders(setup: str) -> int:
    """準備で作った注文の数（会話の前の数。会話の中で増えてはいけない）。"""
    return {"past_orders": len(PAST_ORDERS), "one_order": 1}[setup]
