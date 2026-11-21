"""POST /api/chat/threads/{id}/messages の応答（SSE。AI SDK の UI message stream v1 に寄せた形）の組み立て。

形式: `text/event-stream`。1 チャンクは `data: <JSON>` の行と空行で、最後に `data: [DONE]`。イベントが無い間は、コメント行 `: ping` を送る。
ヘッダー `x-vercel-ai-ui-message-stream: v1` を付ける（フロントは、まだ作らない）。ここは純粋な変換で、DB もモデルも知らない。

チャンクの並び（正常時）:

    start（messageId、messageMetadata = {thread_id}）
    [ターンの先頭] tool-input-available / tool-output-available（get_cart。toolName = get_cart、auto = true）
    [モデルの文があれば] text-start → text-delta … → text-end
    [ツール呼び出しごと] tool-input-available（toolCallId, toolName, input）→ tool-output-available（toolCallId, output = {ok, summary, error?}）
        → data-card（data = {kind: products | cart | confirm | orders | order, ...}。サーバーがツールの結果から作る）
    finish（messageMetadata = {message_id, guard}）
    [DONE]

- 本文は、ガードを通った全文だけが流れる（text-delta は、全文を TEXT_CHUNK_CHARS ごとに分けたもの）。置き換えは、本文の前に済んでいる。
- 失敗のときは `error`（errorText。固定の文）を送って [DONE]。切断は失敗ではない（サーバーは止めるだけ）。
- ツールの出力（tool-output-available）は、要約だけ（結果の中身は、カードで出す）。
"""

import json
from typing import Any

from app.chat import config
from app.chat.agent import Event

UI_STREAM_HEADERS = {
    "x-vercel-ai-ui-message-stream": "v1",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",  # nginx 系のプロキシに、応答を溜めずにそのまま流させる
}
DONE = b"data: [DONE]\n\n"
KEEPALIVE = b": ping\n\n"  # SSE のコメント行。クライアントは無視する。無通信でプロキシに切られないようにする


def encode(chunk: dict[str, Any]) -> bytes:
    payload = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
    return f"data: {payload}\n\n".encode()


class UIMessageStream:
    def __init__(self, message_id: str, thread_id: str) -> None:
        self._message_id = message_id
        self._thread_id = thread_id
        self._parts = 0

    def start(self) -> list[dict[str, Any]]:
        return [{"type": "start", "messageId": self._message_id, "messageMetadata": {"thread_id": self._thread_id}}]

    def feed(self, event: Event) -> list[dict[str, Any]]:
        d = event.data
        if event.type == "text":
            part_id = f"text-{self._parts}"
            self._parts += 1
            text = d["text"]
            deltas = [text[i : i + config.TEXT_CHUNK_CHARS] for i in range(0, len(text), config.TEXT_CHUNK_CHARS)]
            return [
                {"type": "text-start", "id": part_id},
                *({"type": "text-delta", "id": part_id, "delta": delta} for delta in deltas),
                {"type": "text-end", "id": part_id},
            ]
        if event.type == "tool_call":
            return [{"type": "tool-input-available", "toolCallId": d["id"], "toolName": d["name"], "input": d["args"], "providerMetadata": {"shopOrder": {"auto": d["auto"]}}}]
        if event.type == "tool_result":
            output = {"ok": d["ok"], "summary": d["summary"]}
            if d.get("error"):
                output["error"] = d["error"]
            return [{"type": "tool-output-available", "toolCallId": d["id"], "output": output}]
        if event.type == "card":
            return [{"type": "data-card", "data": d["card"]}]
        return []

    def finish(self, event: Event | None = None) -> list[dict[str, Any]]:
        meta = {"message_id": event.data.get("message_id"), "guard": event.data.get("guard")} if event is not None else {}
        return [{"type": "finish", "messageMetadata": meta}]

    def error(self, text: str) -> list[dict[str, Any]]:
        return [{"type": "error", "errorText": text}]
