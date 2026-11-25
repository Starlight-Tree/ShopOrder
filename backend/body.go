package main

// JSON の本文の読み取りと検査。FastAPI + pydantic v2 と同じ 422 を返す。
//   - 構文の誤り: {"type":"json_invalid","loc":["body",位置],"msg":"JSON decode error","input":{},"ctx":{"error":"…"}}。
//     位置と文は、Python の json（C の scanner）と同じになるよう、同じ規則で走査する（pyJSONError）
//   - 本文が空: {"type":"missing","loc":["body"],"msg":"Field required","input":null}
//   - 検査（フィールド）は、認証のあと（FastAPI は、構文 → 依存（認証）→ 検査の順）

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type jsonBody struct {
	empty bool // 本文が空
	value any  // 解析した値（json.Number を使う）
	raw   string
	nonJS bool // Content-Type が JSON でない（FastAPI は、本文を文字列のまま扱う）
}

// readJSONBody は、本文を読み、JSON として解析する。構文の誤りは 422（json_invalid）、UTF-8 でない本文は 400。
func readJSONBody(r *http.Request) (jsonBody, *httpError) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		return jsonBody{}, newHTTPError(http.StatusBadRequest, "There was an error parsing the body")
	}
	var b jsonBody
	b.raw = string(raw)
	if len(raw) == 0 {
		b.empty = true
		return b, nil
	}
	if ct := r.Header.Get("Content-Type"); ct == "" || !isJSONContentType(ct) { // FastAPI は、Content-Type が JSON でない本文を、構文を読まずにバイト列として扱う（strict_content_type）
		b.nonJS = true
		return b, nil
	}
	if !utf8.Valid(raw) {
		return b, newHTTPError(http.StatusBadRequest, "There was an error parsing the body")
	}
	if msg, pos, bad := pyJSONError([]rune(b.raw)); bad {
		return b, &httpError{status: http.StatusUnprocessableEntity, detail: "Unprocessable Entity", issues: []issue{{
			Type: "json_invalid", Loc: []any{"body", pos}, Msg: "JSON decode error", Input: map[string]any{}, Ctx: map[string]any{"error": msg},
		}}}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&b.value); err != nil {
		return b, validationFail(issue{Type: "finite_number", Loc: []any{"body"}, Msg: "Input should be a finite number"}) // NaN・Infinity は Python の json は読める（pydantic が拒否する）
	}
	return b, nil
}

func isJSONContentType(ct string) bool {
	mt := strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	return mt == "application/json" || (strings.HasPrefix(mt, "application/") && strings.HasSuffix(mt, "+json"))
}

// bodyObject は、本文を JSON のオブジェクトとして取り出す。空・オブジェクトでない本文は、pydantic と同じ 422（missing / model_attributes_type）。
func bodyObject(b jsonBody) (map[string]any, *httpError) {
	switch {
	case b.empty:
		return nil, validationFail(issue{Type: "missing", Loc: []any{"body"}, Msg: "Field required", Input: nil})
	case b.nonJS:
		return nil, validationFail(issue{Type: "model_attributes_type", Loc: []any{"body"}, Msg: "Input should be a valid dictionary or object to extract fields from", Input: b.raw})
	}
	obj, ok := b.value.(map[string]any)
	if !ok {
		return nil, validationFail(issue{Type: "model_attributes_type", Loc: []any{"body"}, Msg: "Input should be a valid dictionary or object to extract fields from", Input: b.value})
	}
	return obj, nil
}

// ---- Python の json（C の scanner）と同じ位置・文の構文エラー ----

type pyJSONScanner struct {
	s []rune
}

type pyJSONErr struct {
	msg string
	pos int
}

func (p *pyJSONScanner) ws(i int) int {
	for i < len(p.s) && (p.s[i] == ' ' || p.s[i] == '\t' || p.s[i] == '\n' || p.s[i] == '\r') {
		i++
	}
	return i
}

func (p *pyJSONScanner) at(i int) rune {
	if i < 0 || i >= len(p.s) {
		return -1
	}
	return p.s[i]
}

func (p *pyJSONScanner) hasPrefix(i int, lit string) bool {
	r := []rune(lit)
	if i+len(r) > len(p.s) {
		return false
	}
	for k, c := range r {
		if p.s[i+k] != c {
			return false
		}
	}
	return true
}

// value は idx の値を走査して、終わりの位置を返す。値が無いときは (_, false)（呼び出し側が "Expecting value" にする）。
func (p *pyJSONScanner) value(idx int) (int, bool, *pyJSONErr) {
	switch c := p.at(idx); {
	case c == -1:
		return idx, false, nil
	case c == '"':
		end, e := p.str(idx + 1)
		return end, e == nil, e
	case c == '{':
		end, e := p.object(idx + 1)
		return end, e == nil, e
	case c == '[':
		end, e := p.array(idx + 1)
		return end, e == nil, e
	case c == 'n' && p.hasPrefix(idx, "null"):
		return idx + 4, true, nil
	case c == 't' && p.hasPrefix(idx, "true"):
		return idx + 4, true, nil
	case c == 'f' && p.hasPrefix(idx, "false"):
		return idx + 5, true, nil
	}
	if end, ok := p.number(idx); ok {
		return end, true, nil
	}
	switch {
	case p.at(idx) == 'N' && p.hasPrefix(idx, "NaN"):
		return idx + 3, true, nil
	case p.at(idx) == 'I' && p.hasPrefix(idx, "Infinity"):
		return idx + 8, true, nil
	case p.at(idx) == '-' && p.hasPrefix(idx, "-Infinity"):
		return idx + 9, true, nil
	}
	return idx, false, nil
}

func isDigit(r rune) bool { return r >= '0' && r <= '9' }

// number は (-?(0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)? の長さ。
func (p *pyJSONScanner) number(i int) (int, bool) {
	start := i
	if p.at(i) == '-' {
		i++
	}
	switch c := p.at(i); {
	case c == '0':
		i++
	case c >= '1' && c <= '9':
		for isDigit(p.at(i)) {
			i++
		}
	default:
		return start, false
	}
	if p.at(i) == '.' && isDigit(p.at(i+1)) {
		i++
		for isDigit(p.at(i)) {
			i++
		}
	}
	if c := p.at(i); c == 'e' || c == 'E' {
		j := i + 1
		if c2 := p.at(j); c2 == '+' || c2 == '-' {
			j++
		}
		if isDigit(p.at(j)) {
			for isDigit(p.at(j)) {
				j++
			}
			i = j
		}
	}
	return i, true
}

func isHex(r rune) bool { return isDigit(r) || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') }

// str は、開き引用符の次（end）から文字列を走査して、閉じ引用符の次の位置を返す（C の scanstring_unicode と同じ位置・文）。
func (p *pyJSONScanner) str(end int) (int, *pyJSONErr) {
	begin := end - 1
	next := end
	for {
		for next < len(p.s) {
			c := p.s[next]
			if c == '"' || c == '\\' {
				break
			}
			if c <= 0x1f {
				return 0, &pyJSONErr{"Invalid control character at", next}
			}
			next++
		}
		if next >= len(p.s) {
			return 0, &pyJSONErr{"Unterminated string starting at", begin}
		}
		if p.s[next] == '"' {
			return next + 1, nil
		}
		next++ // バックスラッシュ
		if next >= len(p.s) {
			return 0, &pyJSONErr{"Unterminated string starting at", begin}
		}
		c := p.s[next]
		if c != 'u' {
			switch c {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
				next++
			default:
				return 0, &pyJSONErr{"Invalid \\escape", next - 1}
			}
			continue
		}
		next++
		end := next + 4
		if end >= len(p.s) {
			return 0, &pyJSONErr{"Invalid \\uXXXX escape", next - 1}
		}
		for k := 0; k < 4; k++ {
			if !isHex(p.s[next+k]) {
				return 0, &pyJSONErr{"Invalid \\uXXXX escape", next - 1}
			}
		}
		next = end
	}
}

func (p *pyJSONScanner) array(end int) (int, *pyJSONErr) {
	end = p.ws(end)
	if p.at(end) == ']' {
		return end + 1, nil
	}
	for {
		var ok bool
		var e *pyJSONErr
		end, ok, e = p.value(end)
		if e != nil {
			return 0, e
		}
		if !ok {
			return 0, &pyJSONErr{"Expecting value", end}
		}
		end = p.ws(end)
		next := p.at(end)
		end++
		if next == ']' {
			return end, nil
		}
		if next != ',' {
			return 0, &pyJSONErr{"Expecting ',' delimiter", end - 1}
		}
		comma := end - 1
		end = p.ws(end)
		if p.at(end) == ']' {
			return 0, &pyJSONErr{"Illegal trailing comma before end of array", comma}
		}
	}
}

func (p *pyJSONScanner) object(end int) (int, *pyJSONErr) {
	end = p.ws(end)
	if p.at(end) == '}' {
		return end + 1, nil
	}
	if p.at(end) != '"' {
		return 0, &pyJSONErr{"Expecting property name enclosed in double quotes", end}
	}
	end++
	for {
		var e *pyJSONErr
		end, e = p.str(end)
		if e != nil {
			return 0, e
		}
		end = p.ws(end)
		if p.at(end) != ':' {
			return 0, &pyJSONErr{"Expecting ':' delimiter", end}
		}
		end = p.ws(end + 1)
		var ok bool
		end, ok, e = p.value(end)
		if e != nil {
			return 0, e
		}
		if !ok {
			return 0, &pyJSONErr{"Expecting value", end}
		}
		end = p.ws(end)
		next := p.at(end)
		end++
		if next == '}' {
			return end, nil
		}
		if next != ',' {
			return 0, &pyJSONErr{"Expecting ',' delimiter", end - 1}
		}
		comma := end - 1
		end = p.ws(end)
		next = p.at(end)
		end++
		if next != '"' {
			if next == '}' {
				return 0, &pyJSONErr{"Illegal trailing comma before end of object", comma}
			}
			return 0, &pyJSONErr{"Expecting property name enclosed in double quotes", end - 1}
		}
	}
}

// pyJSONError は、本文が Python の json.loads で構文エラーになるとき、(文, 位置, true)。位置は文字（コードポイント）の番号。
func pyJSONError(s []rune) (string, int, bool) {
	p := &pyJSONScanner{s: s}
	idx := p.ws(0)
	end, ok, e := p.value(idx)
	if e != nil {
		return e.msg, e.pos, true
	}
	if !ok {
		return "Expecting value", end, true
	}
	if end = p.ws(end); end != len(s) {
		return "Extra data", end, true
	}
	return "", 0, false
}
