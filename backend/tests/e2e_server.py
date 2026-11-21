"""E2E（frontend/e2e/、Playwright）用の API サーバー。使い捨ての DB を作り直し、マイグレーションとダミーの履歴つき seed を入れて、uvicorn で待ち受ける。

    cd backend && TEST_DATABASE_URL=<使い捨ての Postgres の管理用 URL> .venv/bin/python -m tests.e2e_server

pytest のテストと同じく、DB を作り直す前に tests/guards.py が対象を検査する（使い捨てのサーバーのホスト名と、DB 名 shop_order_* だけを許す）。
開発用の DB（db）や本番へは向かない。決済・配達・通知・チャットは模擬（既定）。実 API は呼ばない。
Playwright の webServer が起動し、/health が 200 を返したら準備完了（seed のあとに待ち受けるので、その時点でデータは入っている）。
"""

import os

import psycopg
import uvicorn

from tests.guards import assert_disposable_target

DB_NAME = "shop_order_e2e"
HOST = "127.0.0.1"
PORT = int(os.environ.get("E2E_API_PORT", "8401"))
# 画面（next start）のオリジン。API は画面のサーバー側から呼ばれるので、CORS は実質使わないが、既定の localhost:3400 を残さない
WEB_ORIGIN = os.environ.get("E2E_WEB_ORIGIN", "http://127.0.0.1:3401")
STAFF_PASSWORD = "e2e-staff-pass"  # ダミー（seed のスタッフのパスワード。frontend/e2e/support/accounts.ts と同じ値）


def prepare_database() -> str:
    admin_url = os.environ.get("TEST_DATABASE_URL")
    assert_disposable_target(admin_url, DB_NAME)
    admin = psycopg.connect(admin_url, autocommit=True)
    admin.execute(f'DROP DATABASE IF EXISTS "{DB_NAME}" WITH (FORCE)')
    admin.execute(f'CREATE DATABASE "{DB_NAME}"')
    admin.close()
    return admin_url.rsplit("/", 1)[0] + "/" + DB_NAME


def main() -> None:
    url = prepare_database()
    os.environ.update(
        {
            "DATABASE_URL": url,
            "DEMO_DATA": "allow",
            "DEMO_STAFF_PASSWORD": STAFF_PASSWORD,
            "APP_ENV": "test",
            "AUTH_MODE": "dev",
            "ORDER_HOURS_CHECK": "off",
            "LOCAL_UTC_OFFSET_HOURS": "9",
            "CORS_ORIGINS": WEB_ORIGIN,
        }
    )
    from app import migrate, seed_demo

    if migrate.apply(url, out=lambda *_: None) != 0:
        raise SystemExit("マイグレーションに失敗しました")
    seed_demo.main(reset=True, history=True)
    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
