"""番号付き SQL のマイグレーション実行器（JobNavi の実行器から、初期スキーマの照合を除いた小さなもの）。

    python -m app.migrate --status     # 適用状況の表示だけ（DB を変えない）
    python -m app.migrate --dry-run    # 適用するものの一覧と事前の検査だけ（DB を変えない）
    python -m app.migrate              # 未適用のものを順に適用する

- app/migrations/NNNN_名前.sql を、0001 から連続した番号の順に流す。1 ファイルを 1 トランザクションで流し、成功したときだけ記録する
  （lock_timeout 5 秒。ロックが取れなければ失敗して何も変えない）。
- 記録にはファイルの sha256 を残し、適用済みのファイルが書き換わっていたら止まる。直すときは新しい番号のファイルを足す。
- 同時に 2 つ動かないよう、アドバイザリーロックを取る。DROP / TRUNCATE を含むファイルは、このリポジトリでは足さない（実行器も拒否する）。
"""

import hashlib
import re
import sys
from pathlib import Path

import psycopg

from app.settings import database_url

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
LOCK_KEY = 7_204_002
_FILE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
_FORBIDDEN = re.compile(r"\b(DROP|TRUNCATE)\b", re.IGNORECASE)


class MigrationError(RuntimeError):
    """続行してはいけない状態（番号の乱れ、チェックサムの不一致など）。メッセージは固定の説明だけで、接続情報を含めない。"""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def migration_files() -> list[tuple[str, str, Path]]:
    """(番号, 名前, パス)。番号順。番号の重複・欠番・規則に合わない名前は MigrationError。"""
    found = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        match = _FILE.match(path.name)
        if not match:
            raise MigrationError(f"マイグレーションのファイル名が規則に合いません: {path.name}")
        found.append((match.group(1), path.stem, path))
    versions = [v for v, _, _ in found]
    if len(set(versions)) != len(versions):
        raise MigrationError("同じ番号のマイグレーションが複数あります")
    expected = [f"{n:04d}" for n in range(1, 1 + len(found))]
    if versions != expected:
        raise MigrationError(f"番号が 0001 から連続していません: {versions}")
    return found


def _applied(conn: psycopg.Connection) -> dict[str, tuple[str, str]]:
    if conn.execute("SELECT to_regclass('public.schema_migrations')").fetchone()[0] is None:
        return {}
    return {r[0]: (r[1], r[2]) for r in conn.execute("SELECT version, name, checksum FROM schema_migrations")}


def plan(conn: psycopg.Connection) -> dict:
    """DB を変えずに、今の状態を調べる。戻り値: pending、problems、applied。"""
    applied = _applied(conn)
    files = migration_files()
    problems: list[str] = []
    for version, name, path in files:
        sql = path.read_text(encoding="utf-8")
        if _FORBIDDEN.search(_strip_comments(sql)):
            problems.append(f"マイグレーション {name} に DROP / TRUNCATE が含まれます（このリポジトリでは足さない決まりです）。")
        if version in applied and applied[version][1] != _sha256(path.read_bytes()):
            problems.append(f"適用済みのマイグレーション {name} が書き換えられています（記録したチェックサムと違います）。")
    known = {v for v, _, _ in files}
    for version in applied:
        if version not in known:
            problems.append(f"記録にあるマイグレーション {version} のファイルがありません。")
    pending = [(v, n, p) for v, n, p in files if v not in applied]
    return {"pending": pending, "problems": problems, "applied": sorted(applied)}


def apply(url: str, *, dry_run: bool = False, out=print) -> int:
    """戻り値は終了コード（0 = 成功、1 = 止まった）。dry_run では DB を変えない。"""
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_KEY,))
        try:
            state = plan(conn)
            for line in state["problems"]:
                out(line)
            if state["problems"]:
                return 1
            out("未適用: " + (", ".join(n for _, n, _ in state["pending"]) or "なし"))
            if dry_run:
                return 0
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, "
                "checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            for version, name, path in state["pending"]:
                sql = path.read_bytes()
                with conn.transaction():
                    conn.execute("SET LOCAL lock_timeout = '5s'")
                    conn.execute(sql.decode("utf-8"))
                    conn.execute("INSERT INTO schema_migrations (version, name, checksum) VALUES (%s, %s, %s)", (version, name, _sha256(sql)))
                out(f"適用: {name}")
            return 0
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))


def main(argv: list[str]) -> int:
    try:
        url = database_url()
        if "--status" in argv:
            with psycopg.connect(url, autocommit=True) as conn:
                state = plan(conn)
            print("適用済み:", ", ".join(state["applied"]) or "なし")
            print("未適用:", ", ".join(n for _, n, _ in state["pending"]) or "なし")
            for line in state["problems"]:
                print(line)
            return 1 if state["problems"] else 0
        return apply(url, dry_run="--dry-run" in argv)
    except (MigrationError, psycopg.Error, RuntimeError) as exc:
        # 接続情報を含みうる例外の本文は出さず、種類だけ出す
        known = isinstance(exc, (MigrationError, RuntimeError)) and not isinstance(exc, psycopg.Error)
        print(f"失敗しました（{type(exc).__name__}）。{exc if known else 'DB への接続か SQL の実行でエラーです'}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
