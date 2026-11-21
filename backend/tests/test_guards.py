"""DB を作り直す前の検査（tests/guards.py）。DB には繋がない（TEST_DATABASE_URL が無くても流れる）。"""

import pytest

from tests.guards import assert_disposable_target

OK_URL = "postgresql://postgres@test-db:5432/postgres"


@pytest.mark.parametrize(
    "url",
    [
        OK_URL,
        "postgresql://postgres@localhost:55432/postgres",
        "postgres://postgres@127.0.0.1:5432/postgres",
        "postgresql://postgres@[::1]:5432/postgres",
        "postgresql://postgres:secret@TEST-DB/postgres",  # ホスト名は大文字小文字を区別しない
    ],
)
def test_disposable_hosts_pass(url):
    assert_disposable_target(url, "shop_order_test")


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://shoporder@db:5432/shoporder",  # 開発用の DB（compose の db）
        "postgresql://postgres@shoporder-db:5432/postgres",
        "postgresql://postgres@db.example.com:5432/postgres",  # 外のサーバー
        "postgresql://postgres@test-db.evil.example/postgres",  # 前方一致では通さない
        "postgresql://postgres@test-db,db:5432/postgres",  # 複数ホスト
        "postgresql:///postgres",  # ホスト無し（PGHOST などの環境に任せる形）
        "postgresql://postgres@test-db/postgres?host=db",  # 問い合わせ部での接続先の上書き
        "postgresql://postgres@test-db/postgres?hostaddr=10.0.0.5",
        "postgresql://postgres@test-db/postgres?service=prod",
        "mysql://root@test-db/postgres",
        "host=db dbname=postgres",  # libpq のキー・値の形は受け付けない
        "",
        None,
    ],
)
def test_other_servers_are_refused(url):
    with pytest.raises(RuntimeError):
        assert_disposable_target(url, "shop_order_test")


@pytest.mark.parametrize(
    "name",
    ["shop_order_test", "shop_order_analytics_api", "shop_order_migrate_a", "shop_order_eval", "shop_order_ledger_test"],
)
def test_test_database_names_pass(name):
    assert_disposable_target(OK_URL, name)


@pytest.mark.parametrize(
    "name",
    [
        "shoporder",  # 開発用の DB
        "postgres",
        "template1",
        "shop_order",  # 接頭辞だけ（末尾が無い）
        "Shop_Order_test",  # 大文字
        'shop_order_x"; DROP DATABASE shoporder; --',  # 引用符の外へ出る名前
        "shop_order_a b",
        "shop_order_",
        "",
    ],
)
def test_other_database_names_are_refused(name):
    with pytest.raises(RuntimeError):
        assert_disposable_target(OK_URL, name)


def test_error_message_does_not_leak_the_password():
    with pytest.raises(RuntimeError) as e:
        assert_disposable_target("postgresql://postgres:s3cret-pass@db.example.com/postgres", "shop_order_test")
    assert "s3cret-pass" not in str(e.value)
