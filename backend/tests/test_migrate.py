import os

import psycopg
import pytest

from app import migrate
from tests.conftest import TEST_URL, new_database

pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL が未設定です")


def _run(url, **kw):
    lines: list[str] = []
    code = migrate.apply(url, out=lines.append, **kw)
    return code, lines


def _all_versions():
    return [v for v, _, _ in migrate.migration_files()]


def _next_number(skip: int = 0) -> str:
    """今あるマイグレーションの、次の番号（skip = 飛ばす数）。マイグレーションが増えても、番号の決め打ちで壊れないように、数えて決める。"""
    return f"{len(_all_versions()) + 1 + skip:04d}"


def _tables(url):
    with psycopg.connect(url) as conn:
        return {r[0] for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}


def test_new_database_gets_all_migrations_and_rerun_is_a_noop():
    url = new_database("shop_order_migrate_a")
    code, _ = _run(url)
    assert code == 0
    assert {"areas", "stores", "menu_items", "menu_variants", "schema_migrations"} <= _tables(url)
    assert {"stock_items", "stock_balances", "stock_movements", "users", "carts", "staff_accounts", "orders", "order_events", "payments"} <= _tables(url)
    with psycopg.connect(url) as conn:
        assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY 1")] == _all_versions()
    code, lines = _run(url)
    assert code == 0 and any("未適用: なし" in line for line in lines)


def test_dry_run_changes_nothing():
    url = new_database("shop_order_migrate_b")
    code, lines = _run(url, dry_run=True)
    assert code == 0 and any("0001_stores_and_menu" in line and "0004_orders" in line for line in lines)
    assert "schema_migrations" not in _tables(url)


def test_a_changed_applied_file_stops_the_run(tmp_path, monkeypatch):
    import shutil

    url = new_database("shop_order_migrate_c")
    assert _run(url)[0] == 0
    work = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, work)
    target = next(work.glob("0001_*.sql"))
    target.write_text(target.read_text(encoding="utf-8") + "\n-- 書き換え\n", encoding="utf-8")
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", work)
    code, lines = _run(url)
    assert code == 1 and any("書き換えられています" in line for line in lines)


def test_failed_migration_rolls_back_and_is_not_recorded(tmp_path, monkeypatch):
    import shutil

    url = new_database("shop_order_migrate_d")
    real_versions = _all_versions()  # monkeypatch の前の、本物のマイグレーション
    work = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, work)
    (work / f"{_next_number()}_broken.sql").write_text("CREATE TABLE half_done (id int);\nSELECT 1/0;\n", encoding="utf-8")
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", work)
    with pytest.raises(psycopg.errors.DivisionByZero):
        _run(url)
    assert "half_done" not in _tables(url)  # 途中までの変更は残らない
    with psycopg.connect(url) as conn:
        # 既存のマイグレーションは、それぞれ 1 ファイル 1 トランザクションで記録済み。壊れた次の番号のファイルだけが記録されない
        assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY 1")] == real_versions


def test_drop_and_truncate_are_refused(tmp_path, monkeypatch):
    import shutil

    url = new_database("shop_order_migrate_e")
    work = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, work)
    (work / f"{_next_number()}_bad.sql").write_text("DROP TABLE stores;\n", encoding="utf-8")
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", work)
    code, lines = _run(url)
    assert code == 1 and any("DROP / TRUNCATE" in line for line in lines)
    assert "stores" not in _tables(url)  # 何も流れていない


def test_numbering_rules(tmp_path, monkeypatch):
    import shutil

    work = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, work)
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", work)
    gap = work / f"{_next_number(skip=1)}_gap.sql"  # 1 つ飛ばした番号
    gap.write_text("SELECT 1;\n", encoding="utf-8")
    with pytest.raises(migrate.MigrationError):
        migrate.migration_files()
    gap.unlink()
    (work / "bad name.sql").write_text("SELECT 1;\n", encoding="utf-8")
    with pytest.raises(migrate.MigrationError):
        migrate.migration_files()
