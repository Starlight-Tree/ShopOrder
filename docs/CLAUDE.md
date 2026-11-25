# docs/（文書）

どの文書が何の正本か。同じ事実を複数の文書に書かない。他の文書からは、リンクで指す。規則は [.claude/rules/docs.md](../.claude/rules/docs.md)。

| 文書 | 正本であること |
|---|---|
| [world.md](world.md) | 世界観・店・メニュー・価格（ルミ）・宅配の設定。区分は「資料」「決定」「新設」。資料どうしの食い違い |
| [requirements.md](requirements.md) | 誰が何をするか・範囲（MVP / 後 / やらない）・守ること・未決（既定つき） |
| [architecture.md](architecture.md) | 構成・認証・差し替え口・スタック・流用の地図・個人情報 |
| [data-model.md](data-model.md) | テーブルと制約 |
| [order-flow.md](order-flow.md) | 注文の状態・確定の手順・在庫の確保・宅配の決まり |
| [chat.md](chat.md) | チャットの設計（ツール・安全・構成・評価）。確定は画面のボタンだけ |
| [development.md](development.md) | 開発の手順（テスト・マイグレーション・ダミーデータの投入・名前の決まり・DB 改名の手順） |
| [analytics.md](analytics.md) | 分析の作り方・画面・顧客データの作法・ダミーデータ |
| [metrics.md](metrics.md) | 分析の指標の定義（メトリクス辞書）。閾値の数字は `backend/analytics_rules.go` の 1 か所 |
| [roadmap.md](roadmap.md) | 段階（P0〜P6）と状態 |
| [go-migration.md](go-migration.md) | API を Python から Go に置き換えた記録（範囲・構成・確かめ方・意図して違う点・戻し方） |
| [decisions/](decisions/README.md) | 決定（ADR）。1 件 1 ファイル。決定済みのものは書き換えず、新しい ADR で置き換える |

## 書き方

- 数字と状態には、日付と測り方を添える。確認していないことは「未確認」と書く。
- 世界観の値（店・メニュー・価格・宅配の設定）は world.md だけに書く。他は、その節へのリンク。
- 設計の数字（15 分・5 回・30 日など）は「設計の既定」で、設定値にする。実測ではない。
- 実装したら、該当する設計の文書の「状態」を直す（実装の文書に、設計の約束を二重に書かない）。
