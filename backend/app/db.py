from collections.abc import Iterator
from contextlib import contextmanager

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.settings import database_url

_pool: ConnectionPool | None = None


def open_pool() -> None:
    global _pool
    _pool = ConnectionPool(database_url(), min_size=1, max_size=5, kwargs={"row_factory": dict_row}, open=True)
    _pool.wait(timeout=15)


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def connection() -> Iterator[Connection]:
    if _pool is None:
        raise RuntimeError("DB の接続プールが開いていません")
    with _pool.connection() as conn:
        yield conn
