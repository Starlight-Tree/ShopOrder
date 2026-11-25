package main

// 設定は環境変数だけで受け取る（backend/app/settings.py の移植）。足りなければ起動を失敗させ、別の値へ黙って切り替えない。
// Python と同じく、環境変数は呼ぶたびに読む（テストが t.Setenv で変える）。設定ミスは panic(settingsError) で、起動の検査（checkStartup）が
// 受けて止める。リクエストの途中で出たものは 500（本文は固定の文）。

import (
	"fmt"
	"math/big"
	"os"
	"strings"
	"unicode"
)

type settingsError struct{ msg string }

func (e settingsError) Error() string { return e.msg }

func settingsFail(format string, args ...any) {
	panic(settingsError{fmt.Sprintf(format, args...)})
}

// envGet は os.environ.get(name, def)（設定済みの空文字は、そのまま空文字）。
func envGet(name, def string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return def
}

// pySpace は Python の str.strip() が除く文字。
func pySpace(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) }

func pyStrip(s string) string { return strings.TrimFunc(s, pySpace) }

// pyIntFromString は Python の int(str)（空白は除く・符号・桁の間の _ は可・小数点は不可）。
func pyIntFromString(raw string) (*big.Int, bool) {
	text := pyStrip(raw)
	if text == "" {
		return nil, false
	}
	neg := false
	if text[0] == '+' || text[0] == '-' {
		neg = text[0] == '-'
		text = text[1:]
	}
	if !digitsWithUnderscores(text) {
		return nil, false
	}
	n, ok := new(big.Int).SetString(strings.ReplaceAll(text, "_", ""), 10)
	if !ok {
		return nil, false
	}
	if neg {
		n.Neg(n)
	}
	return n, true
}

func databaseURL() string {
	url := envGet("DATABASE_URL", "")
	if url == "" {
		settingsFail("DATABASE_URL が未設定です")
	}
	return url
}

func corsOrigins() []string {
	raw := envGet("CORS_ORIGINS", "http://localhost:3400")
	var out []string
	for _, o := range strings.Split(raw, ",") {
		if o = pyStrip(o); o != "" {
			out = append(out, o)
		}
	}
	return out
}

// appEnv は APP_ENV を strip().lower() で正規化して返す。未設定は空文字。
func appEnv() string { return strings.ToLower(pyStrip(envGet("APP_ENV", ""))) }

// isDevEnvironment は、開発専用の設定を許す環境か。development / test と明示されたときだけ true（許可リスト）。
func isDevEnvironment() bool {
	e := appEnv()
	return e == "development" || e == "test"
}

func authMode() string {
	v := envGet("AUTH_MODE", "dev")
	if v != "dev" {
		settingsFail("AUTH_MODE は dev のどれかにしてください（本物のログインは P6）")
	}
	return v
}

// orderHoursCheck は、営業時間・定休日・ラストオーダー・販売時間帯を見るか。既定は on。
func orderHoursCheck() bool {
	v := envGet("ORDER_HOURS_CHECK", "on")
	if v != "on" && v != "off" {
		settingsFail("ORDER_HOURS_CHECK は on / off のどちらかにしてください")
	}
	return v == "on"
}

func localUTCOffsetHours() int {
	raw := envGet("LOCAL_UTC_OFFSET_HOURS", "9")
	n, ok := pyIntFromString(raw)
	if !ok {
		settingsFail("LOCAL_UTC_OFFSET_HOURS は整数にしてください")
	}
	if !n.IsInt64() || n.Int64() < -12 || n.Int64() > 14 {
		settingsFail("LOCAL_UTC_OFFSET_HOURS は -12〜14 の整数にしてください")
	}
	return int(n.Int64())
}

func dbPoolMax() int {
	n, ok := pyIntFromString(envGet("DB_POOL_MAX", "10"))
	if !ok {
		settingsFail("DB_POOL_MAX は整数にしてください")
	}
	if !n.IsInt64() || n.Int64() < 2 {
		return 2
	}
	if n.Int64() > 100 {
		return 100
	}
	return int(n.Int64())
}

// ---- 差し替え口（決済・配達・通知・チャットの LLM）。既定はすべて模擬 ----

var providers = map[string][]string{
	"PAYMENT_PROVIDER":  {"mock"},
	"DELIVERY_PROVIDER": {"mock", "inhouse"},
	"NOTIFIER":          {"inapp"},
	"CHAT_MODEL":        {"mock", "gemini"},
}

// provider は差し替え口の選択。許す値の一覧にない値は失敗（別の実装へ黙って落とさない）。未設定は一覧の先頭（模擬）。
func provider(name string) string {
	allowed := providers[name]
	v := envGet(name, allowed[0])
	for _, a := range allowed {
		if a == v {
			return v
		}
	}
	settingsFail("%s は %s のどれかにしてください", name, strings.Join(allowed, " / "))
	return ""
}

// requireDemoDataAllowed は、ダミーデータの投入が DEMO_DATA=allow の環境だけであることの検査。拒否の文を返す（許すなら空）。
func requireDemoDataAllowed() string {
	if os.Getenv("DEMO_DATA") != "allow" {
		return "ダミーデータの投入は、DEMO_DATA=allow を渡した開発・テストの環境だけです。実行しませんでした。"
	}
	if strings.ToLower(pyStrip(envGet("APP_ENV", ""))) == "production" {
		return "APP_ENV=production では、ダミーデータの投入（特に --reset）を実行しません。"
	}
	return ""
}

// ---- 宅配 ----

const devPinSecret = "dev-only-delivery-pin-secret" // 秘密ではない（開発の便宜。本番では使わせない）

func deliveryPinSecret() string {
	if v := envGet("DELIVERY_PIN_SECRET", ""); v != "" {
		return v
	}
	if appEnv() == "production" {
		settingsFail("APP_ENV=production では DELIVERY_PIN_SECRET が必要です")
	}
	return devPinSecret
}

func deliveryMockAutopilot() bool {
	v := envGet("DELIVERY_MOCK_AUTOPILOT", "off")
	if v != "on" && v != "off" {
		settingsFail("DELIVERY_MOCK_AUTOPILOT は on / off のどちらかにしてください")
	}
	return v == "on"
}

func deliveryMockStepSeconds() int {
	n, ok := pyIntFromString(envGet("DELIVERY_MOCK_STEP_SECONDS", "30"))
	if !ok {
		settingsFail("DELIVERY_MOCK_STEP_SECONDS は整数にしてください")
	}
	if !n.IsInt64() || n.Int64() < 0 || n.Int64() > 3600 {
		settingsFail("DELIVERY_MOCK_STEP_SECONDS は 0〜3600 の整数にしてください")
	}
	return int(n.Int64())
}

func assignmentPolicy() string { return envGet("ASSIGNMENT_POLICY", "nearest") }

// ---- 分析 ----

const (
	devPseudonymKey          = "dev-only-analytics-pseudonym-key-not-secret"
	pseudonymKeyMinLength    = 16
	analyticsKeyMissingError = "ANALYTICS_PSEUDONYM_KEY が未設定です（開発用の固定値は、seed のときだけ使えます。本番相当では必須）"
)

// analyticsPseudonymKey は顧客の仮名 ID（HMAC）の鍵。無いとき: allowDevDefault（seed のときだけ true）かつ APP_ENV が production でなければ、開発用の固定値。
func analyticsPseudonymKey(allowDevDefault bool) []byte {
	if v := envGet("ANALYTICS_PSEUDONYM_KEY", ""); v != "" {
		if len([]rune(v)) < pseudonymKeyMinLength {
			settingsFail("ANALYTICS_PSEUDONYM_KEY は %d 文字以上にしてください", pseudonymKeyMinLength)
		}
		return []byte(v)
	}
	if allowDevDefault && appEnv() != "production" {
		return []byte(devPseudonymKey)
	}
	settingsFail("%s", analyticsKeyMissingError)
	return nil
}

// chatRetentionDays は会話ログの保存期間（日）。1〜365 の整数。呼ぶたびに環境変数を読む。
func chatRetentionDays() int {
	n, ok := pyIntFromString(envGet("CHAT_RETENTION_DAYS", "30"))
	if !ok {
		settingsFail("CHAT_RETENTION_DAYS は整数にしてください")
	}
	if !n.IsInt64() || n.Int64() < 1 || n.Int64() > 365 {
		settingsFail("CHAT_RETENTION_DAYS は 1〜365 の整数にしてください")
	}
	return int(n.Int64())
}
