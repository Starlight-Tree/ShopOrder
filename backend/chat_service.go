package main

// スレッド・発話の保存、1 日の上限、1 スレッド 1 ターンの貸し出し、保存期間と削除（docs/chat.md「会話ログ」。backend/app/chat/service.py の移植）。
//   - 他人のスレッド・期限切れのスレッドは、無いのと同じ 404（存在を教えない）。利用者はセッション（API の認証）から決め、いつも user_id で絞る
//   - ターンの始まり（beginTurn）は 1 つのトランザクション: 貸し出しを取る → 上限を数える → 利用者の発話を保存する。どれかが失敗すれば全部戻る（貸し出しも）
//   - 会話の本文は個人情報。ログには出さない（種類と件数だけ）。保存期間（CHAT_RETENTION_DAYS。既定 30 日）を過ぎたスレッドは、読めなくなり、削除の対象になる

import (
	"encoding/json"
	"time"
)

// chatTurn は beginTurn の結果。agent が使う。
type chatTurn struct {
	ctx        *turnContext
	userText   string // 保存した発話（入力ガードで拒否したときは、伏せた文）
	refused    string // 入力ガードの理由コード（拒否なしは空）
	history    []chatMessage
	leaseUntil time.Time
	started    time.Time
}

type chatThreadOut struct {
	ID        string   `json:"id"`
	Store     storeRef `json:"store"`
	CreatedAt string   `json:"created_at"`
}

type chatMessageOut struct {
	ID        int             `json:"id"`
	Role      string          `json:"role"`
	Content   string          `json:"content"`
	Cards     json.RawMessage `json:"cards"`
	CreatedAt string          `json:"created_at"`
}

type chatThreadDetailOut struct {
	ID        string           `json:"id"`
	Store     storeRef         `json:"store"`
	CreatedAt string           `json:"created_at"`
	Messages  []chatMessageOut `json:"messages"`
}

func chatCutoff(now time.Time) time.Time {
	return now.Add(-time.Duration(chatRetentionDays()) * 24 * time.Hour)
}

// chatThreadRow は利用者の、期限内のスレッド。無ければ（他人のもの・期限切れ・存在しない）404。
func chatThreadRow(t *tx, threadID string, userID int, now time.Time) row {
	r := t.one("SELECT t.id, t.store_id, t.created_at, t.busy_until, s.name AS store_name FROM chat_threads t JOIN stores s ON s.id = t.store_id "+
		"WHERE t.id = $1 AND t.user_id = $2 AND t.last_activity_at > $3", threadID, userID, chatCutoff(now))
	if r == nil {
		fail(404, "not_found")
	}
	return r
}

// bumpChatUsage は利用者・日ごとの件数を 1 増やす。上限に達していれば 429。column は固定の 2 つだけ。
func bumpChatUsage(t *tx, userID int, nowLocal time.Time, column string, limit int) {
	if column != "messages" && column != "threads" {
		panic("column")
	}
	r := t.one("INSERT INTO chat_usage (user_id, usage_date, "+column+") VALUES ($1, $2, 1) "+
		"ON CONFLICT (user_id, usage_date) DO UPDATE SET "+column+" = chat_usage."+column+" + 1 WHERE chat_usage."+column+" < $3 RETURNING "+column,
		userID, dateOf(nowLocal).String(), limit)
	if r == nil {
		fail(429, "chat_rate_limited")
	}
}

// ---- スレッド ----

func createChatThread(userID, storeID int) chatThreadOut {
	purgeExpiredChats(purgeBatch) // 期限切れのスレッドを、アクセスのついでに消す（worker が無くても、保存期間が守られる）
	now, local := utcNow(), localNow()
	return inTx(func(t *tx) chatThreadOut {
		store := loadStore(t, storeID)
		if store == nil {
			fail(404, "store_not_found")
		}
		bumpChatUsage(t, userID, local, "threads", dailyThreadsPerUser)
		r := t.one("INSERT INTO chat_threads (user_id, store_id, created_at, last_activity_at) VALUES ($1, $2, $3, $4) RETURNING id, created_at", userID, storeID, now, now)
		return chatThreadOut{ID: r.s("id"), Store: storeRef{ID: store.i("id"), Name: store.s("name")}, CreatedAt: isoTime(r.t("created_at"))}
	})
}

func getChatThread(userID int, threadID string) chatThreadDetailOut {
	now := utcNow()
	return inTx(func(t *tx) chatThreadDetailOut {
		th := chatThreadRow(t, threadID, userID, now)
		msgs := t.all("SELECT id, role, content, cards::text AS cards, created_at FROM chat_messages WHERE thread_id = $1 ORDER BY id LIMIT $2", threadID, threadMaxUserMessages*2+2)
		out := chatThreadDetailOut{ID: th.s("id"), Store: storeRef{ID: th.i("store_id"), Name: th.s("store_name")}, CreatedAt: isoTime(th.t("created_at")), Messages: []chatMessageOut{}}
		for _, m := range msgs {
			out.Messages = append(out.Messages, chatMessageOut{ID: m.i("id"), Role: m.s("role"), Content: m.s("content"), Cards: json.RawMessage(m.s("cards")), CreatedAt: isoTime(m.t("created_at"))})
		}
		return out
	})
}

// deleteChatRows は子から親へ（外部キーは RESTRICT）。
func deleteChatRows(t *tx, threadIDs []string) {
	t.exec("DELETE FROM chat_tool_calls WHERE thread_id = ANY($1::uuid[])", threadIDs)
	t.exec("DELETE FROM chat_messages WHERE thread_id = ANY($1::uuid[])", threadIDs)
	t.exec("DELETE FROM chat_threads WHERE id = ANY($1::uuid[])", threadIDs)
}

// deleteChatThread は利用者が自分のスレッドを消す（発話・ツール呼び出しの記録ごと）。応答を作っている途中（貸し出し中）は 409。
func deleteChatThread(userID int, threadID string) {
	now := utcNow()
	withTx(func(t *tx) {
		th := t.one("SELECT id, busy_until FROM chat_threads WHERE id = $1 AND user_id = $2 AND last_activity_at > $3 FOR UPDATE", threadID, userID, chatCutoff(now))
		if th == nil {
			fail(404, "not_found")
		}
		if bu := th.tN("busy_until"); bu != nil && bu.After(now) {
			fail(409, "chat_busy")
		}
		deleteChatRows(t, []string{th.s("id")})
	})
}

// purgeExpiredChats は保存期間を過ぎたスレッドを、子の行ごと消す。消した数を返す。応答中のものと、別のプロセスが扱っているものは飛ばす。
func purgeExpiredChats(limit int) int {
	now := utcNow()
	ids := inTx(func(t *tx) []string {
		rows := t.all("SELECT id FROM chat_threads WHERE last_activity_at <= $1 AND (busy_until IS NULL OR busy_until <= $2) "+
			"ORDER BY last_activity_at LIMIT $3 FOR UPDATE SKIP LOCKED", chatCutoff(now), now, limit)
		var out []string
		for _, r := range rows {
			out = append(out, r.s("id"))
		}
		if len(out) > 0 {
			deleteChatRows(t, out)
		}
		return out
	})
	if len(ids) > 0 {
		logf("保存期間を過ぎた会話を %d 件、削除しました", len(ids))
	}
	return len(ids)
}

// ---- ターン ----

// beginTurn は利用者の発話を受ける。貸し出し・上限・保存を 1 つのトランザクションで行う（失敗すれば全部戻る）。404 / 409 / 429 は、応答を始める前に返す。
func beginTurn(userID int, threadID, text string) *chatTurn {
	now, local := utcNow(), localNow()
	leaseUntil := now.Add(turnLeaseSeconds * time.Second)
	refused := checkInput(text)
	stored := text
	if refused != "" {
		stored = redactedUserText // 攻撃文は、後の入力に残さない
	}
	var turn *chatTurn
	withTx(func(t *tx) {
		var guardArg any
		if refused != "" {
			guardArg = refused
		}
		th := t.one("UPDATE chat_threads SET busy_until = $1, last_activity_at = $2 "+
			"WHERE id = $3 AND user_id = $4 AND last_activity_at > $5 AND (busy_until IS NULL OR busy_until <= $6) RETURNING id, store_id",
			leaseUntil, now, threadID, userID, chatCutoff(now), now)
		if th == nil {
			if t.one("SELECT 1 FROM chat_threads WHERE id = $1 AND user_id = $2 AND last_activity_at > $3", threadID, userID, chatCutoff(now)) != nil {
				fail(409, "chat_busy")
			}
			fail(404, "not_found")
		}
		if t.one("SELECT count(*) AS n FROM chat_messages WHERE thread_id = $1 AND role = 'user'", threadID).i("n") >= threadMaxUserMessages {
			fail(409, "chat_thread_full")
		}
		bumpChatUsage(t, userID, local, "messages", dailyMessagesPerUser)
		past := t.all("SELECT role, content, cards FROM chat_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT $2", threadID, historyMessages)
		messageID := t.one("INSERT INTO chat_messages (thread_id, role, content, guard, created_at) VALUES ($1, 'user', $2, $3, $4) RETURNING id", threadID, stored, guardArg, now).i("id")
		history := make([]chatMessage, 0, len(past))
		for i := len(past) - 1; i >= 0; i-- {
			m := past[i]
			cm := chatMessage{role: m.s("role"), content: m.s("content"), meta: map[string]any{}}
			if cm.role == "assistant" {
				kinds := []any{}
				for _, c := range asList(m["cards"]) {
					if k, ok := asMap(c)["kind"]; ok {
						kinds = append(kinds, k)
					} else {
						kinds = append(kinds, nil)
					}
				}
				cm.meta = map[string]any{"card_kinds": kinds}
			}
			history = append(history, cm)
		}
		turn = &chatTurn{
			ctx:      &turnContext{threadID: th.s("id"), userID: userID, storeID: th.i("store_id"), userMessageID: messageID},
			userText: stored, refused: refused, history: history, leaseUntil: leaseUntil, started: time.Now(),
		}
	})
	return turn
}

// finishTurn は応答（ガード後の本文と、サーバーが作ったカード）を保存して、貸し出しを返す。アシスタントの発話の ID を返す。
func finishTurn(turn *chatTurn, text string, cards []any, guard string) int {
	now := utcNow()
	return inTx(func(t *tx) int {
		raw, _ := json.Marshal(emptyAnyIfNil(cards))
		var guardArg any
		if guard != "" {
			guardArg = guard
		}
		id := t.one("INSERT INTO chat_messages (thread_id, role, content, cards, guard, created_at) VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5) RETURNING id",
			turn.ctx.threadID, text, string(raw), guardArg, now).i("id")
		releaseChatLease(t, turn, now)
		return id
	})
}

func emptyAnyIfNil(a []any) []any {
	if a == nil {
		return []any{}
	}
	return a
}

// releaseTurn は応答を保存せずに、貸し出しを返す（切断・失敗）。何度呼んでもよい。
func releaseTurn(turn *chatTurn) {
	withTx(func(t *tx) { releaseChatLease(t, turn, utcNow()) })
}

// releaseChatLease は自分が取った貸し出し（期限が同じ）のときだけ返す。期限が切れて別のターンが取っていれば、触らない。
func releaseChatLease(t *tx, turn *chatTurn, now time.Time) {
	t.exec("UPDATE chat_threads SET busy_until = NULL, last_activity_at = $1 WHERE id = $2 AND busy_until = $3", now, turn.ctx.threadID, turn.leaseUntil)
}
