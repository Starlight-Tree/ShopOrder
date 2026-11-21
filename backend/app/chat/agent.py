"""ツールを呼ぶ会話のループ（素の Python。LangGraph・langchain は使わない）。

1 ターン（1 回の発話への応答）の流れ:

    入力ガード（begin_turn で済み。拒否なら固定の文を返して終わり）
    → ターンの先頭で get_cart を自動で 1 回（カートの最新をモデルに見せる。docs/chat.md）
    → モデルを呼ぶ ⇄ ツールを実行する（定義に無い名前・引数の誤り・書き込みの上限は、tools.execute が拒否する）
    → 出力ガード（確定の言い切り・ツール結果に無い価格・アレルギーの言い切り・プロンプトの漏洩を、固定の文に置き換える）
    → 発話とカードを保存して、貸し出しを返す

- モデルが返す文は、全文をガードしてから、利用者に流す（ガードを通っていない文は、画面に出ない）。
- カードは、ツールの結果（サーバーが DB から作った値）だけから作る。モデルの文章からは作らない（確定ボタンは、確認カードにだけ付く）。
- 上限: モデルを呼ぶ回数・ツールの呼び出し回数・書き込みの回数（config.py）。超えたら、固定の文で止める。
- 切断（cancel）は、ステップの間で見る。切れたら、応答を保存せずに止める（ツールの書き込みは、1 つずつ commit 済みで、矛盾は残らない）。
- ログには、種類と件数だけを出す（発話・商品・注文の中身を出さない）。
"""

import logging
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from app.chat import config, guardrails, service, tools
from app.chat import model as model_module
from app.chat.context import TurnContext
from app.chat.model import ChatMessage, ToolCall
from app.chat.prompt import SYSTEM_PROMPT

log = logging.getLogger("oasis.chat")


@dataclass(frozen=True)
class Event:
    """利用者へ流すイベント。type: text / tool_call / tool_result / card / done。"""

    type: str
    data: dict[str, Any] = field(default_factory=dict)


def _compact_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """保存するカード。カートのカードは、最後の 1 枚だけ（途中の状態は、後の状態に置き換わる）。"""
    last_cart = max((i for i, c in enumerate(cards) if c.get("kind") == "cart"), default=-1)
    return [c for i, c in enumerate(cards) if c.get("kind") != "cart" or i == last_cart]


class _Run:
    """1 ターンの状態（会話・集めた数字・カード・ガードの理由）。"""

    def __init__(self, ctx: TurnContext, messages: list[ChatMessage]) -> None:
        self.ctx = ctx
        self.messages = messages
        self.allowed: set[int] = set()  # このターンのツール結果に出た整数（価格・合計の検査の「許す値」）
        self.cards: list[dict[str, Any]] = []
        self.texts: list[str] = []
        self.guards: list[str] = []
        self.steps = 0
        self.tool_names: list[str] = []

    def next_call_id(self, offset: int = 0) -> str:
        return f"m{self.ctx.user_message_id}-{self.ctx.tool_calls + 1 + offset}"

    def call_tool(self, call: ToolCall, *, auto: bool) -> Iterator[Event]:
        yield Event("tool_call", {"id": call.id, "name": call.name, "args": call.args, "auto": auto})
        result = tools.execute(self.ctx, call)
        self.tool_names.append(call.name)
        self.allowed |= guardrails.numbers_in(result.payload)
        self.messages.append(
            ChatMessage("tool", tools.wrap_untrusted(call.name, result.payload), tool_call_id=call.id, name=call.name, data=result.payload)
        )
        yield Event("tool_result", {"id": call.id, "name": call.name, "ok": result.ok, "summary": result.summary, "error": result.payload.get("error")})
        if not auto:  # ターンの先頭の get_cart は、画面にカードを出さない（モデルに見せるためだけ）
            for card in result.cards:
                self.cards.append(card)
                yield Event("card", {"card": card})

    def say(self, text: str, reason: str | None = None) -> Iterator[Event]:
        self.texts.append(text)
        if reason:
            self.guards.append(reason)
        yield Event("text", {"text": text})


def run_turn(turn: service.Turn, cancel: threading.Event | None = None) -> Iterator[Event]:
    """1 ターンを実行して、利用者へ流すイベントを返す。最後に、保存した応答の ID を持つ done を返す（切断のときは返さない）。"""
    cancel = cancel or threading.Event()
    ctx = turn.ctx
    if turn.refused:
        run = _Run(ctx, [])
        yield from run.say(guardrails.INPUT_REFUSAL_REPLY, turn.refused)
        log.info("入力ガードで拒否しました（thread=%s, reason=%s）", ctx.thread_id, turn.refused)
        yield _finish(turn, run)
        return

    model = model_module.get_model()
    run = _Run(ctx, [ChatMessage("system", SYSTEM_PROMPT), *turn.history, ChatMessage("user", turn.user_text)])
    specs = tools.specs()

    # ターンの先頭: カートの最新を、サーバーが読み直して、モデルに渡す
    first = ToolCall(run.next_call_id(), "get_cart", {})
    run.messages.append(ChatMessage("assistant", tool_calls=(first,)))
    yield from run.call_tool(first, auto=True)

    finished = False
    for _ in range(config.MAX_MODEL_STEPS):
        if cancel.is_set():
            _log_end(turn, run, "cancelled")
            return
        run.steps += 1
        try:
            reply = model.reply(run.messages, specs)
        except Exception as exc:  # 例外の本文は出さない（種類だけ）
            log.error("モデルの呼び出しに失敗しました（%s, thread=%s）", type(exc).__name__, ctx.thread_id)
            yield from run.say(guardrails.FAILURE_REPLY, "model_error")
            finished = True
            break
        text = (reply.text or "").strip()
        if text:
            verdict = guardrails.check_output(text, run.allowed, SYSTEM_PROMPT)
            yield from run.say(verdict.text, verdict.reason)
            text = verdict.text
        if not reply.tool_calls:
            finished = True
            break
        # モデルの返した呼び出しに、こちらの ID を付ける（(thread_id, tool_call_id) の冪等のため。モデルの ID には頼らない）。上限を超える分は実行しない
        room = max(0, config.MAX_TOOL_CALLS_PER_TURN - ctx.tool_calls)
        calls = [ToolCall(run.next_call_id(k), c.name, c.args if isinstance(c.args, dict) else {}) for k, c in enumerate(reply.tool_calls[:room])]
        over = len(reply.tool_calls) > room
        if calls:
            run.messages.append(ChatMessage("assistant", text, tool_calls=tuple(calls)))
        for call in calls:
            if cancel.is_set():
                _log_end(turn, run, "cancelled")
                return
            yield from run.call_tool(call, auto=False)
        if over:
            yield from run.say(guardrails.LIMIT_REPLY, "tool_call_limit")
            finished = True
            break
    if not finished:
        yield from run.say(guardrails.LIMIT_REPLY, "model_step_limit")
    if not run.texts:
        yield from run.say(guardrails.EMPTY_REPLY, "empty_reply")
    yield _finish(turn, run)


def _finish(turn: service.Turn, run: _Run) -> Event:
    text = "\n".join(run.texts)
    guard = ",".join(dict.fromkeys(run.guards)) or None
    message_id = service.finish_turn(turn, text, _compact_cards(run.cards), guard)
    _log_end(turn, run, "ok", guard)
    return Event("done", {"message_id": message_id, "guard": guard})


def _log_end(turn: service.Turn, run: _Run, status: str, guard: str | None = None) -> None:
    log.info(
        "チャットのターン thread=%s status=%s steps=%s tools=%s writes=%s guard=%s ms=%s",
        turn.ctx.thread_id, status, run.steps, turn.ctx.tool_calls, turn.ctx.writes, guard, int((time.monotonic() - turn.started) * 1000),
    )
