package main

// HTTP の入口（backend/app/main.py と FastAPI の挙動の移植）。経路・応答の形・エラーの文は、Python の API と同じにする。
//   - 応答の JSON は compact（非 ASCII もそのまま）。項目の順は pydantic のモデルと同じ
//   - 404 は {"detail":"Not Found"}、405 は {"detail":"Method Not Allowed"} + Allow
//   - 422 は {"detail":[{"loc","msg","type"}]}。入力の値は返さない（main.py の invalid_input）
//   - 500 は {"detail":{"code":"internal_error","message":固定の文}}（CORS の外側で作られるので、Vary も Allow-Origin も付かない）
//   - エラー本文は固定の文。例外の文字列・パス・接続先を応答にもログにも出さない
//   - 処理の中の失敗は panic（*apiError・*httpError・dbError）で投げ、route が受けて応答にする（Python の例外と同じ）

import (
	"bytes"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"unicode"
)

// issue は 422 の 1 件。入力の値（Input・Ctx）は、応答に出さない（内部の記録だけ）。
type issue struct {
	Loc   []any          `json:"loc"`
	Msg   string         `json:"msg"`
	Type  string         `json:"type"`
	Input any            `json:"-"`
	Ctx   map[string]any `json:"-"`
}

type httpError struct {
	status int
	detail string
	header map[string]string
	issues []issue // 422 のとき
}

func (e *httpError) Error() string { return e.detail }

func newHTTPError(status int, detail string) *httpError {
	return &httpError{status: status, detail: detail}
}

func writeJSON(w http.ResponseWriter, status int, body any, header map[string]string) {
	out := marshalNoEscape(body)
	w.Header().Set("Content-Type", "application/json")
	for k, v := range header {
		w.Header().Set(k, v)
	}
	w.WriteHeader(status)
	_, _ = w.Write(out)
}

func writeRaw(w http.ResponseWriter, status int, raw []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func writeAPIError(w http.ResponseWriter, e *apiError) {
	var b bytes.Buffer
	b.WriteString(`{"detail":`)
	b.Write(e.detailJSON())
	b.WriteByte('}')
	writeRaw(w, e.status, b.Bytes())
}

func writeInternalError(w http.ResponseWriter) {
	// 500 は CORS の外側（ServerErrorMiddleware）で作られるので、Vary も Allow-Origin も付かない
	w.Header().Del("Vary")
	w.Header().Del("Access-Control-Allow-Origin")
	e := newAPIError(http.StatusInternalServerError, "internal_error")
	writeAPIError(w, e)
}

func writeError(w http.ResponseWriter, e *httpError) {
	if e.issues != nil {
		writeJSON(w, e.status, map[string]any{"detail": e.issues}, e.header)
		return
	}
	writeJSON(w, e.status, map[string]string{"detail": e.detail}, e.header)
}

func validationFail(is ...issue) *httpError {
	return &httpError{status: http.StatusUnprocessableEntity, detail: "Unprocessable Entity", issues: is}
}

// ---- 422（pydantic v2 の整数・文字列の検査）----

type validation struct{ issues []issue }

func (v *validation) err() *httpError {
	if len(v.issues) == 0 {
		return nil
	}
	return &httpError{status: http.StatusUnprocessableEntity, detail: "Unprocessable Entity", issues: v.issues}
}

// parsePyInt は pydantic v2 の int（lax）の読み方と同じ: 前後の空白は無視、符号は +/-、数字は 0-9 だけ（全角は不可）、
// 桁の間の _ は可（1_000）、小数点以下がすべて 0 なら可（1.0）、指数・16 進は不可。
func parsePyInt(raw string) (*big.Int, bool) {
	text := strings.TrimFunc(raw, unicode.IsSpace)
	if text == "" {
		return nil, false
	}
	negative := false
	if text[0] == '+' || text[0] == '-' {
		negative = text[0] == '-'
		text = text[1:]
	}
	intPart, frac, hasFrac := strings.Cut(text, ".")
	if !digitsWithUnderscores(intPart) {
		return nil, false
	}
	if hasFrac && (frac == "" || strings.Trim(frac, "0") != "") {
		return nil, false
	}
	n, ok := new(big.Int).SetString(strings.ReplaceAll(intPart, "_", ""), 10)
	if !ok {
		return nil, false
	}
	if negative {
		n.Neg(n)
	}
	return n, true
}

func digitsWithUnderscores(s string) bool {
	if s == "" {
		return false
	}
	previousUnderscore := true // 先頭の _ を拒否する
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			previousUnderscore = false
		case r == '_' && !previousUnderscore:
			previousUnderscore = true
		default:
			return false
		}
	}
	return !previousUnderscore
}

// intParam は整数を読む。範囲（ge・le。nil なら無制限）を外れたとき・整数でないときは、誤りを足して nil を返す。
func (v *validation) intParam(loc []any, raw string, ge, le *int64) *big.Int {
	n, ok := parsePyInt(raw)
	if !ok {
		v.issues = append(v.issues, issue{Type: "int_parsing", Loc: loc, Msg: "Input should be a valid integer, unable to parse string as an integer", Input: raw})
		return nil
	}
	if ge != nil && n.Cmp(big.NewInt(*ge)) < 0 {
		v.issues = append(v.issues, issue{Type: "greater_than_equal", Loc: loc, Msg: fmt.Sprintf("Input should be greater than or equal to %d", *ge), Input: raw, Ctx: map[string]any{"ge": *ge}})
		return nil
	}
	if le != nil && n.Cmp(big.NewInt(*le)) > 0 {
		v.issues = append(v.issues, issue{Type: "less_than_equal", Loc: loc, Msg: fmt.Sprintf("Input should be less than or equal to %d", *le), Input: raw, Ctx: map[string]any{"le": *le}})
		return nil
	}
	return n
}

func i64(n int64) *int64 { return &n }

// ---- CORS（Starlette の CORSMiddleware と同じ: 許可したオリジンにだけ付ける。* も Allow-Credentials も使わない）----

func (s *server) corsAllowed(origin string) bool {
	for _, o := range corsOrigins() {
		if o == origin {
			return true
		}
	}
	return false
}

// 書き込みの API は画面のサーバー側から呼ぶので、CORS は GET だけ（main.py の allow_methods=["GET"]）
var corsMethods = "GET"

func (s *server) applyCORS(w http.ResponseWriter, r *http.Request) (preflightHandled bool) {
	w.Header().Add("Vary", "Origin") // Starlette は、Origin の有無によらず付ける
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	allowed := s.corsAllowed(origin)
	preflight := r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != ""
	if allowed {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	if !preflight {
		return false
	}
	// Starlette の preflight_response と同じ: 許可しない origin・method は 400（理由を並べた本文）。ヘッダーは、許可の有無によらず付ける
	h := w.Header()
	h.Set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network")
	h.Set("Access-Control-Allow-Methods", corsMethods)
	h.Set("Access-Control-Max-Age", corsMaxAge)
	if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
		h.Set("Access-Control-Allow-Headers", requested)
	}
	var failures []string
	if !allowed {
		failures = append(failures, "origin")
	}
	if !strings.Contains(", "+corsMethods+",", ", "+r.Header.Get("Access-Control-Request-Method")+",") {
		failures = append(failures, "method")
	}
	h.Set("Content-Type", "text/plain; charset=utf-8")
	if len(failures) > 0 {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("Disallowed CORS " + strings.Join(failures, ", ")))
		return true
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
	return true
}

// ---- 経路 ----

type handlerFunc func(w http.ResponseWriter, r *http.Request)

type server struct {
	logf func(string, ...any)
	mux  *http.ServeMux
}

// extraRoutes は、検証用の経路を足す口（通常のビルドでは nil。時計の固定など、差分テストの道具が使う）。
var extraRoutes func(s *server)

func newServer(logf func(string, ...any)) *server {
	s := &server{logf: logf, mux: http.NewServeMux()}
	s.route("/health", on("GET", s.health))
	s.routes()
	if extraRoutes != nil {
		extraRoutes(s)
	}
	return s
}

// methodHandler は、パスの上のメソッドごとの処理。
type methodHandler struct {
	method string
	h      handlerFunc
}

func on(method string, h handlerFunc) methodHandler { return methodHandler{method, h} }

// route は、パスにメソッドごとの処理を結ぶ。結んでいないメソッドは 405（FastAPI と同じ。HEAD も 405）。
// Allow は、最初に結んだメソッドだけ（Starlette は、同じパスの最初の経路の methods を返す）。
func (s *server) route(path string, handlers ...methodHandler) {
	s.mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		for _, mh := range handlers {
			if mh.method == r.Method {
				s.guard(w, mh.h, r)
				return
			}
		}
		e := newHTTPError(http.StatusMethodNotAllowed, "Method Not Allowed")
		e.header = map[string]string{"Allow": handlers[0].method}
		writeError(w, e)
	})
}

// guard は処理を流し、panic を応答にする。想定外の失敗は 500（固定の文。ログには種類だけ）。
func (s *server) guard(w http.ResponseWriter, h handlerFunc, r *http.Request) {
	defer func() {
		rec := recover()
		if rec == nil {
			return
		}
		switch e := rec.(type) {
		case *apiError:
			writeAPIError(w, e)
		case *httpError:
			writeError(w, e)
		default:
			s.logf("予期しないエラー（%s）", panicKind(rec))
			writeInternalError(w)
		}
	}()
	h(w, r)
}

// panicKind はログに出す種類だけ（本文は、接続情報・SQL を含みうるので出さない）。
func panicKind(rec any) string {
	switch rec.(type) {
	case dbError:
		return "dbError"
	case settingsError:
		return "settingsError"
	}
	return fmt.Sprintf("%T", rec)
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.applyCORS(w, r) {
		return
	}
	if _, pattern := s.mux.Handler(r); pattern == "" {
		// 末尾の / だけが違うときは 307（Starlette の redirect_slashes）
		if p := r.URL.Path; len(p) > 1 && strings.HasSuffix(p, "/") {
			probe := r.Clone(r.Context())
			probe.URL.Path = strings.TrimRight(p, "/")
			if _, trimmed := s.mux.Handler(probe); trimmed != "" {
				target := *r.URL
				target.Path = probe.URL.Path
				target.RawPath = ""
				scheme := "http"
				if r.TLS != nil {
					scheme = "https"
				}
				target.Scheme, target.Host = scheme, r.Host
				w.Header().Set("Location", target.String())
				w.WriteHeader(http.StatusTemporaryRedirect)
				return
			}
		}
		writeError(w, newHTTPError(http.StatusNotFound, "Not Found"))
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"}, nil)
}

const corsMaxAge = "600" // Starlette の CORSMiddleware の既定（max_age=600）
