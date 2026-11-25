package main

// worker: 30 秒ごとに、支払い期限を過ぎた注文を取り消して在庫の確保を戻す（expireStale）。宅配（P2）の模擬の進行（mockTick。既定は off）も、ここで回す
// （backend/app/worker.py の移植）。
//
//	api worker
//
// API も、注文の読み取り・確定・スタッフの一覧の前に同じ処理を遅延で呼ぶので、worker が止まっても在庫は固まらない（worker は、誰も触らない注文を戻すため）。
// 複数の worker を動かしても、FOR UPDATE SKIP LOCKED で同じ注文を二重に戻さない。ログには件数だけを出す。

import (
	"context"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func workerInterval() time.Duration {
	raw := strings.TrimSpace(envGet("WORKER_INTERVAL_SECONDS", "30"))
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || f <= 0 {
		return 30 * time.Second
	}
	return time.Duration(f * float64(time.Second))
}

// workerRunOnce は 1 回の巡回。戻した注文の件数を返す（期限切れの提案・古いログイン試行・期限切れのセッションの掃除も、ここで行う）。
// 続けて、模擬の配達を進める（DELIVERY_PROVIDER=mock かつ DELIVERY_MOCK_AUTOPILOT=on のときだけ）。
func workerRunOnce() int {
	restored := expireStale()
	sweepRun()
	mockTick(utcNow())
	return restored
}

func workerMain() int {
	url, err := safeDatabaseURL()
	if err != nil {
		logf("設定エラー: %v", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	pool, err := openPool(startCtx, url, 2)
	cancel()
	if err != nil {
		logf("DB に接続できません (%T)", err)
		return 1
	}
	defer pool.Close()
	dbPool = pool
	interval := workerInterval()
	logf("worker を開始しました（%s 秒ごと）", strconv.FormatFloat(interval.Seconds(), 'f', -1, 64))
	for ctx.Err() == nil {
		func() {
			defer func() {
				if rec := recover(); rec != nil { // 1 回の失敗で止めない。例外の本文（接続情報を含みうる）は出さず、種類だけ
					logf("巡回に失敗しました（%s）", panicKind(rec))
				}
			}()
			workerRunOnce()
		}()
		select {
		case <-ctx.Done():
		case <-time.After(interval):
		}
	}
	logf("worker を停止しました")
	return 0
}
