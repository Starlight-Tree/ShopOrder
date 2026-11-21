import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.guards import assert_disposable_target

# TEST_DATABASE_URL が無ければ、Postgres が要るテストは飛ばす（使い捨ての Postgres の、管理用の URL を渡す）
TEST_URL = os.environ.get("TEST_DATABASE_URL")


def new_database(name: str) -> str:
    """空の DB を作り直して、その URL を返す。消す前に、接続先（使い捨てのサーバーだけ）と DB 名（shop_order_*）を完全一致で検査する。"""
    import psycopg

    assert_disposable_target(TEST_URL, name)
    admin = psycopg.connect(TEST_URL, autocommit=True)
    admin.execute(f'DROP DATABASE IF EXISTS "{name}"')
    admin.execute(f'CREATE DATABASE "{name}"')
    admin.close()
    return TEST_URL.rsplit("/", 1)[0] + "/" + name


@pytest.fixture(autouse=True)
def _dev_defaults(monkeypatch):
    """既定: 営業時間は見ない（開発の便宜。docker-compose.yml と同じ）。見るテストは、monkeypatch.setenv('ORDER_HOURS_CHECK', 'on') で戻す。時計は、毎回、実時間へ戻す。"""
    from app import clock

    monkeypatch.setenv("ORDER_HOURS_CHECK", "off")
    monkeypatch.setenv("APP_ENV", "test")  # 開発専用の設定（AUTH_MODE=dev など）は、development / test と明示された環境だけで許す
    monkeypatch.delenv("AUTH_MODE", raising=False)
    monkeypatch.delenv("LOCAL_UTC_OFFSET_HOURS", raising=False)
    yield
    clock.freeze(None)


@pytest.fixture(scope="session")
def client():
    if not TEST_URL:
        pytest.skip("TEST_DATABASE_URL が未設定です")
    from fastapi.testclient import TestClient

    test_url = new_database("shop_order_test")
    os.environ["DATABASE_URL"] = test_url
    os.environ["DEMO_STAFF_PASSWORD"] = "test-staff-pass"
    os.environ["APP_ENV"] = "test"  # セッションの fixture は、関数単位の _dev_defaults より先に動く。lifespan の起動検査（許可リスト）を通すため
    from app import migrate, seed_demo

    assert migrate.apply(test_url, out=lambda *_: None) == 0
    seed_demo.main(reset=True)
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def shop(client):
    from tests.helpers import Shop

    return Shop(client, os.environ["DATABASE_URL"])


def at_local(year: int, month: int, day: int, hour: int, minute: int = 0, second: int = 0, offset_hours: int = 9) -> datetime:
    """店のローカル時刻（既定 UTC+9）を、タイムゾーンつきの日時にする（clock.freeze に渡す）。"""
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone(timedelta(hours=offset_hours)))


def unique_name(prefix: str = "t") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"
