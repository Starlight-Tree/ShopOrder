package main

// 認証（backend/app/auth.py の移植）。顧客とスタッフは、アカウント・セッションが別（docs/api.md「認証」）。権限は API が毎回確認し、
// 利用者・店・ロールはセッションから取る。
//   - 顧客: 開発の既定（AUTH_MODE=dev）はヘッダー X-Dev-User（[a-z0-9-]{1,40}。無ければ demo-customer）
//   - スタッフ: POST /api/staff/login が返す不透明トークンを Authorization: Bearer で送る。保存するのは SHA-256 のハッシュだけ（有効 12 時間）。
//     パスワードは argon2。失敗が続いたら 429（email ごと・15 分で 5 回まで）。理由（email が無い・パスワードが違う）は分けない

import (
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

var devUserRe = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

const defaultDevUser = "demo-customer"

var (
	dummyHashOnce sync.Once
	dummyHash     string
)

// 存在しない email のときも argon2 の検証を 1 回行い、応答の時間で email の有無が分からないようにする
func timingDummyHash() string {
	dummyHashOnce.Do(func() { dummyHash = hashPassword("dummy-password-for-timing") })
	return dummyHash
}

// checkStartupAuth は起動時の検査。開発専用の設定は、APP_ENV が development / test と明示された環境だけで許す。
func checkStartupAuth() {
	authMode() // 許さない値は、ここで失敗
	orderHoursCheck()
	localUTCOffsetHours()
	if !isDevEnvironment() {
		if authMode() == "dev" {
			settingsFail("AUTH_MODE=dev は、APP_ENV=development または test のときだけ使えます")
		}
		if !orderHoursCheck() {
			settingsFail("ORDER_HOURS_CHECK=off は、APP_ENV=development または test のときだけ使えます")
		}
		if provider("PAYMENT_PROVIDER") == "mock" {
			settingsFail("PAYMENT_PROVIDER=mock（模擬決済）は、APP_ENV=development または test のときだけ使えます")
		}
	}
}

func tokenHash(token string) string { return sha256Hex([]byte(token)) }

func emailHash(email string) string {
	return sha256Hex([]byte(strings.ToLower(pyStrip(email))))
}

// ---- 顧客 ----

type customer struct {
	id   int
	name string
}

// currentCustomer は X-Dev-User から利用者を決める（無ければ作る）。決められなければ 401。
func currentCustomer(r *http.Request) customer {
	if authMode() != "dev" {
		fail(401, "unauthorized")
	}
	name := defaultDevUser
	if v := r.Header.Values("X-Dev-User"); len(v) > 0 {
		name = v[0]
	}
	if !devUserRe.MatchString(name) {
		fail(401, "unauthorized")
	}
	authUserID := "dev:" + name
	var c customer
	withTx(func(t *tx) {
		rw := t.one("SELECT id, display_name FROM users WHERE auth_user_id = $1", authUserID)
		if rw == nil {
			rw = t.one("INSERT INTO users (auth_user_id, display_name) VALUES ($1, $2) "+
				"ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id RETURNING id, display_name", authUserID, name)
		}
		c = customer{id: rw.i("id"), name: rw.s("display_name")}
	})
	return c
}

// ---- スタッフ ----

type staffUser struct {
	id      int
	name    string
	role    string // staff / courier / manager
	storeID *int   // manager は nil なら全店
}

func (s staffUser) public() staffOut {
	return staffOut{ID: s.id, Name: s.name, Role: s.role, StoreID: s.storeID}
}

func bearer(authorization string, present bool) *string {
	if !present || authorization == "" {
		return nil
	}
	scheme, token, _ := strings.Cut(authorization, " ")
	if strings.ToLower(scheme) != "bearer" || pyStrip(token) == "" {
		return nil
	}
	t := pyStrip(token)
	return &t
}

func authorizationHeader(r *http.Request) (string, bool) {
	v := r.Header.Values("Authorization")
	if len(v) == 0 {
		return "", false
	}
	return v[0], true
}

func currentStaff(r *http.Request) staffUser {
	a, ok := authorizationHeader(r)
	token := bearer(a, ok)
	if token == nil {
		fail(401, "unauthorized")
	}
	var rw row
	withTx(func(t *tx) {
		rw = t.one("SELECT a.id, a.name, a.role, a.store_id FROM staff_sessions s JOIN staff_accounts a ON a.id = s.staff_id "+
			"WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.is_active", tokenHash(*token), utcNow())
	})
	if rw == nil {
		fail(401, "unauthorized")
	}
	return staffUser{id: rw.i("id"), name: rw.s("name"), role: rw.s("role"), storeID: rw.iN("store_id")}
}

// orderStaff は注文・在庫を扱えるロール（staff・manager）。配達員（courier）は別に扱う。
func orderStaff(r *http.Request) staffUser {
	s := currentStaff(r)
	if s.role != "staff" && s.role != "manager" {
		fail(403, "forbidden")
	}
	return s
}

func courierStaff(r *http.Request) staffUser {
	s := currentStaff(r)
	if s.role != "courier" {
		fail(403, "forbidden")
	}
	return s
}

func managerStaff(r *http.Request) staffUser {
	s := currentStaff(r)
	if s.role != "manager" {
		fail(403, "forbidden")
	}
	return s
}

type loginResult struct {
	token     string
	expiresAt time.Time
	staff     staffUser
}

// staffLogin は成功なら token・期限・スタッフ。失敗は apiError（401 / 429）。
// 試行は、パスワードを確かめる前に、email ごとに直列化して数える（pg_advisory_xact_lock）。argon2 の検証は DB の接続を持たずに行う。
func staffLogin(email, password string) loginResult {
	now := utcNow()
	eh := emailHash(email)
	locked := inTx(func(t *tx) bool {
		t.exec("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", eh)
		attempts := t.one("SELECT count(*) AS n FROM staff_login_attempts WHERE email_hash = $1 AND at > $2", eh, now.Add(-loginWindow)).i("n")
		if attempts >= loginMaxFailures {
			return true
		}
		t.exec("INSERT INTO staff_login_attempts (email_hash, at) VALUES ($1, $2)", eh, now)
		return false
	})
	if locked {
		fail(429, "too_many_attempts")
	}
	rw := inTx(func(t *tx) row {
		return t.one("SELECT id, name, role, store_id, password_hash, is_active FROM staff_accounts WHERE email = $1", strings.ToLower(pyStrip(email)))
	})
	hash := timingDummyHash()
	if rw != nil {
		hash = rw.s("password_hash")
	}
	ok := verifyPassword(hash, password) && rw != nil && rw.b("is_active")
	if !ok {
		fail(401, "invalid_credentials")
	}
	token := newToken()
	expiresAt := now.Add(staffSessionTTL)
	withTx(func(t *tx) {
		t.exec("DELETE FROM staff_login_attempts WHERE email_hash = $1", eh)
		t.exec("INSERT INTO staff_sessions (token_hash, staff_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", tokenHash(token), rw.i("id"), expiresAt, now)
	})
	return loginResult{token: token, expiresAt: expiresAt, staff: staffUser{id: rw.i("id"), name: rw.s("name"), role: rw.s("role"), storeID: rw.iN("store_id")}}
}

func staffLogout(token string) {
	withTx(func(t *tx) { t.exec("DELETE FROM staff_sessions WHERE token_hash = $1", tokenHash(token)) })
}
