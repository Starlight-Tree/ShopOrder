"""テストが DB を作り直す（DROP DATABASE → CREATE）前の、対象の検査。

TEST_DATABASE_URL を開発用の DB（db）や本番へ向け間違えても、消さないための最後の砦。
通すのは、使い捨てのサーバーのホスト名と、テスト用の DB 名だけ（どちらも完全一致）。
"""

import re
from urllib.parse import parse_qs, urlparse

# 作り直してよいサーバーのホスト名。test-db は、開発コンテナの使い捨ての Postgres（.devcontainer/docker-compose.yml）。
# 増やすときは、そのサーバーが使い捨てであること（データを失ってよいこと）を確かめる。
ALLOWED_HOSTS = frozenset({"test-db", "localhost", "127.0.0.1", "::1"})

# 作り直してよい DB 名。開発用の DB（shoporder）・postgres・テンプレートは、この形に当たらない。
TEST_DB_NAME = re.compile(r"shop_order_[a-z0-9_]+")

# URL の問い合わせ部で、接続先を上書きできる項目（libpq）。ホストの検査をすり抜けるので、付いていたら拒否する。
_OVERRIDES = frozenset({"host", "hostaddr", "service", "port", "dbname", "passfile", "sslrootcert"})


def assert_disposable_target(admin_url: str | None, name: str) -> None:
    """作り直してよい対象でなければ、RuntimeError。メッセージにはホスト名と DB 名だけを入れる（URL 全体は、パスワードを含みうる）。"""
    if not admin_url:
        raise RuntimeError("TEST_DATABASE_URL が未設定のまま、DB を作り直そうとしました")
    parsed = urlparse(admin_url)
    if parsed.scheme not in ("postgresql", "postgres"):
        raise RuntimeError("TEST_DATABASE_URL は postgresql:// の URL だけを受け付けます")
    host = parsed.hostname
    if host not in ALLOWED_HOSTS:
        raise RuntimeError(f"テストが DB を作り直せるのは、使い捨てのサーバー（{', '.join(sorted(ALLOWED_HOSTS))}）だけです。指定: {host!r}")
    overrides = _OVERRIDES & set(parse_qs(parsed.query))
    if overrides:
        raise RuntimeError(f"TEST_DATABASE_URL の問い合わせ部で、接続先を変える項目は使えません: {sorted(overrides)}")
    if not TEST_DB_NAME.fullmatch(name):
        raise RuntimeError(f"テストが作り直せる DB 名は shop_order_* （小文字・数字・_）だけです。指定: {name!r}")
