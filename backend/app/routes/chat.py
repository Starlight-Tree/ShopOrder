"""チャット（P3）の API。利用者はセッション（CustomerDep）から決め、スレッドは、いつもその利用者のものだけ（他人のものは 404）。

AI は、カートの下書きと確認カードまでしか作れない。注文の確定は、画面の確定ボタン → POST /api/orders だけ（docs/decisions/0003）。
"""

import asyncio
import logging
import threading
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Path, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse

from app.auth import CustomerDep
from app.chat import agent, config, guardrails, service, stream
from app.chat import errors as _errors  # noqa: F401（固定の文を MESSAGES に足す）
from app.chat.schemas import MessageBody, Thread, ThreadCreate, ThreadDetail

log = logging.getLogger("oasis.chat")
router = APIRouter(prefix="/api/chat", tags=["chat"])
ThreadId = Path(description="スレッドの ID（uuid）")


@router.post("/threads", response_model=Thread, status_code=201)
def create_thread(body: ThreadCreate, customer: CustomerDep) -> dict[str, Any]:
    return service.create_thread(customer.id, body.store_id)


@router.get("/threads/{thread_id}", response_model=ThreadDetail)
def get_thread(customer: CustomerDep, thread_id: uuid.UUID = ThreadId) -> dict[str, Any]:
    return service.get_thread(customer.id, str(thread_id))


@router.delete("/threads/{thread_id}", status_code=204)
def delete_thread(customer: CustomerDep, thread_id: uuid.UUID = ThreadId) -> Response:
    service.delete_thread(customer.id, str(thread_id))
    return Response(status_code=204)


async def _events(turn: service.Turn, request: Request) -> AsyncIterator[bytes]:
    """SSE の本体。ターンは別のスレッドで動かし（モデル・DB は同期）、イベントを待つ間は、一定の間隔で ping を送る。"""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[agent.Event | None | BaseException] = asyncio.Queue()
    cancel = threading.Event()

    def produce() -> None:
        try:
            for event in agent.run_turn(turn, cancel):
                loop.call_soon_threadsafe(queue.put_nowait, event)
        except BaseException as exc:  # noqa: BLE001（例外は、種類だけログに残して、固定の文で伝える）
            log.error("チャットのターンが失敗しました（%s, thread=%s）", type(exc).__name__, turn.ctx.thread_id)
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            try:
                service.release(turn)  # 保存済みなら何もしない。切断・失敗のときは、貸し出しを返す
            except Exception as exc:  # noqa: BLE001
                log.error("貸し出しを返せませんでした（%s）。期限で外れます", type(exc).__name__)
            loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, produce)
    ui = stream.UIMessageStream(str(uuid.uuid4()), turn.ctx.thread_id)
    try:
        for chunk in ui.start():
            yield stream.encode(chunk)
        done: agent.Event | None = None
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=config.KEEPALIVE_SECONDS)
            except TimeoutError:
                yield stream.KEEPALIVE
                continue
            if item is None:
                break
            if isinstance(item, BaseException):
                for chunk in ui.error(guardrails.FAILURE_REPLY):
                    yield stream.encode(chunk)
                yield stream.DONE
                return
            if item.type == "done":
                done = item
                continue
            for chunk in ui.feed(item):
                yield stream.encode(chunk)
        for chunk in ui.finish(done):
            yield stream.encode(chunk)
        yield stream.DONE
    finally:
        cancel.set()  # 切断（キャンセル・クローズ）のときは、ターンをステップの間で止める。正常終了なら、すでに終わっている


@router.post(
    "/threads/{thread_id}/messages",
    response_class=StreamingResponse,
    responses={200: {"description": "AI SDK の UI message stream（SSE）", "content": {"text/event-stream": {}}}},
)
async def post_message(body: MessageBody, request: Request, customer: CustomerDep, thread_id: uuid.UUID = ThreadId) -> StreamingResponse:
    """利用者の発話を受けて、応答を SSE で返す。貸し出し・上限・保存（404 / 409 / 429）は、応答を始める前に HTTP で返す。"""
    turn = await run_in_threadpool(service.begin_turn, customer.id, str(thread_id), body.content)
    return StreamingResponse(_events(turn, request), media_type="text/event-stream", headers=stream.UI_STREAM_HEADERS)
