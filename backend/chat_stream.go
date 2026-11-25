package main

// POST /api/chat/threads/{id}/messages の応答（SSE。AI SDK の UI message stream v1 に寄せた形）の組み立て（backend/app/chat/stream.py の移植）。
//
// 形式: text/event-stream。1 チャンクは `data: <JSON>` の行と空行で、最後に `data: [DONE]`。イベントが無い間は、コメント行 `: ping` を送る。
// ヘッダー x-vercel-ai-ui-message-stream: v1 を付ける。ここは純粋な変換で、DB もモデルも知らない。
//
// チャンクの並び（正常時）:
//
//	start（messageId、messageMetadata = {thread_id}）
//	[ターンの先頭] tool-input-available / tool-output-available（get_cart。toolName = get_cart、auto = true）
//	[モデルの文があれば] text-start → text-delta … → text-end
//	[ツール呼び出しごと] tool-input-available → tool-output-available（output = {ok, summary, error?}）→ data-card（data = {kind: …}。サーバーがツールの結果から作る）
//	finish（messageMetadata = {message_id, guard}）
//	[DONE]
//
//   - 本文は、ガードを通った全文だけが流れる（text-delta は、全文を textChunkChars ごとに分けたもの）
//   - 失敗のときは error（errorText。固定の文）を送って [DONE]。切断は失敗ではない（サーバーは止めるだけ）
//   - ツールの出力は、要約だけ（結果の中身は、カードで出す）

import (
	"bytes"
	"encoding/json"
	"fmt"
)

var (
	uiStreamHeaders = map[string]string{
		"x-vercel-ai-ui-message-stream": "v1",
		"cache-control":                 "no-cache, no-transform",
		"x-accel-buffering":             "no", // nginx 系のプロキシに、応答を溜めずにそのまま流させる
	}
	sseDone      = []byte("data: [DONE]\n\n")
	sseKeepalive = []byte(": ping\n\n") // SSE のコメント行。クライアントは無視する。無通信でプロキシに切られないようにする
)

// okv は順序つきの JSON の項目（Python の dict の挿入順を保つ）。
type okv struct {
	k string
	v any
}

type omap []okv

func (m omap) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range m {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(e.k)
		b.Write(kb)
		b.WriteByte(':')
		b.Write(marshalNoEscape(e.v))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// get は項目の値（無ければ nil）。
func (m omap) get(key string) any {
	for _, e := range m {
		if e.k == key {
			return e.v
		}
	}
	return nil
}

// toMap は（入れ子の omap も）ふつうの map にする。引数の検査が使う。
func (m omap) toMap() map[string]any {
	out := make(map[string]any, len(m))
	for _, e := range m {
		out[e.k] = unorder(e.v)
	}
	return out
}

func unorder(v any) any {
	switch x := v.(type) {
	case omap:
		return x.toMap()
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = unorder(e)
		}
		return out
	}
	return v
}

func encodeChunk(chunk omap) []byte {
	return []byte("data: " + string(marshalNoEscape(chunk)) + "\n\n")
}

type uiMessageStream struct {
	messageID, threadID string
	parts               int
}

func (s *uiMessageStream) start() []omap {
	return []omap{{{"type", "start"}, {"messageId", s.messageID}, {"messageMetadata", omap{{"thread_id", s.threadID}}}}}
}

func (s *uiMessageStream) feed(e chatEvent) []omap {
	d := e.data
	switch e.typ {
	case "text":
		partID := fmt.Sprintf("text-%d", s.parts)
		s.parts++
		runes := []rune(d["text"].(string))
		out := []omap{{{"type", "text-start"}, {"id", partID}}}
		for i := 0; i < len(runes); i += textChunkChars {
			end := i + textChunkChars
			if end > len(runes) {
				end = len(runes)
			}
			out = append(out, omap{{"type", "text-delta"}, {"id", partID}, {"delta", string(runes[i:end])}})
		}
		return append(out, omap{{"type", "text-end"}, {"id", partID}})
	case "tool_call":
		return []omap{{{"type", "tool-input-available"}, {"toolCallId", d["id"]}, {"toolName", d["name"]}, {"input", d["args"]},
			{"providerMetadata", omap{{"shopOrder", omap{{"auto", d["auto"]}}}}}}}
	case "tool_result":
		output := omap{{"ok", d["ok"]}, {"summary", d["summary"]}}
		if d["error"] != nil {
			output = append(output, okv{"error", d["error"]})
		}
		return []omap{{{"type", "tool-output-available"}, {"toolCallId", d["id"]}, {"output", output}}}
	case "card":
		return []omap{{{"type", "data-card"}, {"data", d["card"]}}}
	}
	return nil
}

func (s *uiMessageStream) finish(done *chatEvent) []omap {
	meta := omap{}
	if done != nil {
		meta = omap{{"message_id", done.data["message_id"]}, {"guard", done.data["guard"]}}
	}
	return []omap{{{"type", "finish"}, {"messageMetadata", meta}}}
}

func (s *uiMessageStream) errorChunk(text string) []omap {
	return []omap{{{"type", "error"}, {"errorText", text}}}
}
