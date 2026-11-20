# 0002 スタックは JobNavi を土台にし、チャットの部品だけ DocuNavi から写す

- 状態: 決定（2026-11-21 にユーザーが承認。異議があれば新しい ADR で置き換える）
- 日付と決めた人: 2026-11-21（私の提案をユーザーが承認）

## 背景
既存の 2 プロジェクトは、同じユーザーの流儀（ガード・ADR・テスト）で作られている。JobNavi は FastAPI + psycopg3 + Postgres 17 + Next.js + Docker Compose で、認証（顧客と園の分離）・マイグレーション・seed・差し替え口（Storage）が整っている。DocuNavi は LangGraph + Gemini のチャットと、入出力ガード・評価の規律を持つが、基盤は Cloudflare Workers・GCP・Prisma Postgres で、このアプリには重い。
## 決定
- 土台は JobNavi: Python 3.13・FastAPI・psycopg3（ORM なし）・Postgres 17（拡張なし）・Next.js 16（App Router）・Docker Compose・Vitest・pytest・Playwright。
- チャットだけ DocuNavi から写す: LangGraph の骨格・`guardrails.py`・SSE（UI message stream）・`useChat`・評価の規律。
- 持ち込まない: DocuNavi の SQLite→Postgres 変換層・自作チェックポイント・Go の SSE 中継・Workers の配備。
- ポートは画面 3400・API 8400（JobNavi 3200/8200、DocuNavi 3000 と同時に動かすため）。
## 結果と限界
- 流儀が揃い、写せるコードが多い。未確認: LangGraph 1.x と `langchain-google-genai` の組み合わせでの書き込みツール（DocuNavi は読み取りだけ）。P3 で確かめる。
- 公開先（Workers か Cloud Run か）は決めていない。ローカルだけで完結する。
## 出典
docs/architecture.md の流用の地図（調査 Workflow `wf_40ca9603-6e8` の読み取り、2026-11-21）。
