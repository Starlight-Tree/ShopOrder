# oasis-order

架空の惑星ザーハード、アルカ市の「オアシス珈琲」（12 店舗）の、商品の注文と宅配のアプリ（仮名）。画面で注文でき、チャットで注文を手配でき、配達まで通る。売上・在庫・顧客の分析がある。店・人・データはすべて架空で、実在のものとは関係がない。

FastAPI + Postgres 17 + Next.js。通貨は「ルミ」。世界観は [docs/world.md](docs/world.md)、設計は [docs/architecture.md](docs/architecture.md)、段階は [docs/roadmap.md](docs/roadmap.md)。

## 今できること（2026-11-21）

- **画面で注文できる（店頭受け取り）。** 店を選び、メニューからカートに入れ、確認して確定し、模擬決済で支払う。注文の状況は 5 秒ごとに更新される（<http://localhost:3400>）。
- **店のスタッフの画面**（<http://localhost:3400/staff/login>）。調理ボード（受付 → 調理開始 → 準備完了 → 渡した、取消し）と在庫（入荷・廃棄・棚卸し）。デモのスタッフは `staff-<店の code>@oasis-cafe.example`（例 `staff-residential-main@oasis-cafe.example`）、店長は `manager@oasis-cafe.example`、パスワードは `oasis-demo-pass`（ダミー）。
- 在庫は台帳 + 残高で、確定のときに確保する（15 分で戻る。二重売りは起きない）。
- 宅配・チャット・分析は、バックエンドまで入っている。画面は、店長の分析画面まで（宅配とチャットの画面はこれから。[roadmap](docs/roadmap.md)）。API の約束は [docs/api.md](docs/api.md)。

## Quick start

前提: Docker。

```bash
docker compose up -d db
docker compose run --rm migrate      # 番号付き SQL を適用する
docker compose run --rm --build seed   # ダミーの店・メニュー・在庫・デモのスタッフを入れる（DEMO_DATA=allow を Compose が渡す。--build: 古いイメージで流さないため）
docker compose up -d --build
```

- 画面: <http://localhost:3400>
- API の仕様: <http://localhost:8400/docs>

ポートは JobNavi（3200 / 8200）・DocuNavi（3000）と同時に動かせるよう、3400 / 8400 にしてある。

## 開発とテスト

```bash
# バックエンド（使い捨ての Postgres 17 が要る）
docker run -d --rm --name oasis-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
cd backend && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.in
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres .venv/bin/python -m pytest -q -rs

# フロントエンド
cd frontend && npm ci && npm test && npm run build && npm run typecheck

# まとめて
scripts/verify.sh
```

`TEST_DATABASE_URL` は、テスト用の DB を作り直す（`DROP DATABASE IF EXISTS` → `CREATE`）ので、**使い捨てのサーバー**に向ける。

### DB のマイグレーション

番号付き SQL（`backend/app/migrations/NNNN_名前.sql`）を足すだけ。適用済みのファイルは書き換えない（sha256 を記録している）。適用の前にバックアップを取る。

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U oasis -Fc oasis > backups/oasis.dump.new
ls -l backups/oasis.dump.new          # サイズが 0 でないことを確かめてから
mv backups/oasis.dump.new backups/oasis.dump
docker compose run --rm --build migrate        # --build: マイグレーションを足したあとはイメージを作り直す
```

`python -m app.migrate --status` / `--dry-run` は、DB を変えずに状態を見る。

## 差し替え口（決済・配達・通知・チャットの LLM）

既定はすべて**模擬**（`PAYMENT_PROVIDER`・`DELIVERY_PROVIDER`・`NOTIFIER`・`CHAT_MODEL`）。本物への切り替えは、承認を得てから `.env`（Git 管理外）に書く。実 API は、件数・回数・概算費用を先に示して承認を得る。

## ライセンス

MIT。
