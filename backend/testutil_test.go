package main

// テストの共通の道具。DB のテストは TEST_DATABASE_URL（使い捨ての Postgres 17 の管理用 URL）が要る（無いとスキップ）。
// テンプレートの DB（shop_order_go_template: マイグレーション + 履歴つきの seed。時計は固定）を 1 回作り、テストごとに複製した DB（shop_order_go_t_*）を使う。
// 同じサーバーの別の DB を DROP するので、TEST_DATABASE_URL は必ずテスト用のサーバーに向ける（guards.go が、ホスト名と DB 名を検査する）。

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	templateDB      = "shop_order_go_template"
	goldenStaffPass = "golden-staff-pass"
	testDBPrefix    = "shop_order_go_t_"
)

// goldenNow は固定の時刻（2026-11-26 12:00 JST・木曜）。golden（testdata/golden_api.json）を取ったときと同じ。
var goldenNow = time.Date(2026, 11, 26, 3, 0, 0, 0, time.UTC)

var (
	templateOnce sync.Once
	templateErr  error
	dbCounter    atomic.Int64
)

func adminURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("TEST_DATABASE_URL")
	if u == "" {
		t.Skip("TEST_DATABASE_URL が未設定です")
	}
	return u
}

// setTestEnv は開発・テストの既定の環境（ORDER_HOURS_CHECK=off など。docker-compose.yml と同じ）。
func setTestEnv(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", "test")
	t.Setenv("ORDER_HOURS_CHECK", "off")
	t.Setenv("DEMO_DATA", "allow")
	t.Setenv("DEMO_STAFF_PASSWORD", goldenStaffPass)
	for _, k := range []string{"AUTH_MODE", "LOCAL_UTC_OFFSET_HOURS", "CHAT_MODEL", "CHAT_RETENTION_DAYS", "DELIVERY_PROVIDER", "DELIVERY_MOCK_AUTOPILOT",
		"ASSIGNMENT_POLICY", "ANALYTICS_PSEUDONYM_KEY", "PAYMENT_PROVIDER", "DELIVERY_PIN_SECRET"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	t.Cleanup(func() { freezeClock(nil); chatModelOverride = nil })
}

func recreateDB(ctx context.Context, admin *pgx.Conn, name, template string) error {
	if _, err := admin.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS "%s" WITH (FORCE)`, name)); err != nil {
		return err
	}
	sql := fmt.Sprintf(`CREATE DATABASE "%s"`, name)
	if template != "" {
		sql += fmt.Sprintf(` TEMPLATE "%s"`, template)
	}
	_, err := admin.Exec(ctx, sql)
	return err
}

// buildTemplate はテンプレートの DB を作る（マイグレーション → 履歴つきの seed。時計は goldenNow に固定）。
func buildTemplate(t *testing.T, admin string) error {
	if err := assertDisposableTarget(admin, templateDB); err != nil {
		return err
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	if err := recreateDB(ctx, conn, templateDB, ""); err != nil {
		return err
	}
	url, err := urlWithDatabase(admin, templateDB)
	if err != nil {
		return err
	}
	if code, err := applyMigrations(ctx, url, false, devNull{}); err != nil || code != 0 {
		return fmt.Errorf("マイグレーションに失敗しました: %v", err)
	}
	pool, err := openPool(ctx, url, 2)
	if err != nil {
		return err
	}
	defer pool.Close()
	dbPool = pool
	freezeClock(&goldenNow)
	defer freezeClock(nil)
	_, err = seedDemo(seedOptions{reset: true, history: true})
	return err
}

// newTestDB はテストごとの DB（テンプレートの複製）を開いて、dbPool に結ぶ。終わりに閉じて消す。
func newTestDB(t *testing.T) {
	t.Helper()
	admin := adminURL(t)
	setTestEnv(t)
	templateOnce.Do(func() { templateErr = buildTemplate(t, admin) })
	if templateErr != nil {
		t.Fatalf("テンプレートの DB を作れません: %v", templateErr)
	}
	name := fmt.Sprintf("%s%d_%d", testDBPrefix, os.Getpid(), dbCounter.Add(1))
	if err := assertDisposableTarget(admin, name); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatalf("DB に接続できません: %T", err)
	}
	if err := recreateDB(ctx, conn, name, templateDB); err != nil {
		conn.Close(ctx)
		t.Fatalf("DB を複製できません: %v", err)
	}
	url, _ := urlWithDatabase(admin, name)
	pool, err := openPool(ctx, url, 8)
	if err != nil {
		t.Fatal(err)
	}
	dbPool = pool
	t.Cleanup(func() {
		pool.Close()
		dbPool = nil
		_, _ = conn.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS "%s" WITH (FORCE)`, name))
		conn.Close(ctx)
	})
}
