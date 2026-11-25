package main

// UUID の読み取り。2 種類ある（Python と同じ）:
//   - パスの {image_id}（pydantic の UUID 型）: 32 桁の 16 進、ハイフンつき（8-4-4-4-12）、{} で囲んだもの、urn:uuid: つき。誤りの文は pydantic-core と同じ形
//   - 本文の文字列（Python の uuid.UUID(str)）: urn: uuid: を除き、{} を外し、ハイフンを除いた 32 桁の 16 進。誤りは 1 つの固定の説明（呼び出し側）

import (
	"crypto/rand"
	"fmt"
	"strings"
)

func isHexByte(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func canonicalUUID(hex32 string) string {
	h := strings.ToLower(hex32)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// parseUUIDStrict は pydantic の UUID 型の読み方。誤りのときは、pydantic-core の文（"invalid character: found `x` at 0" など）を返す。
func parseUUIDStrict(in string) (string, string) {
	if len(in) > 45 {
		return "", fmt.Sprintf("invalid length: found %d", len(in))
	}
	s, offset, wrapped := in, 0, false
	switch {
	case strings.HasPrefix(in, "urn:uuid:"):
		s, offset, wrapped = in[9:], 9, true
	case len(in) >= 2 && in[0] == '{' && in[len(in)-1] == '}':
		s, offset, wrapped = in[1:len(in)-1], 1, true
	}
	for i := 0; i < len(s); {
		c := s[i]
		if c == '-' || isHexByte(c) {
			i++
			continue
		}
		r := []rune(s[i:])[0]
		return "", fmt.Sprintf("invalid character: found `%c` at %d", r, offset+i)
	}
	if !strings.Contains(s, "-") {
		if wrapped {
			return "", "invalid group count: expected 5, found 1"
		}
		if len(s) != 32 {
			return "", fmt.Sprintf("invalid length: found %d", len(s))
		}
		return canonicalUUID(s), ""
	}
	groups := strings.Split(s, "-")
	if len(groups) != 5 {
		return "", fmt.Sprintf("invalid group count: expected 5, found %d", len(groups))
	}
	for i, want := range []int{8, 4, 4, 4, 12} {
		if len(groups[i]) != want {
			return "", fmt.Sprintf("invalid group length in group %d: expected %d, found %d", i, want, len(groups[i]))
		}
	}
	return canonicalUUID(strings.Join(groups, "")), ""
}

// parseUUIDLoose は Python の uuid.UUID(str) と同じ読み方（本文の文字列用）。読めなければ ok=false。
func parseUUIDLoose(in string) (string, bool) {
	h := strings.ReplaceAll(in, "urn:", "")
	h = strings.ReplaceAll(h, "uuid:", "")
	h = strings.Trim(h, "{}")
	h = strings.ReplaceAll(h, "-", "")
	if len(h) != 32 {
		return "", false
	}
	for i := 0; i < len(h); i++ {
		if !isHexByte(h[i]) {
			return "", false
		}
	}
	return canonicalUUID(h), true
}

// pathUUID は {name} を UUID として読む。読めなければ 422（uuid_parsing）。
func (v *validation) pathUUID(name, raw string) (string, bool) {
	id, msg := parseUUIDStrict(raw)
	if msg != "" {
		v.issues = append(v.issues, issue{Type: "uuid_parsing", Loc: []any{"path", name}, Msg: "Input should be a valid UUID, " + msg, Input: raw, Ctx: map[string]any{"error": msg}})
		return "", false
	}
	return id, true
}

// newUUIDv4 は乱数の UUID（version 4）。
func newUUIDv4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("乱数を読めません")
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return uuidString(b)
}
