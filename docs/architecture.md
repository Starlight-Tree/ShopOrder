# 全体設計

要件は [requirements.md](requirements.md)。データは [data-model.md](data-model.md)、注文・在庫・配達は [order-flow.md](order-flow.md)、チャットは [chat.md](chat.md)、分析は [analytics.md](analytics.md)、段階は [roadmap.md](roadmap.md)。

出どころの注記: 以下のスタックは、JobNavi・DocuNavi の依存ファイルとコードの読み取り（2026-11-21、調査 Workflow `wf_40ca9603-6e8`）に基づく。「最新トレンド」の言い方は、既存 2 プロジェクトが採っている構成（Next.js の App Router、AI SDK のストリーミング、Postgres 中心）に合わせるという意味で、今回あらためて市場の動向を調べたものではない（一般知識）。

## 構成

```
ブラウザ ─ Next.js 16（画面 3400。Server Component から API を呼ぶ）
              │  └ /api/chat（Route Handler。SSE を中継。Cookie → 短命 JWT）
              │  └ Better Auth（顧客の Google ログイン。Next.js の中で動く）
              ▼
           FastAPI（API 8400）── Postgres 17（db。ホストへは出さない）
              ▲
           worker（同じイメージ。予約の期限切れ・模擬の配達進行・夜間の集計）
```

- **API はサーバー側から呼ぶ**（JobNavi と同じ）。ブラウザは API を直接呼ばず、CORS に頼らない。チャットのストリームだけ、Route Handler が中継する。
- **ロールは 2 系統。** 顧客は Better Auth（Google）→ 15 分の JWT → FastAPI が JWKS で検証。店のスタッフ（staff・courier・manager）は、FastAPI が発行する不透明トークン（`token_hash` だけ保存）を HttpOnly Cookie で持つ。アカウント・セッション・Cookie が別（JobNavi の求職者 / 園と同じ）。開発の既定は `AUTH_MODE=dev`（固定のダミー利用者で入る。本番相当の設定では起動を拒否）。
- **権限は API の 1 か所の関門で決める。** 利用者・店・ロールはセッションから取り、リクエストの値を信用しない。他人の注文・他店のデータは SQL の `WHERE` に所有者・店の条件を入れ、取得前に絞る（他は 404）。
- **差し替え口（Protocol + 模擬 + 設定で選ぶ）:** `PaymentProvider`（模擬 / 実）、`DeliveryProvider`（自前 / 模擬の外部）、`Notifier`（アプリ内の通知欄 / Web Push / メール）、`ChatModel`（模擬 / Gemini）。JobNavi の `Storage` と同じ型。設定の値が不正なら起動を失敗させ、別の実装へ黙って落とさない。既定はすべて模擬。
- **画面の更新:** MVP は短い間隔の再取得（ポーリング）。調理ボード・追跡画面で足りなくなったら、Postgres の `LISTEN/NOTIFY` と SSE にする（ADR で決める）。
- **画像:** メニュー写真は JobNavi と同じ「Git に置く生成済み画像 + seed で登録」。生成は課金されるので承認制（既定は画像なし・代わりの絵）。

## スタック

| 層 | 選ぶもの | 理由 |
|---|---|---|
| バックエンド | Python 3.13、FastAPI、psycopg3（生 SQL。ORM なし）、pydantic、argon2、PyJWT | JobNavi と同じ。SQL を読んで権限・ロックを確かめやすい |
| DB | Postgres 17。拡張なし（pgvector・PostGIS は使わない） | JobNavi と同じ。地図は区画の表で足りる |
| マイグレーション | JobNavi の実行器を写す（番号付き SQL・sha256・DROP 禁止・advisory lock）。**0001 から連番**（JobNavi の「既存の初期スキーマとの照合」は、既存の DB が無いので持ち込まない） | 流儀を揃える |
| 画面 | Next.js 16（App Router）、React 19、TypeScript、Vitest | JobNavi・DocuNavi と同じ |
| グラフ | shadcn/ui の Chart（Recharts v3）。ヒートマップとコホート表は HTML の `<table>` + CSS 変数の色 | SVG・CSS 変数でダークに対応。表は読み上げられる（調査: 公式の文書で確認、2026-11-21） |
| チャットの画面 | `ai` + `@ai-sdk/react` の `useChat`（UI message stream） | DocuNavi と同じ |
| チャットのバックエンド | LangGraph + `langchain-google-genai`。ガードは DocuNavi の `guardrails.py` を写す | 骨格が既にある。LLM は `ChatModel` の裏 |
| テスト | pytest（使い捨て Postgres）、Vitest、Playwright（E2E は Docker だけ） | JobNavi と同じ |
| 開発環境 | Docker Compose（db・api・frontend・worker。道具は `profile: tools`）、devcontainer、Node 24・Python 3.13 | JobNavi と同じ。ポートは 3400 / 8400 |
| CI | GitHub Actions（外部 API を呼ばない。デプロイを含まない） | JobNavi と同じ |
| 秘密 | 環境変数。Git 管理外の `.env`。Infisical は本番を決めるときに決める | 開発は秘密が要らない（模擬） |

**持ち込まないもの:** DocuNavi の SQLite → Postgres 変換層と自作のチェックポイント（最初から Postgres の SQL を書く）、Go の SSE 中継（Cloud Run の都合。ローカルでは不要）、Cloudflare Workers の配備（公開先は未決）。

## 流用の地図

| 元 | 写す先 | 変える点 |
|---|---|---|
| JobNavi `backend/app/migrate.py`・`migrations/` | `backend/app/migrate.py`（済み） | 初期スキーマの照合を除き、0001 から連番・ロックの鍵 |
| JobNavi `settings.py`・`storage.py` の型・`test_demo_guard.py` | `settings.py`・各 Provider | Provider の種類 |
| JobNavi `auth.py`・`jwt_auth.py`・`garden.py` | `auth.py`・`staff.py` | ロール（staff / courier / manager）と店の条件 |
| JobNavi `seed_demo.py` の作法（`demo_key`・`--reset`・`--extend`） | `seed_demo.py` | 12 店・メニュー・注文の履歴 |
| JobNavi `recruits.py` の検索・facets | メニューの絞り込み | 種類（温度・カテゴリ・アレルゲン） |
| DocuNavi `guardrails.py`・`graph.py`・`tools.py`・`resilience.py`・`ui_stream.py`・`routes.py` | `app/chat/` | プロンプト・ツールを注文用に。確定系のツールは置かない |
| DocuNavi `useChat.ts`・`MessageList`・`Composer` | `frontend/src/chat/` | 出典カードを商品・カート・確認カードに |
| DocuNavi の評価（golden・規則ベースの評価器） | `evals/` | 確定が 0 回・他人の注文が出ない・価格が結果にある |
| 両方の `.claude/`・`CLAUDE.md` の構成・ADR | 済み（`.claude/`・`docs/decisions/`） | oasis-order 向けに書き直し済み |

## ディレクトリ

```
backend/   app/（今: main・settings・db・migrate・seed_demo・schemas。これから: auth・staff・menu・cart・orders・payments・inventory・delivery・chat・analytics・jobs）, app/migrations/, tests/
frontend/  app/（(shop)・(staff)・(manager)・api/）, src/（components・lib・chat・charts）
evals/     チャットの評価（golden）
scripts/   verify.sh・check-versions.sh・check-sensitive-terms.sh
docs/      world.md ほか。決定は docs/decisions/
```

## セキュリティと個人情報

- 住所・電話・注文の中身・チャットの本文は個人情報。ログに出さない（ユーザー ID は SHA-256 の先頭 16 桁）。チャットの会話ログにも保存期間と削除を持たせる。
- 注文の金額・状態の記録と、顧客の個人項目（氏名・住所・電話・配達メモ・写真）は別に持つ。退会・期限切れでは、個人項目だけ消して注文の数値は残す（匿名化）。
- 分析用には仮名 ID（HMAC。鍵は別管理）だけを渡す。5 人未満のセルは出さない。
- 入力は固定文のエラー。例外の文字列・パスを応答に含めない。レート制限と 1 注文の品数・金額の上限を API に置く。
- ダミーデータの投入は `DEMO_DATA=allow` を渡した環境だけ（JobNavi と同じ門番）。

## 費用

ローカルの Docker Compose だけなので、**追加の費用は 0**（実測ではなく設計上の見積もり）。実 API（Gemini）を使うのは、承認を得た検証のときだけで、無料キーに限る。公開先に置く場合の月額は未計算（未決）。
