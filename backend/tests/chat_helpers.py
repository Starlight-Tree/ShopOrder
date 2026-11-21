"""チャットのテストの道具。SSE の応答を読み、スレッドを作り、発話を送る（API は TestClient 経由。DB の確認だけ別の接続）。"""

import json
from dataclasses import dataclass, field


@dataclass
class Reply:
    status: int
    chunks: list[dict] = field(default_factory=list)
    keepalives: int = 0
    done: bool = False  # [DONE] を受けた
    body: dict | None = None  # SSE でない応答（エラー）の JSON

    @property
    def text(self) -> str:
        return "".join(c["delta"] for c in self.chunks if c["type"] == "text-delta")

    @property
    def tools(self) -> list[str]:
        return [c["toolName"] for c in self.chunks if c["type"] == "tool-input-available"]

    @property
    def tool_inputs(self) -> list[tuple[str, dict]]:
        return [(c["toolName"], c["input"]) for c in self.chunks if c["type"] == "tool-input-available"]

    @property
    def outputs(self) -> dict[str, dict]:
        return {c["toolCallId"]: c["output"] for c in self.chunks if c["type"] == "tool-output-available"}

    @property
    def cards(self) -> list[dict]:
        return [c["data"] for c in self.chunks if c["type"] == "data-card"]

    def cards_of(self, kind: str) -> list[dict]:
        return [c for c in self.cards if c["kind"] == kind]

    @property
    def types(self) -> list[str]:
        return [c["type"] for c in self.chunks]

    @property
    def finish(self) -> dict | None:
        return next((c for c in self.chunks if c["type"] == "finish"), None)


def parse_sse(response) -> Reply:
    reply = Reply(status=response.status_code)
    if "text/event-stream" not in response.headers.get("content-type", ""):
        reply.body = response.json() if response.content else None
        return reply
    for block in response.text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        if block.startswith(":"):
            reply.keepalives += 1
        elif block == "data: [DONE]":
            reply.done = True
        elif block.startswith("data: "):
            reply.chunks.append(json.loads(block[len("data: "):]))
    return reply


class Chat:
    """1 人の利用者の、1 つのスレッド。"""

    def __init__(self, client, headers: dict, store_id: int):
        self.client = client
        self.headers = headers
        r = client.post("/api/chat/threads", json={"store_id": store_id}, headers=headers)
        assert r.status_code == 201, r.text
        self.thread = r.json()
        self.id = self.thread["id"]

    def say(self, content: str) -> Reply:
        r = self.client.post(f"/api/chat/threads/{self.id}/messages", json={"content": content}, headers=self.headers)
        return parse_sse(r)

    def history(self):
        return self.client.get(f"/api/chat/threads/{self.id}", headers=self.headers)

    def cart(self) -> dict:
        return self.client.get("/api/cart", headers=self.headers).json()


# ---- 偽のモデル（台本どおりに答える）と、ツールを直接呼ぶための文脈 ----

class ScriptedModel:
    """テスト用の偽の ChatModel。script は ModelReply か、（messages を受けて ModelReply を返す）関数の並び。使い切ったら、短い終わりの文を返す。"""

    name = "scripted"

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0
        self.seen: list = []

    def reply(self, messages, tools):
        from app.chat.model import ModelReply

        self.seen.append(list(messages))
        step = self.script[self.calls] if self.calls < len(self.script) else ModelReply(text="おわりました。")
        self.calls += 1
        return step(messages) if callable(step) else step


def say(text: str):
    from app.chat.model import ModelReply

    return ModelReply(text=text)


def call(name: str, **args):
    """ツール呼び出し 1 件（ID は agent が付け直す）。"""
    from app.chat.model import ModelReply, ToolCall

    return ModelReply(tool_calls=(ToolCall("x", name, args),))


def make_turn(shop, headers: dict, store_code: str, text: str = "テスト"):
    """ツールを直接呼ぶための、ターンの文脈（スレッドを作り、発話を 1 件保存した状態）。終わったら service.release(turn)。"""
    from app.chat import service

    shop.client.get("/api/cart", headers=headers)  # 利用者を作る
    with shop.db() as conn:
        user_id = conn.execute("SELECT id FROM users WHERE auth_user_id = %s", ("dev:" + headers["X-Dev-User"],)).fetchone()["id"]
    thread = service.create_thread(user_id, shop.store_id(store_code))
    return service.begin_turn(user_id, thread["id"], text)
