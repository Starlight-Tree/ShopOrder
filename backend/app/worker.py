"""worker: 30 秒ごとに、支払い期限を過ぎた注文を取り消して在庫の確保を戻す（orders.expire_stale）。

    python -m app.worker

API も、注文の読み取り・確定・スタッフの一覧の前に同じ処理を遅延で呼ぶので、worker が止まっても在庫は固まらない（worker は、誰も触らない注文を戻すため）。
複数の worker を動かしても、FOR UPDATE SKIP LOCKED で同じ注文を二重に戻さない。ログには件数だけを出す。
"""

import logging
import os
import signal
import threading

from app import orders
from app.db import close_pool, open_pool

log = logging.getLogger("oasis.worker")

INTERVAL_SECONDS = float(os.environ.get("WORKER_INTERVAL_SECONDS", "30"))


def run_once() -> int:
    """1 回の巡回。戻した注文の件数を返す。"""
    return orders.expire_stale()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    open_pool()
    log.info("worker を開始しました（%s 秒ごと）", INTERVAL_SECONDS)
    try:
        while not stop.is_set():
            try:
                run_once()
            except Exception as exc:  # 1 回の失敗で止めない。例外の本文（接続情報を含みうる）は出さず、種類だけ
                log.error("巡回に失敗しました（%s）", type(exc).__name__)
            stop.wait(INTERVAL_SECONDS)
    finally:
        close_pool()
        log.info("worker を停止しました")


if __name__ == "__main__":
    main()
