package main

// ShopOrder の API（Go）。backend/（Python・FastAPI）の置き換え。設定は環境変数で渡す（settings.go）。
// 1 つのバイナリ api が、引数なしか serve で API、ほかはサブコマンド（migrate・seed・worker・analytics-build・e2e-server・healthcheck）。

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var stdLogger = log.New(os.Stderr, "", log.LstdFlags)

func logf(format string, args ...any) { stdLogger.Printf(format, args...) }

const defaultPort = "8000"

// checkStartup は起動時の検査（lifespan）。設定が不正・未実装なら、API を起動しない。
func checkStartup() (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			if se, ok := rec.(settingsError); ok {
				err = se
				return
			}
			panic(rec)
		}
	}()
	checkStartupAuth() // 本番相当の環境で、開発専用の設定が残っていたら、ここで起動を拒否する
	checkStartupDelivery()
	checkStartupChat()
	return nil
}

func runCLI(args []string) int {
	switch args[0] {
	case "migrate":
		return migrateMain(args[1:])
	case "seed":
		return seedMain(args[1:])
	case "worker":
		return workerMain()
	case "e2e-server":
		return e2eServerMain()
	case "analytics-build":
		return analyticsBuildMain(args[1:])
	case "healthcheck":
		return healthcheckMain()
	}
	fmt.Println("usage: api [serve | migrate | seed | worker | analytics-build | e2e-server | healthcheck] …")
	return 2
}

func main() {
	if len(os.Args) > 1 && os.Args[1] != "serve" {
		os.Exit(runCLI(os.Args[1:]))
	}
	os.Exit(serveMain())
}

func serveMain() int {
	port := strings.TrimSpace(envGet("PORT", defaultPort))
	if port == "" {
		port = defaultPort
	}
	return serveAt(":" + port)
}

// serveAt は API を addr で待ち受ける（起動の検査・DB 接続を含む）。
func serveAt(addr string) int {
	if err := checkStartup(); err != nil {
		logf("設定エラー: %v", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	url, err := safeDatabaseURL()
	if err != nil {
		logf("設定エラー: %v", err)
		return 1
	}
	startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	pool, err := openPool(startCtx, url, dbPoolMax())
	if err == nil {
		err = pool.Ping(startCtx)
	}
	cancel()
	if err != nil {
		logf("DB に接続できません (%T)", err)
		return 1
	}
	dbPool = pool
	defer pool.Close()

	srv := &http.Server{Addr: addr, Handler: newServer(logf), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = srv.Shutdown(shutdown)
	}()
	logf("listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logf("サーバーが止まりました (%T)", err)
		return 1
	}
	return 0
}

// safeDatabaseURL は DATABASE_URL（未設定は設定エラー。値は出さない）。
func safeDatabaseURL() (url string, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			if se, ok := rec.(settingsError); ok {
				err = se
				return
			}
			panic(rec)
		}
	}()
	return databaseURL(), nil
}

// healthcheckMain は、コンテナの死活確認（シェルも curl も無いイメージで使う）。自分の /health に 1 回問い合わせて、200 なら 0。
func healthcheckMain() int {
	port := strings.TrimSpace(envGet("PORT", defaultPort))
	if port == "" {
		port = defaultPort
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
