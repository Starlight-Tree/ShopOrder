# API の Go への置き換え（2026-11-26）

ShopOrder の API（FastAPI + psycopg3）を Go に置き換えた記録。Go は `backend/` に置く（旧 Python の `backend/` は削除し、作業中の `backend-go/` を `backend/` に改名した。旧コードは Git の履歴（`85d573a`）に残る）。JobNavi・DocuNavi の方針（今後作る API は Go。解析だけ Python）にそろえた。ユーザーの指示（2026-11-26「ShopOrder の PJ も Go にリプレイスして」。JobNavi と同じ範囲）による。JobNavi の経緯は、JobNavi の `docs/go-migration.md`。

## 範囲

| 対象 | 置き換え |
|---|---|
| API（店・メニュー・カート・注文・支払い・スタッフ・在庫・宅配（住所・区画・枠・配車・配達員）・分析・チャット（SSE）） | **Go** |
| マイグレーション実行器・ダミーデータ（`seed`・履歴つき）・worker・分析の集計（`analytics-build`）・E2E 用の API（`e2e-server`） | **Go**（同じバイナリ `api` のサブコマンド） |
| チャットの評価（`evals/`） | **Go のテスト**に写した（`backend/eval_test.go`。Python の `app` を直接 import していたため） |
| 画面（Next.js）、画像生成の道具（`scripts/generate-images/`） | そのまま |
| DB（スキーマ・マイグレーション 0001〜0008）、HTTP の経路・応答の形（項目の順・数値の表記・エラーの文・422・405・CORS）、SSE の形 | **変えない**（画面は一行も変えていない。`frontend/playwright.config.ts` の API の起動コマンドと、コメントだけ変えた） |

## 構成（`backend/`。1 つの `package main`）

| ファイル | 役割（元の Python） |
|---|---|
| `main.go` `server.go` `body.go` `bodyvalid.go` `routes*.go` | 起動・サブコマンド・経路・FastAPI 互換の 404/405/422/500・CORS（GET だけ）・本文の検査（`main.py` `routes/` `schemas.py`） |
| `settings.go` `clock.go` `errors.go` `models.go` `pyfloat.go` | 環境変数・時計（固定できる）・固定のエラー文・応答の形・Python の小数の表記と丸め |
| `pydb.go` | `withTx`（1 つのトランザクション）・`row`・デッドロックの再試行（`db.py`） |
| `auth.go` `security.go` | 顧客（`X-Dev-User`）・スタッフ（不透明トークン）・ログインの制限・argon2id（`auth.py`） |
| `stores.go` `rules.go` `cart.go` `orders.go` `inventory.go` `payment.go` `limits.go` | 店・メニュー・カート・注文・在庫（台帳 + 残高）・決済の差し替え口（`stores.py` `cart.py` `orders.py` `inventory.py` …） |
| `delivery.go` `deliveryrules.go` `dispatch.go` | 宅配（区画・住所・枠・見積り・配車・配達員・暗証コード・模擬の進行） |
| `analytics_*.go` | 分析の規則・読み取り・日次集計の作成 |
| `chat_*.go` `routes_chat.go` | チャット（スレッド・ターン・ツール・ガード・模擬モデル・SSE。`chat/` 一式） |
| `migrate.go` `migrations/` | マイグレーション（SQL は `go:embed`。`migrate.py`） |
| `seed.go` `seed_data.go` `seedhistory.go` `pyrandom.go` | ダミーデータ。履歴は、Python の乱数（`random.Random(str)`。メルセンヌ・ツイスタ）を写して、Python が作ったものと同じ中身にした（`seed_demo.py` `seed_history.py`）。`seed_data.go` は Python のデータから生成した |
| `sweep.go` `worker.go` `e2e_server.go` `guards.go` | 掃除・worker・E2E 用の API・テストが DB を消す前の対象の検査 |

依存は `pgx`（DB）・`golang.org/x/crypto`（argon2）・`golang.org/x/text`（NFKC・大文字小文字の畳み込み）だけ。

## 使い方の違い

| 以前 | いま |
|---|---|
| `python -m app.migrate [--status\|--dry-run]` | `api migrate [--status\|--dry-run]`（Compose: `docker compose run --rm migrate`） |
| `python -m app.seed_demo [--reset] [--history]` | `api seed [--reset] [--history]`（Compose: `docker compose run --rm seed`） |
| `python -m app.worker` | `api worker`（Compose の `worker`） |
| `python -m app.analytics_build [--all\|--from …\|--rekey]` | `api analytics-build [--all\|--from …\|--rekey]` |
| `python -m tests.e2e_server` | `api e2e-server`（`go run . e2e-server`） |
| `uvicorn --reload`（ファイルを変えると反映） | 無い。`docker compose up -d --build api` |
| `http://localhost:8400/docs`（FastAPI の自動文書） | 無い。`/health` だけ。経路の一覧は [api.md](api.md) |
| `pytest`（backend 全体・`evals/`） | `go test -race -count=1 ./...`（`docs/development.md` の「テスト」） |

## 同じであることの確かめ方

実装の途中から終わりまで、旧 Python の API を**基準**にした。

- **差分テスト（実サーバー）**: 旧 Python の API と Go の API を、同じ中身の DB の複製につないで、同じ要求を 592 件送り、応答（状態・ヘッダー・本文。項目の順・数値の表記を含む）を比べた。時計は両方とも固定し、乱数の ID・トークン・暗証コードは、現れた順に名前を付けて伏せた。場面: 読み取り（店・メニュー・枠・分析 6 種 × 店長・店・他店・不正な値）・認証と 422・404・405・CORS・カート・注文（確定・再送・衝突・支払い・拒否・取消し・期限切れ・未払いの上限）・スタッフの遷移と在庫・営業時間と季節（時計を動かして）・宅配（住所・枠・見積り・割り当て・集荷・暗証コード・凍結・不在・再配達・模擬の進行・砂嵐）・チャット（40 発話・攻撃・上限）。**差分 0**。場面のあとの DB の状態も、全表が一致（乱数の値を伏せたとき）。
- **seed**: `--reset --history` を Python と Go で別の DB に流し、全表が一致（ID も同じ。注文 1,837 件・台帳 11,287 件・分析の日次集計 ほか）。
- **golden**: 上の応答のうち Python が TestClient で出した 592 件を `testdata/golden_api.json` に固定し、Go のテスト（`golden_test.go`）が同じ要求を流して比べる。Python が無い CI でも、同じ検査が続く。作り方は、旧 Python の API（`git show 85d573a:backend/…`）を TestClient で動かし、時計を `2026-11-26 12:00 JST` に固定して、同じ場面を流して、要求と正規化した応答を書き出した。記録の道具は削除した（作り直すときは、書き直す）。
- **単体**: 旧 Python の純粋な関数の実測（`testdata/unit_fixtures.json`）と、ガード・模擬モデルの解釈・分析の規則・宅配の規則・店の規則・丸め・乱数が一致する（650 の文字列と、境目の値）。
- **評価**: `evals/chat/` の golden set 25 件と安全の評価を、Go のテストに写して、すべて通る。
- **画面から**: E2E（Playwright。実ブラウザー）24 件が、Go の API で合格。
- Go のテストは `-race` つきで通る。同時実行（在庫を超えて売らない・取消しと確定の同時）・マイグレーション実行器・台帳（追記のみ）・ログインの制限・掃除・worker・seed の再実行も、Go で確かめる。

## 意図して違う点

- `/docs`（FastAPI の自動文書）は無い。
- **422 の日付の説明**: `?date=` の読み取りの誤りの文は、よくある場合（短すぎる・年・月・日の文字・区切り）だけ pydantic と同じ。ほかは、同じ種類（`date_from_datetime_parsing`）の別の文。
- **チャット**: モデルに渡す「ツールの定義」の JSON Schema は簡略（模擬モデルは読まない。実モデルを足すときに書く）。模擬モデルの解釈で、Python の `\d`（全角以外の Unicode の数字。例: アラビア・インド数字）は、扱わない（NFKC で ASCII になる数字は、同じ）。
- **本文の読み取り**: Content-Type が無い・JSON でない本文は、構文を読まずに 422（FastAPI の `strict_content_type`。旧 Python と同じ。確認済み）。
- 三角関数・対数は Go の `math`（Python は C ライブラリ）。履歴の seed は、最後の 1 ビットの違いで、まれに別の乱数の境目に入りうる（今回の 2 回の seed では、全表が一致した）。
- ログの文言は、種類と件数だけで、Python のものとは同じにしていない。

## 速さ・メモリ（2026-11-26 に実測。目安）

- **条件**: 同じ Docker VM（8 CPU）、注文 1,837 件の seed。Python は置き換え直前（`85d573a`）の Dockerfile のまま uvicorn 1 プロセス。負荷ツールも同じ VM で動かしたので、数字は目安（絶対値ではなく比）。環境変数は `APP_ENV=test AUTH_MODE=dev ORDER_HOURS_CHECK=off CHAT_MODEL=mock`。経路ごとに 8 秒（ならし 2 秒つき）。
- **rps（Python → Go）**:

| 経路 | 並列 1 | 並列 16 |
|---|---|---|
| `/health` | 3.6k → 36.6k | 6.3k → 59.7k |
| `/api/stores` | 1.7k → 5.8k | 2.3k → 15.1k |
| `/api/menu` | 1.1k → 1.7k | 1.3k → 5.0k |
| 顧客の注文一覧 | 0.9k → 1.2k | 1.3k → 3.3k |
| スタッフの注文一覧 | 1.0k → 2.8k | 1.5k → 7.3k |

- 分析（概況・商品別・時間帯・在庫・顧客。並列 16）は、約 0.8〜1.7k → 1.8〜5.5k。注文の通しは、98 → 219 件/秒（並列 1）、137 → 365 件/秒（並列 8）。
- **差が出ない経路**: 分析の売上推移（90 日）は Python と同じ（p50 約 195 ms）。DB の集計が支配的で、言語の差が出ない。
- **メモリ**: 起動直後 49 → 5.5 MiB、負荷後 53.7 → 16.5 MiB、定常 約 50〜60 → 10〜22 MiB。起動 0.89 → 0.38 秒。
- **未解明**: Go は、2 秒おきの標本で、一時的に 110〜145 MiB が出て、1〜2 秒で約 11 MiB に戻る（Python の最大は 60.5 MiB）。スタッフのログイン（argon2id。memory 65536 KiB）を含む局面の頭で見えたが、ログイン 1 回だけでは再現せず、原因は確かめていない。実害も未確認。

## 未確認

- 本番（ShopOrder に本番環境は無い。ADR 0005 の差し替え口は模擬のまま）。
- 上の Go のメモリの一時的なピークの原因。

## 戻し方

旧 Python の API は、Git の履歴にある（置き換えの直前は `85d573a`）。DB のスキーマは変えていないので、Compose の `build` を元に戻せば、同じ DB で動く。
