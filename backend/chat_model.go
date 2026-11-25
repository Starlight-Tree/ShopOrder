package main

// ChatModel（差し替え口）。会話の履歴とツールの定義を受け取り、アシスタントの文かツール呼び出しを返す（docs/decisions/0005。backend/app/chat/model.py の移植）。
//   - 既定は模擬（CHAT_MODEL=mock。chat_mock.go。決定的な規則ベース）。実 API（Gemini）は P6 で、承認を得てから書く。
//     設定の選択肢（providers）に 'gemini' はあるが、実装が無いので、選ぶと起動時に明確なエラーにする（模擬へ黙って落とさない）
//   - モデルは、書き込みの安全を自分で担わない。ツールの検証・上限・出力ガードは、モデルの外（chat_tools.go・chat_guardrails.go・chat_agent.go）が行う

import (
	"bytes"
	"encoding/json"
)

// toolSpec はモデルに見せるツールの定義。parameters は JSON Schema。
type toolSpec struct {
	name, description string
	parameters        map[string]any
}

type toolCall struct {
	id, name string
	args     any // 辞書とは限らない（モデルが返した値のまま）
}

// chatMessage は会話の 1 件。role: system / user / assistant / tool。
//   - tool: toolCallID と name が対応する呼び出しを指す。content はモデルが読む文（信頼できないデータの包みつき）、data は構造化した結果
//   - assistant: toolCalls を持つことがある。meta は、履歴の補足（例 card_kinds = その発話に付いたカードの種類）
type chatMessage struct {
	role       string
	content    string
	toolCalls  []toolCall
	toolCallID string
	name       string
	data       map[string]any
	meta       map[string]any
}

// modelReply は text か toolCalls のどちらか（両方もありうる）。toolCalls が空なら、これが最終の応答。
type modelReply struct {
	text      *string
	toolCalls []toolCall
}

type chatModel interface {
	reply(messages []chatMessage, tools []toolSpec) modelReply
}

// getChatModel は設定で選んだモデル。テストは、変数 chatModelOverride を差し替えて偽物を渡す（agent は getChatModel() を呼ぶ）。
var chatModelOverride func() chatModel

func getChatModel() chatModel {
	if chatModelOverride != nil {
		return chatModelOverride()
	}
	selected := provider("CHAT_MODEL") // 許さない値は設定ミス
	if selected == "mock" {
		return mockChatModel{}
	}
	settingsFail("CHAT_MODEL=%s はまだ実装されていません（実 API は P6。ユーザーの承認を得てから実装します）。CHAT_MODEL=mock にしてください", selected)
	return nil
}

func checkStartupChat() {
	getChatModel()
	chatRetentionDays()
}

// ---- JSON の「素の値」への変換（Python の dict・list・数値と同じように扱う）----

// plain は値を JSON に直して、map[string]any・[]any・json.Number・string・bool・nil に読み戻す。
func plain(v any) any {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var out any
	if err := dec.Decode(&out); err != nil {
		panic(err)
	}
	return out
}

func plainMap(v any) map[string]any {
	m, _ := plain(v).(map[string]any)
	return m
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func asStr(v any) string {
	s, _ := v.(string)
	return s
}

func asInt(v any) int {
	switch x := v.(type) {
	case json.Number:
		n, _ := x.Int64()
		return int(n)
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	}
	return 0
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}
