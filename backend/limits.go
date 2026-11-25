package main

// 設計の既定の数字（docs/order-flow.md・docs/api.md）。実測ではなく、設計で決めた値（backend/app/limits.py の移植）。

import "time"

const (
	maxLines               = 30     // 1 注文の行（品の種類）の上限
	maxQty                 = 20     // 1 行の数量の上限
	maxTotalLumi           = 30_000 // 1 注文の合計の上限（ルミ）
	idempotencyKeyMin      = 8
	idempotencyKeyMax      = 64
	maxUnpaidOrders        = 2   // 1 人が同時に持てる、未払い（placed）の注文の数。超えたら 409
	reasonMax              = 200 // 取消し・調整の理由の文字数
	loginMaxFailures       = 5   // email ごとに、この窓の中で許す失敗の回数（超えたら 429）
	loyaltyLumiPerPoint    = 100 // 会計 100 ルミごとに 1 点
	staffOrderListLimit    = 200
	customerOrderListLimit = 50
	expireBatch            = 100 // expireStale が 1 回で戻す件数の上限
	txRetries              = 3   // デッドロック（40P01）・直列化失敗（40001）の再試行の回数
)

const (
	proposalTTL     = 10 * time.Minute // 確定の許可証の有効期間
	reservationTTL  = 15 * time.Minute // 確定から支払いまでの在庫の確保の期間
	staffSessionTTL = 12 * time.Hour
	loginWindow     = 15 * time.Minute
)
