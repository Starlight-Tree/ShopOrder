# CLAUDE.md

ShopOrder。架空の惑星ザーハード、アルカ市の「オアシス珈琲」（12 店舗）の、**商品の注文と宅配のアプリ**。画面で注文でき、チャットで注文を手配でき、配達まで通る。売上・在庫・顧客の分析がある。データはすべてダミー。
Go（`backend/`。標準ライブラリ + pgx。2026-11 に Python から置き換えた: [docs/go-migration.md](docs/go-migration.md)）、Next.js + TypeScript（`frontend/`）、Postgres 17、Docker Compose。JobNavi を土台に、チャットの部品を DocuNavi から写す（[ADR 0002](docs/decisions/0002-stack-based-on-jobnavi.md)）。
入口は [README.md](README.md)。要件は [docs/requirements.md](docs/requirements.md)、全体設計は [docs/architecture.md](docs/architecture.md)、段階は [docs/roadmap.md](docs/roadmap.md)。**世界観・店・メニュー・価格・宅配の設定の正本は [docs/world.md](docs/world.md)。** 文書ごとの正本の表は [docs/CLAUDE.md](docs/CLAUDE.md)。
領域ごとの規約は各 `CLAUDE.md`（まだ無い領域は、このファイルが正）、パス別の規則は `.claude/rules/`、読み取り専用の調査・レビュー担当は `.claude/agents/`。

## 状態（2026-11-21 23 時時点。見たもの: `git log`・`backend/app/migrations/`・`frontend/app/`・各文書の「状態」）

P0・P1 は済み。**P2（宅配）・P3（チャット）・P4（分析）は、バックエンドと評価まで `main` に取り込み済み**（マイグレーション 0001〜0008。0005 宅配・0006 分析・0007 チャット・0008 名前の整理）。画面は、顧客の注文（`/`。店頭受け取りと宅配。宅配は住所・時間枠・受け取り PIN・進み具合）、店のスタッフ（`/staff`。調理ボード・在庫・配車 `/staff/dispatch`・配達員 `/staff/courier`）、店長の分析（`/manager`。店頭受け取りの分）まで。宅配の画面は、`main` に統合済み（2026-11-21。単体テストと `scripts/verify.sh frontend lint` は合格。ブラウザーでの役割別の確認は、最後の修正の前に実施）。段階ごとの状態と残りの正本は [docs/roadmap.md](docs/roadmap.md)。

- **画面が未着手:** チャット（模擬モデルのみ。評価は `backend/eval_test.go`）、宅配の分析。
- **未着手:** P5 の通知・連絡スレッド・個別の顧客の画面（顧客の集計〔RFM・コホート〕は P4 に入っている）。P6（実 LLM・実決済・公開先）は見送り。
- **環境:** 開発は開発コンテナ（`.devcontainer/`。手順は [docs/development.md](docs/development.md)）。Git のリモートは GitHub の `Starlight-Tree/ShopOrder`（公開。`main` のみ）。E2E（Playwright）は `frontend/e2e/` に導入済み（2026-11-22。店頭受け取りと宅配の通し、店長の分析。`scripts/verify.sh` には未収録。CI の `e2e` ジョブで流れる）。ブラウザーでの目視は一部が未実施（[docs/analytics.md](docs/analytics.md) の「未確認」）。

## よく使うコマンド

| 目的 | コマンド |
|---|---|
| 起動（ホストで） | `docker compose up -d --build`。画面 <http://localhost:3400>、API の死活確認 <http://localhost:8400/health>（FastAPI の `/docs` は、Go への置き換えで無くなった）。マイグレーションもダミーデータも流さない |
| 初めての環境（空の DB） | `docker compose up -d db` → `docker compose run --rm migrate` → `docker compose run --rm seed` → `docker compose up -d --build` |
| バックエンドのテスト | `cd backend && TEST_DATABASE_URL=<使い捨ての Postgres の URL> go test -race -count=1 ./...`（Go 1.26 以上）。**`TEST_DATABASE_URL` が無いと DB のテストがスキップされる**。チャットの評価・旧 Python の応答の再生を含む。道具は `docker compose run --rm migrate\|seed`、分析の集計は `api analytics-build` |
| フロントエンドの検査 | `cd frontend && npm ci && npm test && npm run build && npm run typecheck`（`typecheck` は `build` の後） |
| E2E（実ブラウザー） | 開発コンテナで `cd frontend && npm run test:e2e`。使い捨ての `test-db` に専用の DB を作り直して、API（8401）と画面（3401）を立てる。コンテナの作成後に、1 回 `npx playwright install chromium`（詳細は [docs/development.md](docs/development.md)） |
| 検査（まとめて） | `scripts/verify.sh [backend\|frontend\|lint\|all]`。CI に近い検査で、同じではない（違いはスクリプト冒頭）。流せない段は「未実行」に出る |
| 版の整合 | `scripts/check-versions.sh`（Go・Node 24 が、各ファイルで揃っているか） |
| 登録語の検査 | `scripts/check-sensitive-terms.sh [A..B]`（語は Git の管理外の `.git/sensitive-terms`。表示しない） |

## 構成

| 場所 | 役割 | 版 |
|---|---|---|
| `backend/` | API（Go）、マイグレーション（`migrations/`）、seed、運営用の道具（同じバイナリ `api` のサブコマンド）、テスト・チャットの評価 | Go 1.26.10 |
| `frontend/` | 画面（Next.js）。API は画面のサーバー側から呼ぶ | Node 24 |
| `docs/` | 要件・設計・世界観（`world.md`）・決定（`decisions/`） | |
| `scripts/` | verify・check-versions・check-sensitive-terms | |
| `.claude/` | 設定・フック・規則・エージェント・スキル（JobNavi から写して、書き直したもの） | |

版の基準は `backend/go.mod`（Go 1.26.10）と `.node-version`（24）。各ファイルとの整合は `scripts/check-versions.sh` が確かめる。

## 守ること（コードを書く前に）

- **世界観は `docs/world.md` が正本。** 店・メニュー・価格・宅配の値を、他の文書やコードに別に書かない（seed は world.md から写す）。資料に無い設定は「新設」と明記し、事実として書かない。通貨は**ルミ**（整数。「円」と書かない）。
- **AI（チャット）は、注文の確定・決済・個人情報の変更を、人の確認なしにしない。** 確定のツールを AI に渡さない。確定は画面の確定ボタンだけ（[ADR 0003](docs/decisions/0003-chat-never-confirms-orders.md)、[docs/chat.md](docs/chat.md)）。
- **権限は API が毎回確認する。** 利用者・店・ロールはセッションから取る。他人の注文・他店のデータは 404。顧客とスタッフは、アカウントもセッションも Cookie も別。
- **決済・配達・通知・LLM は模擬が既定。** 本物への切り替えは、承認を得てから、環境変数で選ぶ（[ADR 0005](docs/decisions/0005-mock-first-providers.md)）。実 API・課金・外部への書き込みは、事前に承認を得る（件数・回数・概算費用を先に示す）。
- **`.env`・`backups/`・`.git/sensitive-terms`（登録語）は読まない。** 値を表示・ログ・コミットしない。住所・電話・注文の中身・チャットの本文は個人情報で、ログに出さない。
- **ダミーデータの投入は `DEMO_DATA=allow` を渡した開発・テストの環境だけ。** 本番の DB に向けない。
- **マイグレーションは番号付き SQL を足すだけ。** 適用済みのファイルを書き換えない（sha256 を記録していて、変わると止まる）。`DROP` / `TRUNCATE` は足さない。適用の前に、DB のバックアップを取る。
- **`backend/go.sum` は直接編集しない。** `go mod tidy` で作り直す。依存を足すときは、先に確認する。
- **金額・数量は整数。** 在庫は台帳（追記のみ）+ 残高。確保は注文の確定時に条件付き UPDATE（[ADR 0004](docs/decisions/0004-inventory-ledger-and-reservation.md)）。
- **エラー本文は固定の文。** 例外の文字列やサーバーのパスを API の応答に含めない。
- **ポートは 3400（画面）と 8400（API）。** JobNavi（3200/8200）・DocuNavi（3000）と同時に動かすため。変えない。E2E は専用の 3401（画面）と 8401（API）。
- 変更したら、触れた範囲のテストを実行してから報告する。確認できていないことは、確認済みと書かない。

## 承認が要る操作（正本）

承認は、その操作だけに有効（前の承認は次に及ばない）。サブエージェントには任せない（[.claude/rules/parallel-work.md](.claude/rules/parallel-work.md)）。

| 操作 | 承認 | 強制の手段 |
|---|---|---|
| コミット | 要る（`git diff --staged` を見せてから）。`--no-verify` は使わない | 承認は文章。`--no-verify` と秘密の混入は `guard-git-write.py` が拒否 |
| `git add -A` / `git add .` | 使わない（パスを指定する） | `guard-git-write.py` が拒否 |
| プッシュ、`git reset`、`git restore` | 要る | `settings.json` の `ask` |
| 強制プッシュ・公開済み履歴の書き換え | 原則しない。ユーザーが明示して頼んだときだけ | `ask` と `guard-git-write.py` |
| `CLAUDE.md`・`.claude/`（規則・フック・権限・スキル）の変更 | 要る（差分を示してから） | `CLAUDE.md` は `settings.json` の `ask` |
| 実 API・課金（LLM・画像生成など）、決済・メールの本物への接続、本番の DB・デプロイ | 要る（件数・回数・概算費用を先に） | 文章 |
| 本番の DB へのマイグレーションの適用 | 要る（操作ごと。DB のバックアップが先） | 文章 |
| 開発・テストの DB への `migrate`、`seed`（`DEMO_DATA=allow`） | 依頼があれば要らない（DB のバックアップが先。本番に向けない） | 文章。`seed` は `DEMO_DATA` が無いと拒否 |
| gcloud・gh・wrangler・infisical・prisma・MCP の書き込み系 | 既定は実行せず、コマンドを提示する。ユーザーが明示して頼んだときだけ、示して承認を得てから実行 | フック（`guard-cloud-cli.py`・`guard-deploy-cli.py`）と `ask` |
| 使われているか分からないファイル・データの削除、元に戻す操作 | ユーザーの明示的な指示があるまで実行しない | 文章 |
| 新しいサービス・言語・フレームワーク・DB、世界観（world.md）の「資料」「決定」の変更 | 要る | 文章 |

## Git

- **コミットメッセージ:** Conventional Commits（`type(scope): 英語の命令形の要約`、件名 72 文字以内）。1 コミット 1 論理変更。本文に「なぜ」と確認の結果（限界も）を書く。
- **運用:** `main` に直接コミット。ステージはパスを指定する。コミット前に `git diff --staged` で、意図しない変更が入っていないか確かめる。リモートは GitHub の `Starlight-Tree/ShopOrder`（公開）。プッシュは操作ごとに承認が要る（上の表）。
- **CI:** `.github/workflows/ci.yml`（`main` へのプッシュと PR。外部 API を呼ばない。デプロイを含まない）。ローカルでは `scripts/verify.sh`。

## 作業の進め方

- タスクで指定された範囲だけを編集する。範囲外に必要な変更があれば、勝手に直さず提案する。
- 未コミットの差分は、頼まれない限り触らず、コミットにも含めない。
- 既存の文書は、新規作成より更新を優先する。この CLAUDE.md は短く保ち、詳細は `docs/` に置く。決定は `docs/decisions/` に 1 件 1 ファイル。
- 「最新トレンド」の主張には、出どころ（一般知識か、今回の調査か）を 1 行で添える。
- wrangler・infisical・prisma の書き込み系は、フック `.claude/hooks/guard-deploy-cli.py` が確認に回す。止められたら回避せず、ユーザーに伝える。
