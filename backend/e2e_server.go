package main

// E2E（frontend/e2e/、Playwright）用の API サーバー（backend/tests/e2e_server.py の移植）。使い捨ての DB を作り直し、マイグレーションとダミーの履歴つき seed を入れて、待ち受ける。
//
//	cd backend && TEST_DATABASE_URL=<使い捨ての Postgres の管理用 URL> go run . e2e-server
//
// DB を作り直す前に guards.go が対象を検査する（使い捨てのサーバーのホスト名と、DB 名 shop_order_* だけを許す）。開発用の DB（db）や本番へは向かない。
// 決済・配達・通知・チャットは模擬（既定）。実 API は呼ばない。Playwright の webServer が起動し、/health が 200 を返したら準備完了（seed のあとに待ち受けるので、その時点でデータは入っている）。

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	e2eDBName        = "shop_order_e2e"
	e2eStaffPassword = "e2e-staff-pass" // ダミー（seed のスタッフのパスワード。frontend/e2e/support/accounts.ts と同じ値）
)

func e2eServerMain() int {
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if err := assertDisposableTarget(adminURL, e2eDBName); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "DB に接続できません (%T)\n", err)
		return 1
	}
	_, err1 := admin.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS "%s" WITH (FORCE)`, e2eDBName))
	_, err2 := admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE "%s"`, e2eDBName))
	_ = admin.Close(ctx)
	if err1 != nil || err2 != nil {
		fmt.Fprintln(os.Stderr, "DB を作り直せません")
		return 1
	}
	url, err := urlWithDatabase(adminURL, e2eDBName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "E2E の接続先の組み立てに失敗しました")
		return 1
	}
	webOrigin := os.Getenv("E2E_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = "http://127.0.0.1:3401" // 画面（next start）のオリジン。API は画面のサーバー側から呼ばれるので、CORS は実質使わない
	}
	for k, v := range map[string]string{
		"DATABASE_URL": url, "DEMO_DATA": "allow", "DEMO_STAFF_PASSWORD": e2eStaffPassword, "APP_ENV": "test", "AUTH_MODE": "dev",
		"ORDER_HOURS_CHECK": "off", "LOCAL_UTC_OFFSET_HOURS": "9", "CORS_ORIGINS": webOrigin,
	} {
		os.Setenv(k, v)
	}
	if code, err := applyMigrations(ctx, url, false, devNull{}); err != nil || code != 0 {
		fmt.Fprintln(os.Stderr, "マイグレーションに失敗しました")
		return 1
	}
	pool, err := openPool(ctx, url, 2)
	if err != nil {
		fmt.Fprintln(os.Stderr, "DB に接続できません")
		return 1
	}
	dbPool = pool
	if _, err := seedDemo(seedOptions{reset: true, history: true}); err != nil {
		fmt.Fprintln(os.Stderr, "seed に失敗しました")
		return 1
	}
	pool.Close()
	port := strings.TrimSpace(envGet("E2E_API_PORT", "8401"))
	return serveAt("127.0.0.1:" + port)
}

type devNull struct{}

func (devNull) Write(p []byte) (int, error) { return len(p), nil }
