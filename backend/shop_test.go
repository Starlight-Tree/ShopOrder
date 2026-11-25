package main

// API を通して試すための道具（backend/tests/helpers.py・chat_helpers.py の移植）。サーバーは、同じプロセスの中で動かす（httptest）。DB の確認と準備だけ、直接読み書きする。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type testShop struct {
	t        *testing.T
	srv      *server
	stores   map[string]int
	variants map[[3]string]int
}

var userCounter atomic.Int64

// newShop は DB（テンプレートの複製）を開き、サーバーを作る。時計は実時間（必要なテストが、自分で固定する）。
func newShop(t *testing.T) *testShop {
	t.Helper()
	newTestDB(t)
	s := &testShop{t: t, srv: newServer(func(string, ...any) {}), stores: map[string]int{}, variants: map[[3]string]int{}}
	var stores []map[string]any
	s.getJSON("/api/stores", nil, &stores)
	for _, st := range stores {
		s.stores[st["code"].(string)] = int(st["id"].(float64))
	}
	var menu []map[string]any
	s.getJSON("/api/menu", nil, &menu)
	for _, it := range menu {
		for _, v := range it["variants"].([]any) {
			vm := v.(map[string]any)
			s.variants[[3]string{it["code"].(string), vm["size"].(string), vm["temperature"].(string)}] = int(vm["id"].(float64))
		}
	}
	return s
}

func (s *testShop) storeID(code string) int { return s.stores[code] }

func (s *testShop) variant(code string, size, temp string) int {
	id, ok := s.variants[[3]string{code, size, temp}]
	if !ok {
		s.t.Fatalf("変種が無い: %s %s %s", code, size, temp)
	}
	return id
}

// user は新しい顧客のヘッダー（X-Dev-User）。
func (s *testShop) user() map[string]string {
	return map[string]string{"X-Dev-User": fmt.Sprintf("t-%d-%d", userCounter.Add(1), len(s.stores))}
}

func (s *testShop) do(method, path string, headers map[string]string, body any) (int, []byte, http.Header) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.srv.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes(), rec.Header()
}

func (s *testShop) getJSON(path string, headers map[string]string, out any) int {
	code, b, _ := s.do("GET", path, headers, nil)
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			s.t.Fatalf("GET %s: %v (%s)", path, err, b)
		}
	}
	return code
}

func (s *testShop) must(method, path string, headers map[string]string, body any, want int) map[string]any {
	s.t.Helper()
	code, b, _ := s.do(method, path, headers, body)
	if code != want {
		s.t.Fatalf("%s %s: %d (want %d): %s", method, path, code, want, b)
	}
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func withHeader(h map[string]string, k, v string) map[string]string {
	out := map[string]string{}
	for a, b := range h {
		out[a] = b
	}
	out[k] = v
	return out
}

var keyCounter atomic.Int64

// fillCart はカートの店を決めて、品を入れる（lines: 変種 ID・数量）。
func (s *testShop) fillCart(h map[string]string, store string, lines [][2]int) {
	s.t.Helper()
	s.must("PUT", "/api/cart", h, map[string]any{"store_id": s.storeID(store), "fulfillment": "pickup"}, 200)
	for _, l := range lines {
		s.must("PUT", fmt.Sprintf("/api/cart/items/%d", l[0]), h, map[string]any{"qty": l[1]}, 200)
	}
}

func (s *testShop) proposal(h map[string]string, store string, lines [][2]int) map[string]any {
	s.t.Helper()
	s.fillCart(h, store, lines)
	return s.must("POST", "/api/cart/checkout-proposal", h, nil, 200)
}

func (s *testShop) place(h map[string]string, proposalID string) (int, map[string]any) {
	code, b, _ := s.do("POST", "/api/orders", withHeader(h, "Idempotency-Key", fmt.Sprintf("test-key-%06d", keyCounter.Add(1))), map[string]any{"proposal_id": proposalID})
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return code, out
}

// order はカート → 提案 → 確定まで通して、placed の注文を返す。
func (s *testShop) order(h map[string]string, store string, lines [][2]int) map[string]any {
	s.t.Helper()
	p := s.proposal(h, store, lines)
	key := fmt.Sprintf("test-key-%06d", keyCounter.Add(1))
	return s.must("POST", "/api/orders", withHeader(h, "Idempotency-Key", key), map[string]any{"proposal_id": p["id"]}, 201)
}

func (s *testShop) paidOrder(h map[string]string, store string, lines [][2]int) map[string]any {
	s.t.Helper()
	o := s.order(h, store, lines)
	return s.must("POST", fmt.Sprintf("/api/orders/%s/pay", o["public_id"]), h, nil, 200)
}

// setAvailable は今出せる量（on_hand - reserved - safety_stock）を、台帳の adjust で指定の数にする（台帳と残高を合わせたまま）。
func (s *testShop) setAvailable(store, itemCode string, available int) {
	s.t.Helper()
	withTx(func(t *tx) {
		item := t.one("SELECT id, safety_stock FROM stock_items WHERE code = $1", itemCode)
		bal := t.one("SELECT on_hand, reserved FROM stock_balances WHERE store_id = $1 AND item_id = $2", s.storeID(store), item.i("id"))
		delta := (bal.i("reserved") + item.i("safety_stock") + available) - bal.i("on_hand")
		if delta != 0 {
			if short := adjustStock(t, s.storeID(store), item.i("id"), delta, "テストの準備", "test", utcNow()); short != nil {
				s.t.Fatal("在庫を調整できません")
			}
		}
	})
}

// ---- チャット ----

type chatReply struct {
	status int
	chunks []map[string]any
	done   bool
	body   map[string]any
}

func (r chatReply) text() string {
	var b strings.Builder
	for _, c := range r.chunks {
		if c["type"] == "text-delta" {
			b.WriteString(c["delta"].(string))
		}
	}
	return b.String()
}

func (r chatReply) tools() []string {
	out := []string{}
	for _, c := range r.chunks {
		if c["type"] == "tool-input-available" {
			out = append(out, c["toolName"].(string))
		}
	}
	return out
}

func (r chatReply) cards() []map[string]any {
	out := []map[string]any{}
	for _, c := range r.chunks {
		if c["type"] == "data-card" {
			out = append(out, c["data"].(map[string]any))
		}
	}
	return out
}

func (r chatReply) guard() string {
	for _, c := range r.chunks {
		if c["type"] == "finish" {
			if md, ok := c["messageMetadata"].(map[string]any); ok {
				if g, ok := md["guard"].(string); ok {
					return g
				}
			}
		}
	}
	return ""
}

type testChat struct {
	s       *testShop
	headers map[string]string
	id      string
	store   string
}

func (s *testShop) newChat(h map[string]string, store string) *testChat {
	out := s.must("POST", "/api/chat/threads", h, map[string]any{"store_id": s.storeID(store)}, 201)
	return &testChat{s: s, headers: h, id: out["id"].(string), store: out["store"].(map[string]any)["name"].(string)}
}

func (c *testChat) say(content string) chatReply {
	code, b, hdr := c.s.do("POST", "/api/chat/threads/"+c.id+"/messages", c.headers, map[string]any{"content": content})
	r := chatReply{status: code}
	if !strings.Contains(hdr.Get("Content-Type"), "event-stream") {
		_ = json.Unmarshal(b, &r.body)
		return r
	}
	for _, block := range strings.Split(string(b), "\n\n") {
		block = strings.TrimSpace(block)
		switch {
		case block == "" || strings.HasPrefix(block, ":"):
		case block == "data: [DONE]":
			r.done = true
		case strings.HasPrefix(block, "data: "):
			var chunk map[string]any
			if err := json.Unmarshal([]byte(block[6:]), &chunk); err != nil {
				c.s.t.Fatal(err)
			}
			r.chunks = append(r.chunks, chunk)
		}
	}
	return r
}

func (c *testChat) cart() map[string]any {
	var out map[string]any
	c.s.getJSON("/api/cart", c.headers, &out)
	return out
}

// ---- 偽のモデル ----

type scriptedModel struct {
	script []any // modelReply か func(messages []chatMessage) modelReply
	calls  int
}

func (m *scriptedModel) reply(messages []chatMessage, tools []toolSpec) modelReply {
	var step any = modelReply{text: ptr("おわりました。")}
	if m.calls < len(m.script) {
		step = m.script[m.calls]
	}
	m.calls++
	if f, ok := step.(func([]chatMessage) modelReply); ok {
		return f(messages)
	}
	return step.(modelReply)
}

func sayReply(text string) modelReply { return modelReply{text: &text} }

func callReply(name string, args map[string]any) modelReply {
	return modelReply{toolCalls: []toolCall{{id: "x", name: name, args: args}}}
}

func installModel(m chatModel) { chatModelOverride = func() chatModel { return m } }
