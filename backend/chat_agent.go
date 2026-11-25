package main

// ツールを呼ぶ会話のループ（素の Go。LangGraph・langchain は使わない。backend/app/chat/agent.py の移植）。
//
// 1 ターン（1 回の発話への応答）の流れ:
//
//	入力ガード（beginTurn で済み。拒否なら固定の文を返して終わり）
//	→ ターンの先頭で get_cart を自動で 1 回（カートの最新をモデルに見せる。docs/chat.md）
//	→ モデルを呼ぶ ⇄ ツールを実行する（定義に無い名前・引数の誤り・書き込みの上限は、executeTool が拒否する）
//	→ 出力ガード（確定の言い切り・ツール結果に無い価格・アレルギーの言い切り・プロンプトの漏洩を、固定の文に置き換える）
//	→ 発話とカードを保存して、貸し出しを返す
//
//   - モデルが返す文は、全文をガードしてから、利用者に流す（ガードを通っていない文は、画面に出ない）
//   - カードは、ツールの結果（サーバーが DB から作った値）だけから作る。モデルの文章からは作らない（確定ボタンは、確認カードにだけ付く）
//   - 上限: モデルを呼ぶ回数・ツールの呼び出し回数・書き込みの回数（chat_config.go）。超えたら、固定の文で止める
//   - 切断（cancelled）は、ステップの間で見る。切れたら、応答を保存せずに止める（ツールの書き込みは、1 つずつ commit 済みで、矛盾は残らない）
//   - ログには、種類と件数だけを出す（発話・商品・注文の中身を出さない）

import (
	"fmt"
	"strings"
	"time"
)

// chatEvent は利用者へ流すイベント。typ: text / tool_call / tool_result / card / done。
type chatEvent struct {
	typ  string
	data map[string]any
}

// compactCards は保存するカード。カートのカードは、最後の 1 枚だけ（途中の状態は、後の状態に置き換わる）。
func compactCards(cards []any) []any {
	last := -1
	for i, c := range cards {
		if cardKind(c) == "cart" {
			last = i
		}
	}
	var out []any
	for i, c := range cards {
		if cardKind(c) != "cart" || i == last {
			out = append(out, c)
		}
	}
	return out
}

func cardKind(c any) string {
	if m, ok := c.(omap); ok {
		return asStr(m.get("kind"))
	}
	return asStr(asMap(c)["kind"])
}

// chatRun は 1 ターンの状態（会話・集めた数字・カード・ガードの理由）。
type chatRun struct {
	ctx      *turnContext
	messages []chatMessage
	allowed  map[int64]bool // このターンのツール結果に出た整数（価格・合計の検査の「許す値」）
	cards    []any
	texts    []string
	guards   []string
	steps    int
	emit     func(chatEvent)
}

func (r *chatRun) nextCallID(offset int) string {
	return fmt.Sprintf("m%d-%d", r.ctx.userMessageID, r.ctx.toolCalls+1+offset)
}

func (r *chatRun) callTool(call toolCall, auto bool) {
	r.emit(chatEvent{"tool_call", map[string]any{"id": call.id, "name": call.name, "args": call.args, "auto": auto}})
	result := executeTool(r.ctx, call)
	for n := range numbersIn(result.payload) {
		r.allowed[n] = true
	}
	r.messages = append(r.messages, chatMessage{role: "tool", content: wrapUntrusted(call.name, result.payload), toolCallID: call.id, name: call.name, data: result.payload})
	var errv any
	if e, ok := result.payload["error"]; ok && e != nil && e != "" {
		errv = e
	}
	r.emit(chatEvent{"tool_result", map[string]any{"id": call.id, "name": call.name, "ok": result.ok, "summary": result.summary, "error": errv}})
	if !auto { // ターンの先頭の get_cart は、画面にカードを出さない（モデルに見せるためだけ）
		for _, card := range result.cards {
			r.cards = append(r.cards, card)
			r.emit(chatEvent{"card", map[string]any{"card": card}})
		}
	}
}

func (r *chatRun) say(text, reason string) {
	r.texts = append(r.texts, text)
	if reason != "" {
		r.guards = append(r.guards, reason)
	}
	r.emit(chatEvent{"text", map[string]any{"text": text}})
}

// runTurn は 1 ターンを実行して、利用者へ流すイベントを emit で渡す。最後に、保存した応答の ID を持つ done を渡す（切断のときは渡さない）。
func runTurn(turn *chatTurn, cancelled func() bool, emit func(chatEvent)) {
	ctx := turn.ctx
	if turn.refused != "" {
		run := &chatRun{ctx: ctx, allowed: map[int64]bool{}, emit: emit}
		run.say(inputRefusalReply, turn.refused)
		logf("入力ガードで拒否しました（thread=%s, reason=%s）", ctx.threadID, turn.refused)
		emit(finishRun(turn, run))
		return
	}

	model := getChatModel()
	run := &chatRun{ctx: ctx, allowed: map[int64]bool{}, emit: emit}
	run.messages = append(run.messages, chatMessage{role: "system", content: systemPrompt})
	run.messages = append(run.messages, turn.history...)
	run.messages = append(run.messages, chatMessage{role: "user", content: turn.userText})
	specs := toolSpecs()

	// ターンの先頭: カートの最新を、サーバーが読み直して、モデルに渡す
	first := toolCall{id: run.nextCallID(0), name: "get_cart", args: map[string]any{}}
	run.messages = append(run.messages, chatMessage{role: "assistant", toolCalls: []toolCall{first}})
	run.callTool(first, true)

	finished := false
	for i := 0; i < maxModelSteps; i++ {
		if cancelled() {
			logTurnEnd(turn, run, "cancelled", "")
			return
		}
		run.steps++
		reply, ok := safeReply(model, run.messages, specs, ctx)
		if !ok {
			run.say(failureReply, "model_error")
			finished = true
			break
		}
		text := ""
		if reply.text != nil {
			text = pyStrip(*reply.text)
		}
		if text != "" {
			verdict := checkOutput(text, run.allowed, systemPrompt)
			run.say(verdict.text, verdict.reason)
			text = verdict.text
		}
		if len(reply.toolCalls) == 0 {
			finished = true
			break
		}
		// モデルの返した呼び出しに、こちらの ID を付ける（(thread_id, tool_call_id) の冪等のため。モデルの ID には頼らない）。上限を超える分は実行しない
		room := maxToolCallsPerTurn - ctx.toolCalls
		if room < 0 {
			room = 0
		}
		var calls []toolCall
		for k, c := range reply.toolCalls {
			if k >= room {
				break
			}
			var args any = map[string]any{}
			switch m := c.args.(type) {
			case map[string]any:
				args = m
			case omap:
				args = m
			}
			calls = append(calls, toolCall{id: run.nextCallID(k), name: c.name, args: args})
		}
		over := len(reply.toolCalls) > room
		if len(calls) > 0 {
			run.messages = append(run.messages, chatMessage{role: "assistant", content: text, toolCalls: calls})
		}
		for _, call := range calls {
			if cancelled() {
				logTurnEnd(turn, run, "cancelled", "")
				return
			}
			run.callTool(call, false)
		}
		if over {
			run.say(limitReply, "tool_call_limit")
			finished = true
			break
		}
	}
	if !finished {
		run.say(limitReply, "model_step_limit")
	}
	if len(run.texts) == 0 {
		run.say(emptyReply, "empty_reply")
	}
	emit(finishRun(turn, run))
}

// safeReply はモデルを呼ぶ。失敗したら、種類だけをログに残して ok=false（例外の本文は出さない）。
func safeReply(model chatModel, messages []chatMessage, specs []toolSpec, ctx *turnContext) (reply modelReply, ok bool) {
	defer func() {
		if rec := recover(); rec != nil {
			logf("モデルの呼び出しに失敗しました（%s, thread=%s）", panicKind(rec), ctx.threadID)
			ok = false
		}
	}()
	return model.reply(messages, specs), true
}

func finishRun(turn *chatTurn, run *chatRun) chatEvent {
	text := strings.Join(run.texts, "\n")
	seen := map[string]bool{}
	var uniq []string
	for _, g := range run.guards {
		if !seen[g] {
			seen[g] = true
			uniq = append(uniq, g)
		}
	}
	guard := strings.Join(uniq, ",")
	messageID := finishTurn(turn, text, compactCards(run.cards), guard)
	logTurnEnd(turn, run, "ok", guard)
	var guardV any
	if guard != "" {
		guardV = guard
	}
	return chatEvent{"done", map[string]any{"message_id": messageID, "guard": guardV}}
}

func logTurnEnd(turn *chatTurn, run *chatRun, status, guard string) {
	g := "None"
	if guard != "" {
		g = guard
	}
	logf("チャットのターン thread=%s status=%s steps=%d tools=%d writes=%d guard=%s ms=%d",
		turn.ctx.threadID, status, run.steps, turn.ctx.toolCalls, turn.ctx.writes, g, time.Since(turn.started).Milliseconds())
}
