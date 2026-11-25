package main

// Python の API の応答（testdata/golden_api.json。592 の要求）を、Go の API に同じ要求を流して比べる。時計は固定（goldenNow）。
// golden の作り方: 旧 Python の API（git show 4dc1c0f 相当の backend/ の履歴を参照）を TestClient で動かし、同じ場面を流して、
// 要求と正規化した応答（乱数の ID・トークン・暗証コードは、現れた順に名前を付けて伏せる）を JSON に書き出した。記録の道具は削除した（作り直すときは、書き直す）。
//
// 乱数の ID（公開 ID・UUID）・トークン・暗証コードは、両側でそれぞれ違うので、現れた順に <ORD#1> のように名前を付けて伏せてから比べる。
// 応答の項目の順・数値の表記も比べる（JSON を、順序を保ったまま正規化して、文字列で比べる）。

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// ---- 順序つきの JSON ----

type oobj struct {
	keys []string
	vals []any
}

func decodeOrdered(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return readOrdered(dec)
}

func readOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch x := tok.(type) {
	case json.Delim:
		switch x {
		case '{':
			o := &oobj{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				v, err := readOrdered(dec)
				if err != nil {
					return nil, err
				}
				o.keys = append(o.keys, kt.(string))
				o.vals = append(o.vals, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := readOrdered(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
	}
	return tok, nil
}

// pyJSONString は Python の json.dumps(ensure_ascii=False) の文字列表記。
func pyJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteString(strconv.FormatInt(int64(r)+0x100, 16)[1:])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func encodeOrdered(v any) string {
	switch x := v.(type) {
	case *oobj:
		var b strings.Builder
		b.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(pyJSONString(k))
			b.WriteByte(':')
			b.WriteString(encodeOrdered(x.vals[i]))
		}
		b.WriteByte('}')
		return b.String()
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = encodeOrdered(e)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case string:
		return pyJSONString(x)
	case json.Number:
		return x.String()
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	}
	panic("encodeOrdered")
}

// ---- 乱数の値を伏せる（Python の記録と同じ規則）----

var (
	uuidValueRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	pubIDRe     = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{8}$`)
	placeholder = regexp.MustCompile(`\{\{([\w#-]+)\}\}`)
)

type masker struct {
	order   []string // 値の出現順
	labels  map[string]string
	counter map[string]int
}

func newMasker() *masker { return &masker{labels: map[string]string{}, counter: map[string]int{}} }

func (m *masker) label(kind, value string) string {
	if l, ok := m.labels[value]; ok {
		return l
	}
	m.counter[kind]++
	l := "<" + kind + "#" + strconv.Itoa(m.counter[kind]) + ">"
	m.labels[value] = l
	m.order = append(m.order, value)
	return l
}

func (m *masker) mask(v any, key string) any {
	switch x := v.(type) {
	case *oobj:
		out := &oobj{keys: x.keys, vals: make([]any, len(x.vals))}
		for i, e := range x.vals {
			out.vals[i] = m.mask(e, x.keys[i])
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = m.mask(e, key)
		}
		return out
	case string:
		if l, ok := m.labels[x]; ok {
			return l
		}
		for _, val := range append([]string(nil), m.order...) {
			if utf8.RuneCountInString(val) >= 8 && strings.Contains(x, val) {
				x = strings.ReplaceAll(x, val, m.labels[val])
			}
		}
		switch {
		case key == "token":
			return "<TOKEN>"
		case key == "pin":
			return "<PIN>"
		case uuidValueRe.MatchString(x):
			return m.label("UUID", x)
		case key == "public_id" && pubIDRe.MatchString(x):
			return m.label("ORD", x)
		}
		return x
	}
	return v
}

// ---- 場面の再生 ----

type goldenStep struct {
	Op       string            `json:"op"`
	At       string            `json:"at"`
	Name     string            `json:"name"`
	Value    string            `json:"value"`
	Scenario string            `json:"scenario"`
	Method   string            `json:"method"`
	Path     string            `json:"path"`
	Headers  map[string]string `json:"headers"`
	Body     json.RawMessage   `json:"body"`
	Content  *string           `json:"content"`
	Binds    [][]string        `json:"binds"`
	Expect   struct {
		Status  int               `json:"status"`
		Ctype   string            `json:"ctype"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	} `json:"expect"`
}

type replayer struct {
	t    *testing.T
	srv  *server
	vals map[string]string
	mask *masker
	envs map[string]*string // 変更した環境変数の元の値
}

func (r *replayer) substitute(s string) string {
	return placeholder.ReplaceAllStringFunc(s, func(m string) string {
		name := placeholder.FindStringSubmatch(m)[1]
		v, ok := r.vals[name]
		if !ok {
			r.t.Fatalf("未設定の名前: %s", name)
		}
		return v
	})
}

func (r *replayer) substituteJSON(v any) any {
	switch x := v.(type) {
	case string:
		return r.substitute(x)
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = r.substituteJSON(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = r.substituteJSON(e)
		}
		return out
	}
	return v
}

var headerKeys = []string{"allow", "access-control-allow-origin", "vary", "location", "x-vercel-ai-ui-message-stream", "cache-control"}

func normalizeResponse(m *masker, rec *httptest.ResponseRecorder) (status int, ctype string, headers map[string]string, body string, parsed any) {
	status = rec.Code
	ct := rec.Header().Get("Content-Type")
	ctype = strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	headers = map[string]string{}
	for _, k := range headerKeys {
		if v := rec.Header().Get(k); v != "" {
			if k == "location" {
				v = regexp.MustCompile(`^http://[^/]+`).ReplaceAllString(v, "http://HOST")
			}
			headers[k] = v
		}
	}
	raw := rec.Body.Bytes()
	switch {
	case strings.Contains(ct, "event-stream"):
		var events []any
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "data: ") {
				payload := line[6:]
				if payload == "[DONE]" {
					events = append(events, payload)
					continue
				}
				v, err := decodeOrdered([]byte(payload))
				if err != nil {
					panic(err)
				}
				events = append(events, m.mask(v, ""))
			}
		}
		if events == nil {
			events = []any{}
		}
		return status, ctype, headers, encodeOrdered(events), nil
	case strings.Contains(ct, "json"):
		v, err := decodeOrdered(raw)
		if err != nil {
			panic(err)
		}
		var plain any
		_ = json.Unmarshal(raw, &plain)
		return status, ctype, headers, encodeOrdered(m.mask(v, "")), plain
	}
	return status, ctype, headers, encodeOrdered(string(raw)), nil
}

func jsonPath(v any, path string) any {
	for _, part := range strings.Split(path, ".") {
		switch x := v.(type) {
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(x) {
				return nil
			}
			v = x[i]
		case map[string]any:
			e, ok := x[part]
			if !ok {
				return nil
			}
			v = e
		default:
			return nil
		}
	}
	return v
}

func valueString(v any) string {
	switch x := v.(type) {
	case nil:
		return "None" // Python の str(None)。取り出せなかった値を、そのまま要求に入れる場面がある（先の確認が失敗したとき）
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return ""
}

func (r *replayer) setEnv(name, value string) {
	if _, saved := r.envs[name]; !saved {
		if old, ok := os.LookupEnv(name); ok {
			r.envs[name] = &old
		} else {
			r.envs[name] = nil
		}
	}
	if value == "" {
		os.Unsetenv(name)
	} else {
		os.Setenv(name, value)
	}
}

func (r *replayer) restoreEnv() {
	for k, v := range r.envs {
		if v == nil {
			os.Unsetenv(k)
		} else {
			os.Setenv(k, *v)
		}
	}
}

// firstDiff は 2 つの文字列の最初の違いの周辺。
func firstDiff(a, b string) string {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	i := 0
	for i < n && a[i] == b[i] {
		i++
	}
	lo := i - 60
	if lo < 0 {
		lo = 0
	}
	cut := func(s string) string {
		hi := i + 120
		if hi > len(s) {
			hi = len(s)
		}
		if lo > len(s) {
			return ""
		}
		return s[lo:hi]
	}
	return "…" + cut(a) + "\n  Go    : …" + cut(b)
}

func TestGoldenAPI(t *testing.T) {
	newTestDB(t)
	raw, err := os.ReadFile("testdata/golden_api.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Steps []goldenStep `json:"steps"`
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	freezeClock(&goldenNow)
	r := &replayer{t: t, srv: newServer(func(string, ...any) {}), vals: map[string]string{}, mask: newMasker(), envs: map[string]*string{}}
	defer r.restoreEnv()
	failures := 0
	for i, s := range golden.Steps {
		switch s.Op {
		case "clock":
			at, err := parseISO(s.At)
			if err != nil {
				t.Fatal(err)
			}
			freezeClock(&at)
			continue
		case "env":
			r.setEnv(s.Name, s.Value)
			continue
		}
		var body io.Reader
		hdr := http.Header{}
		for k, v := range s.Headers {
			hdr.Set(k, r.substitute(v))
		}
		switch {
		case len(s.Body) > 0 && string(s.Body) != "null":
			var v any
			if err := json.Unmarshal(s.Body, &v); err != nil {
				t.Fatal(err)
			}
			b, _ := json.Marshal(r.substituteJSON(v))
			body = bytes.NewReader(b)
			if hdr.Get("Content-Type") == "" {
				hdr.Set("Content-Type", "application/json")
			}
		case s.Content != nil:
			body = strings.NewReader(*s.Content)
		}
		req := httptest.NewRequest(s.Method, r.substitute(s.Path), body)
		for k, vs := range hdr {
			req.Header[k] = vs
		}
		rec := httptest.NewRecorder()
		r.srv.ServeHTTP(rec, req)
		status, ctype, headers, bodyText, parsed := normalizeResponse(r.mask, rec)
		ok := status == s.Expect.Status && ctype == s.Expect.Ctype && bodyText == s.Expect.Body && sameHeaders(headers, s.Expect.Headers)
		if !ok {
			failures++
			if failures <= 25 {
				t.Errorf("[%s] #%d %s: %s %s\n  status %d (want %d) ctype %q (want %q) headers %v (want %v)\n  Python: %s", s.Scenario, i, s.Name, s.Method, s.Path,
					status, s.Expect.Status, ctype, s.Expect.Ctype, headers, s.Expect.Headers, firstDiff(s.Expect.Body, bodyText))
			}
		}
		for _, b := range s.Binds {
			switch {
			case len(b) == 2:
				r.vals[b[0]] = valueString(jsonPath(parsed, b[1]))
			case len(b) == 3 && b[1] == "other4":
				if r.vals[b[2]] != "0000" {
					r.vals[b[0]] = "0000"
				} else {
					r.vals[b[0]] = "1111"
				}
			}
		}
	}
	if failures > 0 {
		t.Fatalf("%d 件の応答が Python と違います", failures)
	}
	// 場面のあとも、台帳（追記のみ）から再計算した在庫と、残高が合う
	if rows := inTx(func(tx *tx) []row { return reconcileStock(tx) }); len(rows) != 0 {
		t.Errorf("台帳と残高の食い違い: %v", rows)
	}
}

func sameHeaders(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func parseISO(s string) (time.Time, error) { return time.Parse(time.RFC3339Nano, s) }
