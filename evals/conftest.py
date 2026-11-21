"""評価の共通の準備。使い捨ての Postgres（TEST_DATABASE_URL。管理用の URL）に、評価専用の DB を作り直して、API を起動する（模擬のモデル・実 API なし）。"""

import os

import pytest

TEST_URL = os.environ.get("TEST_DATABASE_URL")
EVAL_DB = "shop_order_eval"


def _new_database(name: str) -> str:
    import psycopg

    admin = psycopg.connect(TEST_URL, autocommit=True)
    admin.execute(f'DROP DATABASE IF EXISTS "{name}"')
    admin.execute(f'CREATE DATABASE "{name}"')
    admin.close()
    return TEST_URL.rsplit("/", 1)[0] + "/" + name


@pytest.fixture(autouse=True)
def _eval_defaults(monkeypatch):
    """既定: 営業時間は見ない（開発の便宜。docker-compose.yml と同じ）。見る評価は、自分で戻す。時計は、毎回、実時間へ戻す。"""
    from app import clock

    monkeypatch.setenv("ORDER_HOURS_CHECK", "off")
    monkeypatch.setenv("APP_ENV", "test")  # 開発専用の設定（AUTH_MODE=dev など）は、development / test と明示された環境だけで許される
    for name in ("AUTH_MODE", "LOCAL_UTC_OFFSET_HOURS", "CHAT_MODEL", "CHAT_RETENTION_DAYS"):
        monkeypatch.delenv(name, raising=False)
    yield
    clock.freeze(None)


@pytest.fixture(scope="session")
def client():
    if not TEST_URL:
        pytest.skip("TEST_DATABASE_URL が未設定です")
    from fastapi.testclient import TestClient

    url = _new_database(EVAL_DB)
    os.environ["APP_ENV"] = "test"  # セッションの fixture は、関数単位の _eval_defaults より先に動く（lifespan の起動検査を通すため）
    os.environ["DEMO_DATA"] = "allow"
    os.environ["DATABASE_URL"] = url
    os.environ["DEMO_STAFF_PASSWORD"] = "eval-staff-pass"
    from app import migrate, seed_demo

    assert migrate.apply(url, out=lambda *_: None) == 0
    seed_demo.main(reset=True)
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def shop(client):
    from tests.helpers import Shop

    return Shop(client, os.environ["DATABASE_URL"])
