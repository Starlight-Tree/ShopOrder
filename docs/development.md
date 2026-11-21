# 開発

入口は [README.md](../README.md)（起動の手順）。ここは、テスト・マイグレーション・ダミーデータ・名前の決まり。数字と状態は 2026-11-21 時点で、コードを読んで確かめたもの（実行して確かめたものは、そう書く）。

## 開発コンテナ

コードの変更・テスト・コミットは、開発コンテナ（`.devcontainer/`）のセッションで行う。ホストでやるのは、コンテナの作成・再ビルド・起動、`migrate`・`seed`・バックアップ・ログ、`git worktree`、`.devcontainer/` の編集。

構成: Compose プロジェクト `shoporder` に、アプリの 4 サービス（db・api・worker・frontend）と、`dev`（開発コンテナ）・`test-db`（使い捨ての Postgres 17。tmpfs。外へ出られないネットワーク）が載る。Docker は、ホストのソケットを渡さず、専用のプロキシ（`shoporder-docker-proxy`。許可は 4 つのコンテナの start / stop / restart と、読み取りだけ）経由。名前は `shoporder-devcontainer`・`shoporder-test-db`・`shoporder-docker-proxy`、ボリュームは `shoporder-claude-config`・`shoporder-dev-venv`・`shoporder-dev-node-modules`・`shoporder-dev-next`。

**初回（ホスト → コンテナ）**

1. VS Code の「Reopen in Container」。`initializeCommand` が、ボリューム `shoporder-claude-config`（無ければ）とプロキシを作る。
2. ボリュームは空で始まる。コンテナ用の `CLAUDE.md`（先頭に `@shared-rules.md`。JobNavi と同じ形）と、ホストの `settings.json` からホスト専用の項目（Chrome のフック・`mcp__claude-in-chrome__*` の拒否）と `modelSettings` を除いた写しだけを置く（認証情報と `.claude.json` は写さない）。そのあと `~/.claude/bin/sync-shared-rules.sh --apply` で共通ルールを入れ、コンテナの中で Claude Code にログインする（ログインは人が行う）。**置かないと、コンテナの中の Claude に、日本語での応答・承認・バックアップの規則が効かない。**
3. コンテナの中で、1 回だけ: `cd backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.in`、`cd frontend && npm ci`（どちらも専用ボリュームに入る。ホストの作業ツリーには書かない）。

**コンテナの中で行う**

- `scripts/verify.sh`: `TEST_DATABASE_URL`（`test-db`）と `VERIFY_ALLOW_REMOTE_DB=test-db` は設定済み。`backend/.venv` が無いと、バックエンドの段は「未実行」（終了コード 2）。フロントは、スクラッチのコピーではなく `cd frontend && npm ci` を直接流す。テスト用の Postgres の `docker run` は要らない。
- アプリの再起動: `docker restart shoporder-<db|api|worker|frontend>`。`docker compose restart <サービス>` はコンテナを ID で指定するので、通らない可能性が高い（未確認）。
- 画面・API は、ホストのブラウザーから `localhost:3400` / `8400`。dev の `localhost` には何も無い。**ただし dev から `host.docker.internal:8400` は届く**（2026-11-21 に `/health` が 200 になるのを実測）。Docker のネットワークでは隔離してあるが、ホストの公開ポート経由では、dev は api に届く。

**ホストで行う**

- `docker compose run --rm migrate` / `seed`、`up --build`（プロキシがコンテナの作成を拒否する）。
- `docker exec` での `pg_dump`（上の「マイグレーション」）。`docker logs`（CLI は inspect を呼ぶので、プロキシが拒否する）。
- `git worktree` の作成・削除。`.git` をホストと共有しているが、ワークツリーの登録は絶対パスを持つ。コンテナの中の `git worktree prune` は、ホストのワークツリーの登録を消す。
- `.devcontainer/` の編集と、コンテナの再ビルド・再作成。

**読み取り専用で重ねたもの**（コンテナの再作成のあとに効く）

dev はワークスペース全体を書き込み可で持つが、`.devcontainer/`・`.git/hooks/`・`.claude/hooks/`・`.claude/settings.json` は `:ro` で重ねてある。dev の中のコードが、ホストで承認なしに動くファイル（`initializeCommand`、プロキシの許可リスト、git のフック、Claude Code のフックと許可）を書き換えられないようにするため。これらの変更はホストで行う。**残る経路:** `scripts/`（`.claude/settings.json` が `scripts/verify.sh` を承認なしで許可している）と `.vscode/` は書き込める。コンテナの中で触れた範囲は、コミットの前に差分で確かめる。`.env`・`backups/`・`.git/sensitive-terms` も、コンテナから見える。

## メニューの写真

メニューの写真は、Git に置く生成済みの画像（`frontend/public/images/menu/<code>.jpg`）。写真がある品の code を `frontend/src/lib/shop/menu-images.ts` に足すと、メニューのカードに出る（無い品は写真なし）。生成は課金されるので承認制。手順・認証（Vertex AI の ADC）・確認の項目は [scripts/generate-images/README.md](../scripts/generate-images/README.md)。

## テスト

| 対象 | コマンド | 前提 |
|---|---|---|
| バックエンド | `cd backend && TEST_DATABASE_URL=<URL> .venv/bin/python -m pytest -q -rs` | 使い捨ての Postgres 17。`backend/.venv` に `requirements.txt` と `requirements-dev.in` を入れる |
| 評価（チャット） | `cd evals && TEST_DATABASE_URL=<URL> ../backend/.venv/bin/python -m pytest -q` | 同上。実 API は呼ばない。**CI にも `scripts/verify.sh` にも、まだ入っていない**（[evals/README.md](../evals/README.md)） |
| フロントエンド | `cd frontend && npm ci && npm test && npm run build && npm run typecheck` | Node 24。`typecheck` は `build` の後 |
| まとめて | `scripts/verify.sh [backend\|frontend\|lint\|all]` | 依存は先に入れておく（インストールはしない）。バックエンドの段は、`TEST_DATABASE_URL` を環境変数で渡さないか、そのホストが localhost・127.0.0.1・[::1] 以外だと「未実行」（使い捨てのサーバーなら、`VERIFY_ALLOW_REMOTE_DB` にそのホスト名を入れて解除。完全一致）。終了コード: 0 = すべて合格 / 1 = 失敗あり / 2 = 未実行がある / 64 = 引数の誤り |

- `TEST_DATABASE_URL` が指すサーバーでは、テスト用の DB を `DROP DATABASE IF EXISTS` → `CREATE` で作り直す。**使い捨てのサーバーに向ける。** 消す前に、`backend/tests/guards.py` が、ホスト（`test-db`・`localhost`・`127.0.0.1`・`::1` だけ）と DB 名（`shop_order_*` だけ）を完全一致で検査し、外れれば止まる（`evals/` も同じ）。無いと、DB を使うテストは飛ばされる（CI は、スキップが 1 件でもあれば落とす）。
- 使い捨ての Postgres の例: `docker run -d --rm --name shoporder-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17`（URL は `postgresql://postgres@127.0.0.1:55432/postgres`）。
- ホストの `node_modules` は、Linux 用のことがある。動かなければ、スクラッチのコピーで `npm ci` して流す（`scripts/verify.sh` の冒頭）。

## マイグレーション

番号付き SQL（`backend/app/migrations/NNNN_名前.sql`）を足すだけ。適用済みのファイルは書き換えない（sha256 を記録していて、変わると止まる）。`DROP` / `TRUNCATE` は足さない。実行は advisory lock で 1 つずつ。

適用の前に、バックアップを取る。

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U shoporder -Fc shoporder > backups/shoporder.dump.new
ls -l backups/shoporder.dump.new            # サイズが 0 でないことを確かめてから
mv backups/shoporder.dump.new backups/shoporder.dump
docker compose run --rm --build migrate     # --build: マイグレーションを足したあとは、イメージを作り直す
```

`docker compose run --rm migrate python -m app.migrate --status` と `--dry-run` は、DB を変えずに状態を見る。`backups/` は Git の管理外。

## ダミーデータ

`seed`（`profile: tools`）は、`DEMO_DATA=allow` が無いと実行を拒否する（Compose の定義が渡す）。**本番の DB に向けない。**

| 実行 | 何をするか |
|---|---|
| `docker compose run --rm --build seed` | 足りない店・メニュー・在庫・デモのスタッフ・宅配の区画と配達員を入れる（何度流しても、増えない。価格・レシピ・スタッフは書き直す。**スタッフのパスワードも、既定の値へ戻る**。在庫の数は上書きしない） |
| `python -m app.seed_demo --reset` | 店・メニュー・在庫・注文・スタッフを消して入れ直す |
| `python -m app.seed_demo --reset --history` | 上に加えて、過去 90 日のダミーの注文・在庫の台帳と、分析の日次集計を入れる。**店長の画面に過去の推移を出すには、これが要る**（`--reset` と一緒のときだけ） |

`--reset` を付ける形を Compose から流すときは、`docker compose run --rm seed python -m app.seed_demo --reset --history` の形になる（`seed` サービスの `command` を上書きする）。**流すと、開発 DB の注文が消える。先に上のバックアップを取る。** 2026-11-21 に実行して確かめた（店 12・メニュー 15・宅配の区画 4・配達員 8 に加え、注文 1,863 件・order_events 10,904 件・顧客 120 人が入った。所要は約 3 秒）。

デモのスタッフ（各店 `staff-<店の code>@oasis-cafe.example`、店長 `manager@oasis-cafe.example`）のパスワードは、環境変数 `DEMO_STAFF_PASSWORD`（既定 `oasis-demo-pass`。ダミーで、秘密ではない）。Compose の `seed` はこの変数を渡さないので、変えるときは `docker compose run --rm -e DEMO_STAFF_PASSWORD=… seed` のように渡す。

## 注文・在庫の設定値

- 支払い期限（在庫の確保の期間）は 15 分で、`backend/app/limits.py` の `RESERVATION_TTL`。設定（環境変数）にはなっていない。
- worker は、既定で 30 秒ごとに、期限を過ぎた注文を取り消して確保を戻す（`WORKER_INTERVAL_SECONDS`）。API も、読み取りと確定の前に同じ処理を呼ぶ。
- 開発の Compose は `ORDER_HOURS_CHECK=off`（営業時間・定休日・ラストオーダー・販売時間帯を見ない。季節の期間と臨時休業は見る）と `AUTH_MODE=dev`（顧客は `X-Dev-User` ヘッダーの名前、無ければ `demo-customer`）。`APP_ENV` が `development` か `test` 以外（未設定を含む）のときは、`AUTH_MODE=dev`・`ORDER_HOURS_CHECK=off`・模擬決済のどれも、単独で起動を拒否する（`backend/app/auth.py`）。今は本物のログインが無い（P6）ので、`development` か `test` 以外では API は起動しない。

## 名前の決まり（Compose・コンテナ・ラベルは、JobNavi・DocuNavi にそろえた）

| もの | 名前 |
|---|---|
| Compose のプロジェクト名 | `shoporder`（`jobnavi`・`docunavi` と同じく、小文字で区切りなし） |
| コンテナ | `shoporder-db` / `-api` / `-worker` / `-frontend`（道具は `-migrate` / `-seed`） |
| ボリューム・ネットワーク | `shoporder_pg-data` など（Compose が `<プロジェクト名>_<名前>` で作る） |
| VS Code のコンテナ一覧のグループ | ラベル `local.ui.group: "App-ShopOrder"`（`containers.containers.groupByLabel`（`.vscode/settings.json` とユーザー設定）がこのラベルを読む。動作には影響しない） |
| DB・ユーザー | `shoporder`（`jobnavi`・`docunavi` と同じく、プロジェクト名と同じ） |
| ローカルのフォルダー | `ShopOrder`（`jobnavi`・`docunavi` は小文字。2026-11-21 にユーザーが、フォルダー名は変えないと決めた） |

Compose の `name:` を変えると、ボリューム名が変わり、旧名の DB のデータは孤立する。変えたときは、旧ボリュームの中身を新ボリュームへ写してから起動する。同様に、`POSTGRES_DB` と `POSTGRES_USER` は、空のデータ領域の初期化にしか効かない。既存のボリュームの DB とロールの名前を変えるには、バックアップを取り、API・worker・画面を止めてから、別の一時的なスーパーユーザーで `ALTER DATABASE … RENAME TO …` と `ALTER ROLE … RENAME TO …` を流す（接続中の DB と、接続している自分自身のロールは改名できない）。
