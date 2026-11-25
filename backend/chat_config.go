package main

// チャットの設定。設計の既定の数字（変えるときはここだけ）。実測ではなく、設計で決めた値（backend/app/chat/config.py の移植）。

import "time"

const (
	messageMaxChars       = 500 // 1 発話の文字数
	historyMessages       = 20  // モデルに渡す、過去の発話の数（本文だけ。ツールの結果は渡さず、ターンの先頭で get_cart を読み直す）
	threadMaxUserMessages = 60  // 1 スレッドの、利用者の発話の上限
	dailyMessagesPerUser  = 100 // 1 利用者・1 日（店のローカル日付）の、発話の上限
	dailyThreadsPerUser   = 20  // 1 利用者・1 日の、スレッドの作成の上限
	maxModelSteps         = 12  // 1 ターンの、モデルを呼ぶ回数
	maxToolCallsPerTurn   = 12  // ツールの呼び出し（ターンの先頭の get_cart を含む）
	maxWritesPerTurn      = 3   // 書き込み（カートの下書き・提案）の回数
	toolTextMaxChars      = 120 // 商品名・説明などの文字数。超える分は切る（信頼できないデータなので、長さを制限する）
	toolResultMaxBytes    = 12_000
	searchMaxItems        = 8
	ordersMax             = 5 // list_my_orders の件数
	textChunkChars        = 24
	turnLeaseSeconds      = 120
	purgeBatch            = 100
	keepaliveInterval     = 10 * time.Second // イベントが無い間に SSE のコメント行（ping）を送る間隔
)
