# メニューの写真の生成（管理用）

メニュー 15 品の写真を、Vertex AI（`gemini-3.1-flash-lite-image`。DocuNavi の画像生成ジョブと同じモデル）で 1 枚ずつ生成し、`frontend/public/images/menu/<code>.jpg` に保存する。ページを開くたびには生成しない。アプリの依存とは別の小さなパッケージにしてある。

- 写実的な写真風。背景の印象は [docs/world.md](../../docs/world.md) の「店のトーン」に合わせた（夕暮れの群青の空・土色の岩場・石造りのガラスドーム・琥珀色の灯り）。食材の「見慣れない感じ」はこの画像だけの演出（新設）で、世界観の設定ではない。
- **課金される。** 実行の前に、枚数と概算費用を示して承認を得る（[CLAUDE.md](../../CLAUDE.md)）。1K の画像は 1,120 出力トークンで、1 枚 0.034 ドル前後（2026-11-21 の試し生成の使用量と、Google の[価格ページ](https://ai.google.dev/gemini-api/docs/pricing)の単価 30 ドル/100 万トークンから）。15 枚で 0.5 ドル前後。Vertex AI の請求の実額は未確認。
- 認証は ADC（`gcloud auth application-default login`）。API キーは使わない。実行は**ホスト**で行う。
- **課金先は、本番と分けた画像生成用のプロジェクトを、必ず明示する**（`GOOGLE_CLOUD_PROJECT`）。DocuNavi・JobNavi の画像生成と同じもの（ID は両リポジトリの `docs/image-gen-resources.md`）。gcloud の既定のプロジェクトは本番のことがあるので使わない。
- 経緯: Gemini API の無料キーは使えなかった（2026-11-21。Batch は `400 FAILED_PRECONDITION`、標準の API は `429`＝無料枠の割り当てが 0）。

## 手順

```bash
cd scripts/generate-images && npm ci --ignore-scripts
export GOOGLE_CLOUD_PROJECT=<画像生成用のプロジェクト> GOOGLE_CLOUD_QUOTA_PROJECT=<同じ> GOOGLE_CLOUD_LOCATION=global

npm run generate -- --id oasis-blend --dry-run   # 送る内容と枚数だけ表示（API を呼ばない・課金なし）
npm run generate -- --id oasis-blend             # 1 枚だけ（課金）
npm run generate -- --all                        # 全件を 1 枚ずつ（課金）。保存済みの品は飛ばす（--force で作り直す）。最初の失敗で止まる
```

## 生成後の確認（コミットの前）

- 4:3 に近いか（保存時に寸法を表示する。1 枚目は 1200×896）
- 文字・ロゴ・実在の人物・商標が入っていないか。皿や袋に読める文字が無いか
- 写実的か（イラスト調になっていないか）。品の取り違えが無いか
- 世界観がそろっているか（背景・光）

確認できた品の code を、`frontend/src/lib/shop/menu-images.ts` の `MENU_IMAGE_CODES` に足す（足した品だけ、画面に出る）。PNG が返ると `<code>.png` で保存されるので、`.jpg` に変換するか、`menuImageSrc` の拡張子を直す。

## 未検証

- 15 枚とも生成した（2026-11-21）。読める文字・ロゴは無く、写実的で、背景の雰囲気もそろっている。
- プロンプトで「人なし」と指定しても、7 枚にぼかした架空の人物（beans-oasis は手）が写り、4 枚に月が 1〜2 個写る。許容と判断して、そのまま採用した（作り直すと 1 枚 0.034 ドル前後）。月は `docs/world.md` に無い、画像だけの演出。
- 頻度制限（429）が出るので、`generate.ts` は呼び出しの間を 15 秒空け、429 は 60 秒待って最大 4 回試す。
- Vertex AI の請求の実額は未確認（上の概算は使用量からの計算）。
