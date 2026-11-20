import os

import pytest

# TEST_DATABASE_URL が無ければ、Postgres が要るテストは飛ばす（使い捨ての Postgres の、管理用の URL を渡す）
TEST_URL = os.environ.get("TEST_DATABASE_URL")


def new_database(name: str) -> str:
    """空の DB を作り直して、その URL を返す。"""
    import psycopg

    admin = psycopg.connect(TEST_URL, autocommit=True)
    admin.execute(f'DROP DATABASE IF EXISTS "{name}"')
    admin.execute(f'CREATE DATABASE "{name}"')
    admin.close()
    return TEST_URL.rsplit("/", 1)[0] + "/" + name


@pytest.fixture(scope="session")
def client():
    if not TEST_URL:
        pytest.skip("TEST_DATABASE_URL が未設定です")
    from fastapi.testclient import TestClient

    test_url = new_database("oasis_test")
    os.environ["DATABASE_URL"] = test_url
    from app import migrate, seed_demo

    assert migrate.apply(test_url, out=lambda *_: None) == 0
    seed_demo.main(reset=True)
    from app.main import app

    with TestClient(app) as c:
        yield c
