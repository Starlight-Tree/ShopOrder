package main

// チャット（P3）の API（backend/app/routes/chat.py の移植）。利用者はセッション（顧客）から決め、スレッドは、いつもその利用者のものだけ（他人のものは 404）。
// AI は、カートの下書きと確認カードまでしか作れない。注文の確定は、画面の確定ボタン → POST /api/orders だけ（docs/decisions/0003）。

import (
	"net/http"
	"sync/atomic"
	"time"
)

func (s *server) routesChat() {
	s.route("/api/chat/threads", on("POST", s.createThreadH))
	s.route("/api/chat/threads/{thread_id}", on("GET", s.getThreadH), on("DELETE", s.deleteThreadH))
	s.route("/api/chat/threads/{thread_id}/messages", on("POST", s.postMessageH))
}

func (s *server) createThreadH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	c := currentCustomer(r)
	var v validation
	br := v.object(b)
	storeID := int64(0)
	if br != nil {
		storeID, _ = br.intField("store_id", intOpts{required: true, ge: i64(1)})
	}
	v.finish(br)
	writeJSON(w, http.StatusCreated, createChatThread(c.id, int(storeID)), nil)
}

func (s *server) getThreadH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	var v validation
	id, _ := v.pathUUID("thread_id", r.PathValue("thread_id"))
	v.finish(nil)
	writeJSON(w, http.StatusOK, getChatThread(c.id, id), nil)
}

func (s *server) deleteThreadH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	var v validation
	id, _ := v.pathUUID("thread_id", r.PathValue("thread_id"))
	v.finish(nil)
	deleteChatThread(c.id, id)
	w.WriteHeader(http.StatusNoContent)
}

// postMessageH は利用者の発話を受けて、応答を SSE で返す。貸し出し・上限・保存（404 / 409 / 429）は、応答を始める前に HTTP で返す。
func (s *server) postMessageH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	c := currentCustomer(r)
	var v validation
	threadID, _ := v.pathUUID("thread_id", r.PathValue("thread_id"))
	br := v.object(b)
	content := ""
	if br != nil {
		content, _ = br.strField("content", strOpts{required: true, min: 1, max: messageMaxChars})
		if content != "" && pyStrip(content) == "" {
			br.add("value_error", "content", "Value error, blank", content)
		}
		content = pyStrip(content)
	}
	v.finish(br)
	turn := beginTurn(c.id, threadID, content)
	s.streamTurn(w, r, turn)
}

// streamTurn はターンを別の goroutine で動かし（モデル・DB は同期）、イベントを SSE で流す。イベントを待つ間は、一定の間隔で ping を送る。
func (s *server) streamTurn(w http.ResponseWriter, r *http.Request, turn *chatTurn) {
	flusher, _ := w.(http.Flusher)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	for k, v := range uiStreamHeaders {
		h.Set(k, v)
	}
	w.WriteHeader(http.StatusOK)

	var cancel atomic.Bool
	events := make(chan any, 64) // chatEvent・error・nil（終わり）
	stopped := make(chan struct{})
	defer close(stopped)
	send := func(x any) { // 受け手が先に抜けても（切断）、送り手が止まらない
		select {
		case events <- x:
		case <-stopped:
		}
	}
	go func() {
		defer func() {
			if rec := recover(); rec != nil { // 例外は、種類だけログに残して、固定の文で伝える
				logf("チャットのターンが失敗しました（%s, thread=%s）", panicKind(rec), turn.ctx.threadID)
				send(errTurnFailed{})
			}
			func() {
				defer func() {
					if recover() != nil {
						logf("貸し出しを返せませんでした。期限で外れます")
					}
				}()
				releaseTurn(turn) // 保存済みなら何もしない。切断・失敗のときは、貸し出しを返す
			}()
			send(nil)
		}()
		runTurn(turn, cancel.Load, func(e chatEvent) { send(e) })
	}()
	defer cancel.Store(true) // 切断のときは、ターンをステップの間で止める。正常終了なら、すでに終わっている

	write := func(b []byte) bool {
		if _, err := w.Write(b); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	ui := &uiMessageStream{messageID: newUUIDv4(), threadID: turn.ctx.threadID}
	for _, ch := range ui.start() {
		if !write(encodeChunk(ch)) {
			return
		}
	}
	var done *chatEvent
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !write(sseKeepalive) {
				return
			}
		case item := <-events:
			ticker.Reset(keepaliveInterval)
			switch x := item.(type) {
			case nil:
				for _, ch := range ui.finish(done) {
					if !write(encodeChunk(ch)) {
						return
					}
				}
				write(sseDone)
				return
			case errTurnFailed:
				for _, ch := range ui.errorChunk(failureReply) {
					write(encodeChunk(ch))
				}
				write(sseDone)
				return
			case chatEvent:
				if x.typ == "done" {
					e := x
					done = &e
					continue
				}
				for _, ch := range ui.feed(x) {
					if !write(encodeChunk(ch)) {
						return
					}
				}
			}
		}
	}
}

type errTurnFailed struct{}
