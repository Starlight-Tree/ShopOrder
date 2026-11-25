package main

// 日次集計の作成（元データ → analytics の表）。指標の定義は docs/metrics.md（backend/app/analytics_build.py の移植）。
//
//	api analytics-build                    前回の続き（直近 15 日ぶんは作り直す）から、昨日まで
//	api analytics-build --all              最初の注文の日から、昨日まで
//	api analytics-build --from 2026-09-01 --to 2026-09-30
//	api analytics-build --rekey            仮名 ID の鍵を変えたとき。顧客の表（仮名 ID の対応を含む）を空にして作り直す
//
//   - 確定した日（business_date < 今日）だけを作る。当日は元データから都度（API が読む）
//   - 日付の範囲を、1 つのトランザクションで置き換える（同じ入力なら何度流しても同じ結果。アドバイザリーロックで同時に 2 つ動かさない）
//   - 営業日は analytics.store_days()（定休日 + 臨時休業。注文のある日は営業日）。営業日は売上 0 でも summary の行を作り、休業日は行を作らない
//   - 顧客は、秘密の鍵（ANALYTICS_PSEUDONYM_KEY）の HMAC の仮名 ID だけを analytics に置く。鍵が前回と違えば、止まる（--rekey で作り直す）
//   - 出力は件数だけ。鍵・個人情報は出さない

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"time"
)

const (
	analyticsLockKey = 7_204_006
	lookbackDays     = 15 // 前回の続きから作るとき、直近のこの日数ぶんは作り直す（確定の後に変わった注文を拾う）。宅配は枠を 7 日先まで選べ、再配達でさらに 7 日延びうる
	rfmWindowDays    = 90 // RFM の期間（今日の手前の 90 日）
)

var dailyTables = []string{"daily_store_summary", "daily_store_item_sales", "daily_store_hourly", "daily_stock_levels", "daily_stock_waste"}
var customerTables = []string{"customer_rfm", "customer_monthly"}

// keyChanged は仮名 ID の鍵が、前に集計を作ったときと違う。
type keyChanged struct{ msg string }

func (e keyChanged) Error() string { return e.msg }

// pseudonymID は顧客の仮名 ID。鍵つきの HMAC-SHA256 の先頭 128 ビット（16 進 32 文字）。鍵が無ければ、誰の ID かは戻せない。
func pseudonymID(key []byte, userID int) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(fmt.Sprintf("user:%d", userID)))
	return hex.EncodeToString(m.Sum(nil))[:32]
}

func keyFingerprint(key []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("analytics-key-fingerprint-v1"))
	return hex.EncodeToString(m.Sum(nil))[:16]
}

// ---- 営業日の範囲 ----

func earliestOrderDate(t *tx) *dateOnly {
	r := t.one("SELECT min(business_date) AS d FROM orders")
	if r == nil || r.isNull("d") {
		return nil
	}
	return r.dateN("d")
}

func lastBuiltDate(t *tx) *dateOnly {
	r := t.one("SELECT max(business_date) AS d FROM analytics.daily_store_summary")
	if r == nil || r.isNull("d") {
		return nil
	}
	return r.dateN("d")
}

// defaultStart は続きから作る開始日。作ったことがなければ最初の注文の日。注文が無ければ nil。
func defaultStart(t *tx, end dateOnly) *dateOnly {
	if last := lastBuiltDate(t); last != nil {
		s := last.addDays(-(lookbackDays - 1))
		if end.before(s) {
			s = end
		}
		if earliest := earliestOrderDate(t); earliest != nil {
			if s.before(*earliest) {
				s = *earliest
			}
		} else if s.before(end) {
			s = end
		}
		return &s
	}
	return earliestOrderDate(t)
}

// ---- 日次（店 × 日）----

// buildDays は start〜end（営業日）の日次集計を置き換える。戻り値は、表ごとの作った行数。
func buildDays(t *tx, start, end dateOnly, offsetHours int, now time.Time) []countKV {
	s, e := start.String(), end.String()
	for _, table := range dailyTables {
		t.exec("DELETE FROM analytics."+table+" WHERE business_date BETWEEN $1 AND $2", s, e)
	}
	var counts []countKV
	n := t.exec("INSERT INTO analytics.daily_store_summary (store_id, business_date, orders, cancelled_orders, sales_lumi, built_at) "+
		"SELECT c.store_id, c.business_date, "+
		"  count(f.order_id) FILTER (WHERE f.status = 'completed'), count(f.order_id) FILTER (WHERE f.status = 'cancelled'), "+
		"  COALESCE(sum(f.total_lumi) FILTER (WHERE f.status = 'completed'), 0), $3 "+
		"FROM analytics.store_days($1, $2) c "+
		"LEFT JOIN analytics.order_facts f ON f.store_id = c.store_id AND f.business_date = c.business_date "+
		"WHERE c.is_open GROUP BY c.store_id, c.business_date "+
		"ON CONFLICT (store_id, business_date) DO UPDATE SET orders = EXCLUDED.orders, cancelled_orders = EXCLUDED.cancelled_orders, "+
		"  sales_lumi = EXCLUDED.sales_lumi, built_at = EXCLUDED.built_at", s, e, now)
	counts = append(counts, countKV{"daily_store_summary", int(n)})

	n = t.exec("INSERT INTO analytics.daily_store_item_sales (store_id, business_date, item_id, fulfillment, item_code, item_name, category, qty, sales_lumi, built_at) "+
		"SELECT l.store_id, l.business_date, l.item_id, l.fulfillment, max(l.item_code), max(l.item_name), max(l.category), sum(l.qty), sum(l.line_total_lumi), $3 "+
		"FROM analytics.sales_lines l WHERE l.business_date BETWEEN $1 AND $2 "+
		"GROUP BY l.store_id, l.business_date, l.item_id, l.fulfillment "+
		"ON CONFLICT (store_id, business_date, item_id, fulfillment) DO UPDATE SET item_code = EXCLUDED.item_code, item_name = EXCLUDED.item_name, "+
		"  category = EXCLUDED.category, qty = EXCLUDED.qty, sales_lumi = EXCLUDED.sales_lumi, built_at = EXCLUDED.built_at", s, e, now)
	counts = append(counts, countKV{"daily_store_item_sales", int(n)})

	n = t.exec("INSERT INTO analytics.daily_store_hourly (store_id, business_date, hour, fulfillment, orders, sales_lumi, built_at) "+
		"SELECT f.store_id, f.business_date, EXTRACT(HOUR FROM (f.placed_at AT TIME ZONE 'UTC') + make_interval(hours => $4::int))::int, f.fulfillment, "+
		"  count(*), sum(f.total_lumi), $3 "+
		"FROM analytics.order_facts f WHERE f.status = 'completed' AND f.business_date BETWEEN $1 AND $2 "+
		"GROUP BY 1, 2, 3, 4 "+
		"ON CONFLICT (store_id, business_date, hour, fulfillment) DO UPDATE SET orders = EXCLUDED.orders, sales_lumi = EXCLUDED.sales_lumi, built_at = EXCLUDED.built_at",
		s, e, now, offsetHours)
	counts = append(counts, countKV{"daily_store_hourly", int(n)})

	// 在庫: 台帳（receive・consume・waste・adjust）から、その日の締めの残量を再計算する。開始日より前の分は、まとめて基準にする
	n = t.exec("WITH mv AS ("+
		"  SELECT store_id, item_id, ((occurred_at AT TIME ZONE 'UTC') + make_interval(hours => $4::int))::date AS d, kind, qty "+
		"  FROM stock_movements WHERE kind IN ('receive', 'consume', 'waste', 'adjust')), "+
		"daily AS ("+
		"  SELECT store_id, item_id, d, sum(qty) AS net, "+
		"    COALESCE(sum(qty) FILTER (WHERE kind = 'receive'), 0) AS received, COALESCE(-sum(qty) FILTER (WHERE kind = 'consume'), 0) AS consumed, "+
		"    COALESCE(-sum(qty) FILTER (WHERE kind = 'waste'), 0) AS wasted, COALESCE(sum(qty) FILTER (WHERE kind = 'adjust'), 0) AS adjusted "+
		"  FROM mv WHERE d <= $2::date GROUP BY store_id, item_id, d), "+
		"base AS (SELECT store_id, item_id, sum(net) AS base FROM daily WHERE d < $1::date GROUP BY store_id, item_id), "+
		"grid AS ("+
		"  SELECT p.store_id, p.item_id, p.item_code, g.d FROM analytics.stock_position p "+
		"  CROSS JOIN (SELECT $1::date + n AS d FROM generate_series(0, $2::date - $1::date) AS n) g), "+
		"run AS ("+
		"  SELECT grid.store_id, grid.item_id, grid.item_code, grid.d, "+
		"    COALESCE(base.base, 0) + sum(COALESCE(daily.net, 0)) OVER (PARTITION BY grid.store_id, grid.item_id ORDER BY grid.d) AS on_hand_end, "+
		"    COALESCE(daily.received, 0) AS received, COALESCE(daily.consumed, 0) AS consumed, COALESCE(daily.wasted, 0) AS wasted, COALESCE(daily.adjusted, 0) AS adjusted "+
		"  FROM grid LEFT JOIN daily ON daily.store_id = grid.store_id AND daily.item_id = grid.item_id AND daily.d = grid.d "+
		"  LEFT JOIN base ON base.store_id = grid.store_id AND base.item_id = grid.item_id) "+
		"INSERT INTO analytics.daily_stock_levels (store_id, business_date, item_id, item_code, on_hand_end, received, consumed, wasted, adjusted, built_at) "+
		"SELECT r.store_id, r.d, r.item_id, r.item_code, r.on_hand_end, r.received, r.consumed, r.wasted, r.adjusted, $3 "+
		"FROM run r JOIN analytics.store_days($1, $2) c ON c.store_id = r.store_id AND c.business_date = r.d AND c.is_open "+
		"ON CONFLICT (store_id, business_date, item_id) DO UPDATE SET on_hand_end = EXCLUDED.on_hand_end, received = EXCLUDED.received, "+
		"  consumed = EXCLUDED.consumed, wasted = EXCLUDED.wasted, adjusted = EXCLUDED.adjusted, built_at = EXCLUDED.built_at",
		s, e, now, offsetHours)
	counts = append(counts, countKV{"daily_stock_levels", int(n)})

	n = t.exec("INSERT INTO analytics.daily_stock_waste (store_id, business_date, item_id, reason_code, qty, built_at) "+
		"SELECT m.store_id, ((m.occurred_at AT TIME ZONE 'UTC') + make_interval(hours => $4::int))::date AS d, m.item_id, "+
		"  CASE WHEN m.reason ~* $5 THEN 'expired' WHEN m.reason ~* $6 THEN 'damaged' WHEN m.reason ~* $7 THEN 'quality' ELSE 'other' END, "+
		"  -sum(m.qty), $3 "+
		"FROM stock_movements m WHERE m.kind = 'waste' "+
		"  AND ((m.occurred_at AT TIME ZONE 'UTC') + make_interval(hours => $4::int))::date BETWEEN $1 AND $2 "+
		"GROUP BY 1, 2, 3, 4 "+
		"ON CONFLICT (store_id, business_date, item_id, reason_code) DO UPDATE SET qty = EXCLUDED.qty, built_at = EXCLUDED.built_at",
		s, e, now, offsetHours, wastePatterns[0].pattern, wastePatterns[1].pattern, wastePatterns[2].pattern)
	counts = append(counts, countKV{"daily_stock_waste", int(n)})
	return counts
}

// ---- 顧客（仮名 ID）----

// buildCustomers は顧客の表（RFM・月ごと）を、確定した日（today の手前）の注文から作り直す。仮名 ID の対応は、足りない顧客だけ足す。
func buildCustomers(t *tx, today dateOnly, key []byte, now time.Time, rekey bool) []countKV {
	fingerprint := keyFingerprint(key)
	if row := t.one("SELECT value FROM analytics.build_state WHERE key = 'key_fingerprint'"); row != nil && row.s("value") != fingerprint {
		if !rekey {
			panic(keyChanged{"仮名 ID の鍵が、前回の集計と違います。顧客の表を作り直すときは --rekey を付けてください。"})
		}
		t.exec("DELETE FROM analytics.customer_pseudonyms")
		for _, table := range customerTables {
			t.exec("DELETE FROM analytics." + table)
		}
	}
	t.exec("INSERT INTO analytics.build_state (key, value, updated_at) VALUES ('key_fingerprint', $1, $2) "+
		"ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", fingerprint, now)

	// 仮名 ID の対応: 確定した日に completed の注文がある顧客を、足りない分だけ
	var users []int
	for _, r := range t.all("SELECT DISTINCT user_id FROM orders WHERE status = 'completed' AND business_date < $1 ORDER BY user_id", today.String()) {
		users = append(users, r.i("user_id"))
	}
	for _, u := range users {
		t.exec("INSERT INTO analytics.customer_pseudonyms (user_id, pseudonym_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING", u, pseudonymID(key, u), now)
	}

	windowStart := today.addDays(-rfmWindowDays)
	stats := t.all("SELECT p.pseudonym_id, count(*) AS orders, sum(o.total_lumi) AS spend, min(o.business_date) AS first_date, max(o.business_date) AS last_date "+
		"FROM orders o JOIN analytics.customer_pseudonyms p ON p.user_id = o.user_id "+
		"WHERE o.status = 'completed' AND o.business_date >= $1 AND o.business_date < $2 GROUP BY p.pseudonym_id ORDER BY p.pseudonym_id", windowStart.String(), today.String())
	t.exec("DELETE FROM analytics.customer_rfm")
	for _, r := range stats {
		recency := today.daysSince(r.date("last_date"))
		orders, spend := r.i("orders"), r.i("spend")
		rs, fs, ms := rScore(recency), fScore(orders), mScore(spend)
		t.exec("INSERT INTO analytics.customer_rfm (pseudonym_id, first_order_date, last_order_date, orders, spend_lumi, recency_days, r_score, f_score, m_score, segment, as_of, built_at) "+
			"VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
			r.s("pseudonym_id"), r.date("first_date").String(), r.date("last_date").String(), orders, spend, recency, rs, fs, ms, segmentOf(rs, fs), today.String(), now)
	}

	t.exec("DELETE FROM analytics.customer_monthly")
	monthly := t.exec("INSERT INTO analytics.customer_monthly (pseudonym_id, month, orders, spend_lumi) "+
		"SELECT p.pseudonym_id, (o.business_date - (EXTRACT(DAY FROM o.business_date)::int - 1)), count(*), sum(o.total_lumi) "+
		"FROM orders o JOIN analytics.customer_pseudonyms p ON p.user_id = o.user_id "+
		"WHERE o.status = 'completed' AND o.business_date < $1 GROUP BY 1, 2", today.String())
	return []countKV{{"customer_pseudonyms", len(users)}, {"customer_rfm", len(stats)}, {"customer_monthly", int(monthly)}}
}

// ---- 全体 ----

type buildResult struct {
	start  *dateOnly
	end    dateOnly
	counts []countKV
}

// analyticsBuild は確定した日（today の手前）の日次集計と、顧客の表を作る。1 つのトランザクションの中（呼ぶ側が commit）。
func analyticsBuild(t *tx, today dateOnly, key []byte, offsetHours int, now time.Time, start, end *dateOnly, rekey bool) buildResult {
	t.exec("SELECT pg_advisory_xact_lock($1)", analyticsLockKey)
	lastFinal := today.addDays(-1)
	e := lastFinal
	if end != nil && !lastFinal.before(*end) {
		e = *end
	}
	st := start
	if st == nil {
		st = defaultStart(t, e)
	}
	var counts []countKV
	if st != nil && !e.before(*st) {
		counts = append(counts, buildDays(t, *st, e, offsetHours, now)...)
	} else {
		st = nil
	}
	counts = append(counts, buildCustomers(t, today, key, now, rekey)...)
	return buildResult{start: st, end: e, counts: counts}
}

// analyticsBuildMain は analytics-build の CLI。
func analyticsBuildMain(args []string) int {
	option := func(name string) string {
		for i, a := range args {
			if a == name && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	has := func(flag string) bool {
		for _, a := range args {
			if a == flag {
				return true
			}
		}
		return false
	}
	var res buildResult
	var failure string
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				switch e := rec.(type) {
				case keyChanged:
					failure = fmt.Sprintf("失敗しました（KeyChanged）。%s", e.msg)
				case settingsError:
					failure = fmt.Sprintf("失敗しました（RuntimeError）。%s", e.msg)
				case dbError:
					failure = fmt.Sprintf("失敗しました（%T）。DB への接続か SQL の実行でエラーです", e.err)
				default:
					panic(rec)
				}
			}
		}()
		key := analyticsPseudonymKey(false)
		var start, end *dateOnly
		if v := option("--from"); v != "" {
			d, ok := parseDate(v)
			if !ok {
				failure = "失敗しました（ValueError）。日付は YYYY-MM-DD で指定してください"
				return
			}
			start = &d
		}
		if v := option("--to"); v != "" {
			d, ok := parseDate(v)
			if !ok {
				failure = "失敗しました（ValueError）。日付は YYYY-MM-DD で指定してください"
				return
			}
			end = &d
		}
		today := dateOf(localNow())
		url := databaseURL()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		pool, err := openPool(ctx, url, 2)
		cancel()
		if err != nil {
			failure = fmt.Sprintf("失敗しました（%T）。DB への接続でエラーです", err)
			return
		}
		defer pool.Close()
		dbPool = pool
		withTx(func(t *tx) {
			if has("--all") && start == nil {
				start = earliestOrderDate(t)
			}
			res = analyticsBuild(t, today, key, localUTCOffsetHours(), utcNow(), start, end, has("--rekey"))
		})
	}()
	if failure != "" {
		fmt.Println(failure)
		return 1
	}
	span := "日次は作る日がありません"
	if res.start != nil {
		span = fmt.Sprintf("%s〜%s", res.start, res.end)
	}
	line := ""
	for i, c := range res.counts {
		if i > 0 {
			line += ", "
		}
		line += fmt.Sprintf("%s %d 行", c.key, c.val)
	}
	fmt.Printf("作成しました（%s）: %s\n", span, line)
	return 0
}

var _ = os.Stdout
