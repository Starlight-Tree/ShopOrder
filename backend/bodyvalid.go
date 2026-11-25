package main

// 本文（JSON）の検査。pydantic v2（lax モード）と同じ種類・文の 422 を作る小さな道具（backend/app/schemas.py の入力モデルの移植）。
// 応答に出すのは loc / msg / type だけ（入力の値は返さない）。誤りは、宣言の順にまとめて返す。

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

type bodyReader struct {
	obj    map[string]any
	raw    string
	lone   bool // 本文に、対になっていないサロゲートのエスケープ（\ud800 など）がある（Go の復号は U+FFFD にする）
	issues []issue
	names  []string // 宣言したフィールド（extra_forbidden の判定）
}

// readBody は本文を読み、JSON の構文の誤りは 422 で止める（FastAPI は、依存（認証）より先に本文を読む）。
func readBody(r *http.Request) jsonBody {
	b, e := readJSONBody(r)
	if e != nil {
		panic(e)
	}
	return b
}

// object は本文をオブジェクトとして取り出す。空・オブジェクトでない本文は誤りを足して nil（呼び出し側は、認証のあとに呼ぶ）。
func (v *validation) object(b jsonBody) *bodyReader {
	obj, e := bodyObject(b)
	if e != nil {
		v.issues = append(v.issues, e.issues...)
		return nil
	}
	return &bodyReader{obj: obj, raw: b.raw, lone: hasLoneSurrogate(b.raw)}
}

// optionalObject は、本文が無くてもよい経路用（`body: PayBody | None = None`）。本文が空なら nil（既定値を使う）。
func (v *validation) optionalObject(b jsonBody) *bodyReader {
	if b.empty {
		return nil
	}
	return v.object(b)
}

// finish は本文の誤り（と extra_forbidden）を足して、誤りが 1 件でもあれば 422 で止める。br は nil でもよい。
func (v *validation) finish(br *bodyReader) {
	if br != nil {
		if e := br.done(); e != nil {
			v.issues = append(v.issues, e.issues...)
		}
	}
	if e := v.err(); e != nil {
		panic(e)
	}
}

func (br *bodyReader) add(typ string, field string, msg string, input any) {
	br.issues = append(br.issues, issue{Type: typ, Loc: []any{"body", field}, Msg: msg, Input: input})
}

func (br *bodyReader) declare(name string) { br.names = append(br.names, name) }

// done は extra_forbidden を足して、誤りがあれば 422 を返す。
func (br *bodyReader) done() *httpError {
	declared := map[string]bool{}
	for _, n := range br.names {
		declared[n] = true
	}
	var extra []string
	for k := range br.obj {
		if !declared[k] {
			extra = append(extra, k)
		}
	}
	sortStrings(extra)
	for _, k := range extra {
		br.issues = append(br.issues, issue{Type: "extra_forbidden", Loc: []any{"body", k}, Msg: "Extra inputs are not permitted", Input: br.obj[k]})
	}
	if len(br.issues) == 0 {
		return nil
	}
	return validationFail(br.issues...)
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// ---- 整数 ----

type intOpts struct {
	required bool
	nullable bool
	def      *int64 // 既定値（required でないとき）
	ge, le   *int64
}

// intField は整数のフィールド。present=false は「無い（既定値）」、isNull=true は null。
func (br *bodyReader) intField(name string, o intOpts) (val int64, isNull bool) {
	br.declare(name)
	raw, present := br.obj[name]
	if !present {
		if o.required {
			br.add("missing", name, "Field required", br.obj)
			return 0, false
		}
		if o.def == nil {
			return 0, true
		}
		return *o.def, false
	}
	if raw == nil {
		if o.nullable {
			return 0, true
		}
		br.add("int_type", name, "Input should be a valid integer", nil)
		return 0, false
	}
	n, ok := br.pyIntValue(name, raw)
	if !ok {
		return 0, false
	}
	if o.ge != nil && n.Cmp(big.NewInt(*o.ge)) < 0 {
		br.add("greater_than_equal", name, fmt.Sprintf("Input should be greater than or equal to %d", *o.ge), raw)
		return 0, false
	}
	if o.le != nil && n.Cmp(big.NewInt(*o.le)) > 0 {
		br.add("less_than_equal", name, fmt.Sprintf("Input should be less than or equal to %d", *o.le), raw)
		return 0, false
	}
	if !n.IsInt64() {
		br.add("int_parsing", name, "Input should be a valid integer, unable to parse string as an integer", raw)
		return 0, false
	}
	return n.Int64(), false
}

// pyIntValue は pydantic v2 の int（lax）の読み方: 整数・小数部が 0 の数・数字の文字列・真偽値。
func (br *bodyReader) pyIntValue(name string, raw any) (*big.Int, bool) {
	switch x := raw.(type) {
	case json.Number:
		s := x.String()
		if n, ok := new(big.Int).SetString(s, 10); ok {
			return n, true
		}
		f, _, err := big.ParseFloat(s, 10, 200, big.ToNearestEven)
		if err != nil || !f.IsInt() {
			br.add("int_from_float", name, "Input should be a valid integer, got a number with a fractional part", raw)
			return nil, false
		}
		n, _ := f.Int(nil)
		return n, true
	case string:
		if n, ok := parsePyInt(x); ok {
			return n, true
		}
		br.add("int_parsing", name, "Input should be a valid integer, unable to parse string as an integer", raw)
		return nil, false
	case bool:
		if x {
			return big.NewInt(1), true
		}
		return big.NewInt(0), true
	}
	br.add("int_type", name, "Input should be a valid integer", raw)
	return nil, false
}

// ---- 文字列 ----

type strOpts struct {
	required bool
	nullable bool
	def      *string
	min, max int // 0 は無制限（min は 1 以上のとき有効）
	strip    bool
	safe     bool // 制御文字・単独のサロゲートを拒否（SafeText）
	pattern  *regexp.Regexp
}

func plural(n int) string {
	if n == 1 {
		return "character"
	}
	return "characters"
}

// strField は文字列のフィールド。isNull は null（既定）。
func (br *bodyReader) strField(name string, o strOpts) (val string, isNull bool) {
	br.declare(name)
	raw, present := br.obj[name]
	if !present {
		if o.required {
			br.add("missing", name, "Field required", br.obj)
			return "", false
		}
		if o.def == nil {
			return "", true
		}
		return *o.def, false
	}
	if raw == nil {
		if o.nullable {
			return "", true
		}
		br.add("string_type", name, "Input should be a valid string", nil)
		return "", false
	}
	s, ok := raw.(string)
	if !ok {
		br.add("string_type", name, "Input should be a valid string", raw)
		return "", false
	}
	if br.lone && strings.ContainsRune(s, utf8.RuneError) { // 単独のサロゲートは、文字列の型の検査で拒否される（pydantic-core）
		br.add("string_unicode", name, "Input should be a valid string, unable to parse raw data as a unicode string", raw)
		return "", false
	}
	if o.strip {
		s = pyStrip(s)
	}
	n := utf8.RuneCountInString(s)
	if o.min > 0 && n < o.min {
		br.add("string_too_short", name, fmt.Sprintf("String should have at least %d %s", o.min, plural(o.min)), raw)
		return "", false
	}
	if o.max > 0 && n > o.max {
		br.add("string_too_long", name, fmt.Sprintf("String should have at most %d %s", o.max, plural(o.max)), raw)
		return "", false
	}
	if o.pattern != nil && !o.pattern.MatchString(s) {
		br.add("string_pattern_mismatch", name, fmt.Sprintf("String should match pattern '%s'", o.pattern.String()), raw)
		return "", false
	}
	if o.safe && !noControlChars(s, br.lone) {
		br.add("value_error", name, "Value error, 使えない文字が含まれています", raw)
		return "", false
	}
	return s, false
}

// noControlChars は NUL・制御文字（改行・タブを除く）・DEL を含まないこと（単独のサロゲートは、読み取りの段階で U+FFFD になるので readJSONBody が先に拒否する）。
func noControlChars(s string, lone bool) bool {
	for _, r := range s {
		if (r < 32 && r != '\n' && r != '\t') || r == 127 || (lone && r == utf8.RuneError) {
			return false
		}
	}
	return true
}

// ---- 列挙（Literal）・真偽値・UUID ----

func literalMsg(allowed []string) string {
	q := make([]string, len(allowed))
	for i, a := range allowed {
		q[i] = "'" + a + "'"
	}
	if len(q) == 1 {
		return "Input should be " + q[0]
	}
	return "Input should be " + strings.Join(q[:len(q)-1], ", ") + " or " + q[len(q)-1]
}

func (br *bodyReader) literalField(name string, allowed []string, required bool, def string) string {
	br.declare(name)
	raw, present := br.obj[name]
	if !present {
		if required {
			br.add("missing", name, "Field required", br.obj)
			return ""
		}
		return def
	}
	s, ok := raw.(string)
	if ok {
		for _, a := range allowed {
			if a == s {
				return s
			}
		}
	}
	br.add("literal_error", name, literalMsg(allowed), raw)
	return ""
}

var boolTrue = map[string]bool{"1": true, "on": true, "t": true, "true": true, "y": true, "yes": true}
var boolFalse = map[string]bool{"0": true, "off": true, "f": true, "false": true, "n": true, "no": true}

func (br *bodyReader) boolField(name string, required bool, def bool) bool {
	br.declare(name)
	raw, present := br.obj[name]
	if !present {
		if required {
			br.add("missing", name, "Field required", br.obj)
			return false
		}
		return def
	}
	switch x := raw.(type) {
	case bool:
		return x
	case string:
		l := strings.ToLower(x)
		if boolTrue[l] {
			return true
		}
		if boolFalse[l] {
			return false
		}
		br.add("bool_parsing", name, "Input should be a valid boolean, unable to interpret input", raw)
		return false
	case json.Number:
		switch x.String() {
		case "1":
			return true
		case "0":
			return false
		}
		br.add("bool_parsing", name, "Input should be a valid boolean, unable to interpret input", raw)
		return false
	}
	br.add("bool_type", name, "Input should be a valid boolean", raw)
	return false
}

// uuidField は UUID のフィールド（正規化した文字列を返す）。
func (br *bodyReader) uuidField(name string) string {
	br.declare(name)
	raw, present := br.obj[name]
	if !present {
		br.add("missing", name, "Field required", br.obj)
		return ""
	}
	s, ok := raw.(string)
	if !ok {
		br.add("uuid_type", name, "UUID input should be a string, bytes or UUID object", raw)
		return ""
	}
	id, msg := parseUUIDStrict(s)
	if msg != "" {
		br.add("uuid_parsing", name, "Input should be a valid UUID, "+msg, raw)
		return ""
	}
	return id
}

// ---- クエリ・ヘッダーの検査 ----

func (v *validation) addQuery(typ, name, msg string, input any) {
	v.issues = append(v.issues, issue{Type: typ, Loc: []any{"query", name}, Msg: msg, Input: input})
}

// queryInt は ?name=整数（無ければ nil）。範囲外・整数でないときは誤りを足して nil。
func (v *validation) queryInt(r *http.Request, name string, ge, le *int64) *int64 {
	vals, ok := r.URL.Query()[name]
	if !ok {
		return nil
	}
	n := v.intParam([]any{"query", name}, vals[0], ge, le)
	if n == nil {
		return nil
	}
	x := n.Int64()
	return &x
}

// pathInt は {name} を整数（ge 以上）として読む。
func (v *validation) pathInt(r *http.Request, name string, ge int64) (int64, bool) {
	n := v.intParam([]any{"path", name}, r.PathValue(name), &ge, nil)
	if n == nil {
		return 0, false
	}
	return n.Int64(), true
}

// pathString は {name} を文字列（長さ 1〜max）として読む。
func (v *validation) pathString(r *http.Request, name string, max int) (string, bool) {
	s := r.PathValue(name)
	n := utf8.RuneCountInString(s)
	loc := []any{"path", name}
	if n < 1 {
		v.issues = append(v.issues, issue{Type: "string_too_short", Loc: loc, Msg: "String should have at least 1 character", Input: s})
		return "", false
	}
	if n > max {
		v.issues = append(v.issues, issue{Type: "string_too_long", Loc: loc, Msg: fmt.Sprintf("String should have at most %d %s", max, plural(max)), Input: s})
		return "", false
	}
	return s, true
}

// queryStringMax は ?name=文字列（最大 max 文字。無ければ nil）。
func (v *validation) queryStringMax(r *http.Request, name string, max int) *string {
	vals, ok := r.URL.Query()[name]
	if !ok {
		return nil
	}
	s := vals[0]
	if utf8.RuneCountInString(s) > max {
		v.addQuery("string_too_long", name, fmt.Sprintf("String should have at most %d %s", max, plural(max)), s)
		return nil
	}
	return &s
}

// hasLoneSurrogate は、JSON の文字列に、対になっていないサロゲートのエスケープ（\ud800 だけ・\udc00 だけ）があるか。
func hasLoneSurrogate(raw string) bool {
	isHigh := func(u int) bool { return u >= 0xD800 && u <= 0xDBFF }
	isLow := func(u int) bool { return u >= 0xDC00 && u <= 0xDFFF }
	hex4 := func(i int) (int, bool) {
		if i+6 > len(raw) || raw[i] != '\\' || raw[i+1] != 'u' {
			return 0, false
		}
		n := 0
		for _, c := range raw[i+2 : i+6] {
			switch {
			case c >= '0' && c <= '9':
				n = n*16 + int(c-'0')
			case c >= 'a' && c <= 'f':
				n = n*16 + int(c-'a') + 10
			case c >= 'A' && c <= 'F':
				n = n*16 + int(c-'A') + 10
			default:
				return 0, false
			}
		}
		return n, true
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		if i+1 < len(raw) && raw[i+1] != 'u' {
			i++ // \n・\\ など。次の文字を飛ばす
			continue
		}
		u, ok := hex4(i)
		if !ok {
			continue
		}
		switch {
		case isHigh(u):
			if u2, ok2 := hex4(i + 6); ok2 && isLow(u2) {
				i += 11
				continue
			}
			return true
		case isLow(u):
			return true
		}
		i += 5
	}
	return false
}
