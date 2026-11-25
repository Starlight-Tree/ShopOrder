package main

// 設定・マイグレーション実行器・台帳（追記のみ）・同時実行・ログインの制限・掃除・worker・seed の再実行（backend/tests/ の test_settings_and_guard・test_migrate・test_ledger_and_seed・
// test_concurrency・test_hardening の主な検査の移植）。API の流れ全体は golden_test.go が見張る。

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- 設定 ----

func TestProvidersDefaultToMockAndRejectUnknownValues(t *testing.T) {
	for name := range providers {
		t.Setenv(name, "")
		os.Unsetenv(name)
	}
	if provider("PAYMENT_PROVIDER") != "mock" || provider("CHAT_MODEL") != "mock" {
		t.Fatal("既定は模擬")
	}
	t.Setenv("PAYMENT_PROVIDER", "stripe") // まだ許していない本物は、起動の設定ミスとして拒否する
	mustPanicSettings(t, func() { provider("PAYMENT_PROVIDER") })
	t.Setenv("CHAT_MODEL", "gemini")
	if provider("CHAT_MODEL") != "gemini" {
		t.Fatal("gemini は選べる（実装が無いので起動で止まる）")
	}
	mustPanicSettings(t, func() { getChatModel() })
	if err := checkStartup(); err == nil {
		t.Fatal("CHAT_MODEL=gemini は起動の検査で止まるはず")
	}
}

func mustPanicSettings(t *testing.T, f func()) {
	t.Helper()
	defer func() {
		if _, ok := recover().(settingsError); !ok {
			t.Fatal("設定の誤りで、止まるはず")
		}
	}()
	f()
}

func TestStartupRefusesDevOnlySettingsOutsideDevelopment(t *testing.T) {
	for _, k := range []string{"AUTH_MODE", "ORDER_HOURS_CHECK", "PAYMENT_PROVIDER", "CHAT_MODEL", "DELIVERY_PIN_SECRET", "LOCAL_UTC_OFFSET_HOURS"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	for _, env := range []string{"", "production", "Production", "prod", "staging"} { // 許可リスト方式: development / test 以外は、開発ではない
		t.Setenv("APP_ENV", env)
		if err := checkStartup(); err == nil {
			t.Errorf("APP_ENV=%q で、AUTH_MODE=dev の既定が通った", env)
		}
	}
	t.Setenv("APP_ENV", "test")
	if err := checkStartup(); err != nil {
		t.Fatalf("test は通る: %v", err)
	}
	t.Setenv("LOCAL_UTC_OFFSET_HOURS", "99") // 不正な値は、リクエストの 500 ではなく、起動で止める
	if err := checkStartup(); err == nil {
		t.Error("不正なオフセットが通った")
	}
	t.Setenv("LOCAL_UTC_OFFSET_HOURS", "")
	os.Unsetenv("LOCAL_UTC_OFFSET_HOURS")
	t.Setenv("APP_ENV", "production")
	mustPanicSettings(t, func() { deliveryPinSecret() }) // 本番相当で鍵が無ければ拒否
	t.Setenv("DELIVERY_PIN_SECRET", "s3cret")
	if deliveryPinSecret() != "s3cret" {
		t.Fatal("鍵を読めない")
	}
}

func TestSeedRefusesWithoutDemoDataAllow(t *testing.T) {
	t.Setenv("DEMO_DATA", "")
	os.Unsetenv("DEMO_DATA")
	if requireDemoDataAllowed() == "" || seedMain(nil) == 0 {
		t.Fatal("DEMO_DATA=allow が無いのに、seed が通った")
	}
	t.Setenv("DEMO_DATA", "allow")
	if requireDemoDataAllowed() != "" {
		t.Fatal("allow なら通る")
	}
	t.Setenv("APP_ENV", "production")
	if requireDemoDataAllowed() == "" {
		t.Fatal("production では拒否")
	}
}

// ---- マイグレーション実行器 ----

func migrateTestDB(t *testing.T, suffix string) (string, func()) {
	t.Helper()
	admin := adminURL(t)
	name := fmt.Sprintf("shop_order_go_migrate_%s_%d", suffix, os.Getpid())
	if err := assertDisposableTarget(admin, name); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	if err := recreateDB(ctx, conn, name, ""); err != nil {
		t.Fatal(err)
	}
	url, _ := urlWithDatabase(admin, name)
	return url, func() {
		_, _ = conn.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS "%s" WITH (FORCE)`, name))
		conn.Close(ctx)
	}
}

func runMigrate(t *testing.T, url string, dry bool) (int, string) {
	var out strings.Builder
	code, err := applyMigrations(context.Background(), url, dry, &out)
	if err != nil {
		return code, out.String() + "ERR:" + fmt.Sprintf("%T", err)
	}
	return code, out.String()
}

func tableSet(t *testing.T, url string) map[string]bool {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, _ := conn.Query(ctx, "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		out[n] = true
	}
	return out
}

func appliedVersions(t *testing.T, url string) []string {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, _ := conn.Query(ctx, "SELECT version FROM schema_migrations ORDER BY 1")
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		rows.Scan(&v)
		out = append(out, v)
	}
	return out
}

func allVersions(t *testing.T) []string {
	files, err := migrationFiles()
	if err != nil {
		t.Fatal(err)
	}
	var v []string
	for _, f := range files {
		v = append(v, f.version)
	}
	return v
}

// withMigrations は、実際のマイグレーションに、足す・書き換えたファイルを重ねた版を使う。
func withMigrations(t *testing.T, mutate func(m fstest.MapFS)) {
	t.Helper()
	m := fstest.MapFS{}
	entries, _ := fs.ReadDir(migrationsFS, "migrations")
	for _, e := range entries {
		data, _ := fs.ReadFile(migrationsFS, "migrations/"+e.Name())
		m["migrations/"+e.Name()] = &fstest.MapFile{Data: data}
	}
	mutate(m)
	old := migrationSource
	migrationSource = m
	t.Cleanup(func() { migrationSource = old })
}

func nextNumber(t *testing.T, skip int) string {
	return fmt.Sprintf("%04d", len(allVersions(t))+1+skip)
}

func TestNewDatabaseGetsAllMigrationsAndRerunIsANoop(t *testing.T) {
	url, cleanup := migrateTestDB(t, "a")
	defer cleanup()
	if code, out := runMigrate(t, url, false); code != 0 {
		t.Fatal(out)
	}
	tables := tableSet(t, url)
	for _, n := range []string{"areas", "stores", "menu_items", "menu_variants", "schema_migrations", "stock_items", "stock_balances", "stock_movements", "users", "carts", "staff_accounts", "orders", "order_events", "payments"} {
		if !tables[n] {
			t.Errorf("表が無い: %s", n)
		}
	}
	if got := appliedVersions(t, url); strings.Join(got, ",") != strings.Join(allVersions(t), ",") {
		t.Errorf("記録: %v", got)
	}
	if code, out := runMigrate(t, url, false); code != 0 || !strings.Contains(out, "未適用: なし") {
		t.Errorf("再実行: %d %s", code, out)
	}
}

func TestDryRunChangesNothing(t *testing.T) {
	url, cleanup := migrateTestDB(t, "b")
	defer cleanup()
	code, out := runMigrate(t, url, true)
	if code != 0 || !strings.Contains(out, "0001_stores_and_menu") || !strings.Contains(out, "0004_orders") {
		t.Errorf("%d %s", code, out)
	}
	if tableSet(t, url)["schema_migrations"] {
		t.Error("dry-run が DB を変えた")
	}
}

func TestAChangedAppliedFileStopsTheRun(t *testing.T) {
	url, cleanup := migrateTestDB(t, "c")
	defer cleanup()
	if code, out := runMigrate(t, url, false); code != 0 {
		t.Fatal(out)
	}
	withMigrations(t, func(m fstest.MapFS) {
		f := m["migrations/0001_stores_and_menu.sql"]
		f.Data = append(append([]byte{}, f.Data...), []byte("\n-- 書き換え\n")...)
	})
	if code, out := runMigrate(t, url, false); code != 1 || !strings.Contains(out, "書き換えられています") {
		t.Errorf("%d %s", code, out)
	}
}

func TestAFailedMigrationRollsBackAndIsNotRecorded(t *testing.T) {
	url, cleanup := migrateTestDB(t, "d")
	defer cleanup()
	real := allVersions(t)
	withMigrations(t, func(m fstest.MapFS) {
		m["migrations/"+nextNumber(t, 0)+"_broken.sql"] = &fstest.MapFile{Data: []byte("CREATE TABLE half_done (id int);\nSELECT 1/0;\n")}
	})
	code, _ := runMigrate(t, url, false)
	if code == 0 {
		t.Fatal("壊れたマイグレーションが通った")
	}
	if tableSet(t, url)["half_done"] { // 途中までの変更は残らない
		t.Error("途中までの変更が残った")
	}
	if got := appliedVersions(t, url); strings.Join(got, ",") != strings.Join(real, ",") {
		t.Errorf("記録: %v（壊れた次の番号は記録されない）", got)
	}
}

func TestDropAndTruncateAreRefused(t *testing.T) {
	url, cleanup := migrateTestDB(t, "e")
	defer cleanup()
	withMigrations(t, func(m fstest.MapFS) {
		m["migrations/"+nextNumber(t, 0)+"_bad.sql"] = &fstest.MapFile{Data: []byte("DROP TABLE stores;\n")}
	})
	if code, out := runMigrate(t, url, false); code != 1 || !strings.Contains(out, "DROP / TRUNCATE") {
		t.Errorf("%d %s", code, out)
	}
	if tableSet(t, url)["stores"] { // 何も流れていない
		t.Error("検査の前に流れた")
	}
}

func TestMigrationNumberingRules(t *testing.T) {
	withMigrations(t, func(m fstest.MapFS) {
		m["migrations/"+nextNumber(t, 1)+"_gap.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;\n")} // 1 つ飛ばした番号
	})
	if _, err := migrationFiles(); err == nil {
		t.Error("番号の欠けを許した")
	}
	withMigrations(t, func(m fstest.MapFS) {
		m["migrations/bad name.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;\n")}
	})
	if _, err := migrationFiles(); err == nil {
		t.Error("規則に合わない名前を許した")
	}
}

// ---- 台帳（追記のみ）・seed の再実行 ----

func execAll(t *testing.T, ctx context.Context, conn *pgx.Conn, sqls ...string) {
	t.Helper()
	for _, s := range sqls {
		if _, err := conn.Exec(ctx, s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

func TestLedgerRowsCannotBeUpdatedOrDeleted(t *testing.T) {
	newTestDB(t)
	ctx := context.Background()
	url := os.Getenv("DATABASE_URL")
	_ = url
	var user, store, order int
	withTx(func(tx *tx) {
		user = tx.one("INSERT INTO users (auth_user_id, display_name) VALUES ('dev:ledger', 'ledger') RETURNING id").i("id")
		store = tx.one("SELECT id FROM stores ORDER BY id LIMIT 1").i("id")
		order = tx.one("INSERT INTO orders (public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, total_lumi, idempotency_key, placed_at) "+
			"VALUES ('ABCDEFGH', $1, $2, 'placed', 'pickup', 1, '2030-01-01', 100, 100, 'k-ledger-1', now()) RETURNING id", user, store).i("id")
		tx.exec("INSERT INTO order_events (order_id, from_status, to_status, actor_type, at) VALUES ($1, NULL, 'placed', 'customer', now())", order)
	})
	_ = ctx
	for _, sql := range []string{"UPDATE stock_movements SET qty = qty + 1", "DELETE FROM stock_movements", "UPDATE order_events SET reason = 'x'", "DELETE FROM order_events"} {
		failed := func() (failed bool) {
			defer func() {
				if rec := recover(); rec != nil {
					if pgCode(rec) == "23000" || strings.Contains(fmt.Sprint(rec), "append-only") {
						failed = true
						return
					}
					panic(rec)
				}
			}()
			withTx(func(tx *tx) { tx.exec(sql) })
			return false
		}()
		if !failed {
			t.Errorf("台帳が書き換わった: %s", sql)
		}
	}
	// reset の設定があるトランザクションの中だけ、DELETE が通る。UPDATE は常に拒否
	rejected := func(sql string, reset bool) (failed bool) {
		defer func() {
			if rec := recover(); rec != nil {
				failed = true
			}
		}()
		withTx(func(tx *tx) {
			if reset {
				tx.exec("SET LOCAL shop_order.allow_ledger_reset = 'on'")
			}
			tx.exec(sql)
		})
		return false
	}
	if !rejected("UPDATE stock_movements SET qty = qty", true) {
		t.Error("設定があっても UPDATE は拒否")
	}
	if rejected("DELETE FROM order_events", true) {
		t.Error("設定があれば DELETE は通る")
	}
	if !rejected("DELETE FROM order_events", false) && false {
		t.Log("行が無いと行トリガーは動かない")
	}
}

func TestSeedRerunKeepsStockAndResetRebuilds(t *testing.T) {
	newTestDB(t)
	count := func(table string) int {
		return inTx(func(tx *tx) int { return tx.one("SELECT count(*) AS n FROM " + table).i("n") })
	}
	freezeClock(&goldenNow)
	before := map[string]int{}
	for _, tb := range []string{"stores", "menu_variants", "recipe_lines", "stock_movements", "staff_accounts", "delivery_slots", "orders"} {
		before[tb] = count(tb)
	}
	if _, err := seedDemo(seedOptions{}); err != nil { // 足りないものを入れる（何度流しても同じ。在庫の数は上書きしない）
		t.Fatal(err)
	}
	for tb, n := range before {
		if count(tb) != n {
			t.Errorf("再実行で %s が %d → %d", tb, n, count(tb))
		}
	}
	if inTx(func(tx *tx) int { return len(reconcileStock(tx)) }) != 0 {
		t.Error("台帳と残高が合わない")
	}
	if _, err := seedDemo(seedOptions{history: true}); err == nil {
		t.Error("--history は --reset と一緒でないと拒否")
	}
	if _, err := seedDemo(seedOptions{reset: true}); err != nil {
		t.Fatal(err)
	}
	if count("orders") != 0 || count("stores") != 12 {
		t.Errorf("--reset: orders=%d stores=%d", count("orders"), count("stores"))
	}
}

// ---- 同時実行 ----

func raceOrders(t *testing.T, s *testShop, store, item string, stock, users int) ([]map[string]string, []int, []map[string]any) {
	s.setAvailable(store, item, stock)
	v := s.variant(item, "-", "-")
	type pair struct {
		h map[string]string
		p map[string]any
	}
	var ps []pair
	for i := 0; i < users; i++ {
		h := s.user()
		ps = append(ps, pair{h, s.proposal(h, store, [][2]int{{v, 1}})})
	}
	codes := make([]int, users)
	bodies := make([]map[string]any, users)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range ps {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i], bodies[i] = s.place(ps[i].h, ps[i].p["id"].(string))
		}(i)
	}
	close(start)
	wg.Wait()
	var hs []map[string]string
	for _, p := range ps {
		hs = append(hs, p.h)
	}
	return hs, codes, bodies
}

func TestConcurrentOrdersNeverOversell(t *testing.T) {
	for _, c := range [][2]int{{1, 2}, {3, 6}} {
		stock, users := c[0], c[1]
		t.Run(fmt.Sprintf("stock%d_users%d", stock, users), func(t *testing.T) {
			s := newShop(t)
			store := "ruins-terrace"
			hs, codes, bodies := raceOrders(t, s, store, "gateau-chocolat", stock, users)
			ok := 0
			for i, code := range codes {
				if code == 201 {
					ok++
					continue
				}
				d, _ := bodies[i]["detail"].(map[string]any)
				if code != 409 || d["code"] != "sold_out" {
					t.Errorf("失敗の形: %d %v", code, bodies[i])
				}
			}
			if ok != stock { // 成功は、ちょうど在庫の数
				t.Errorf("成功 %d（在庫 %d）", ok, stock)
			}
			var onHand, reserved int
			withTx(func(tx *tx) {
				r := tx.one("SELECT b.on_hand, b.reserved FROM stock_balances b JOIN stock_items i ON i.id = b.item_id WHERE b.store_id = $1 AND i.code = 'gateau-chocolat'", s.storeID(store))
				onHand, reserved = r.i("on_hand"), r.i("reserved")
			})
			if onHand-reserved != 0 {
				t.Errorf("出せる量 %d", onHand-reserved)
			}
			if inTx(func(tx *tx) int { return len(reconcileStock(tx)) }) != 0 {
				t.Error("台帳と残高が合わない")
			}
			total := 0
			for _, h := range hs {
				var orders []any
				s.getJSON("/api/orders", h, &orders)
				total += len(orders)
			}
			if total != stock {
				t.Errorf("注文の数 %d", total)
			}
		})
	}
}

func TestConcurrentCancelAndOrderKeepTheLedgerConsistent(t *testing.T) {
	s := newShop(t)
	store := "ruins-hut"
	s.setAvailable(store, "cheesecake", 1)
	holder := s.user()
	v := s.variant("cheesecake", "-", "-")
	held := s.order(holder, store, [][2]int{{v, 1}}) // 在庫 0 になる
	challenger := s.user()
	s.fillCart(challenger, store, [][2]int{{v, 1}})
	if code, b, _ := s.do("POST", "/api/cart/checkout-proposal", challenger, nil); code != 409 || !strings.Contains(string(b), "sold_out") {
		t.Fatalf("在庫が無いので提案は作れない: %d %s", code, b)
	}
	s.must("POST", fmt.Sprintf("/api/orders/%s/cancel", held["public_id"]), holder, nil, 200)
	p := s.must("POST", "/api/cart/checkout-proposal", challenger, nil, 200)
	if code, _ := s.place(challenger, p["id"].(string)); code != 201 {
		t.Fatalf("place: %d", code)
	}
	if inTx(func(tx *tx) int { return len(reconcileStock(tx)) }) != 0 {
		t.Error("台帳と残高が合わない")
	}
}

// ---- ログインの制限・掃除・worker ----

func TestStaffLoginIsLimitedPerEmailAndResetsOnSuccess(t *testing.T) {
	s := newShop(t)
	email := "staff-residential-dome@oasis-cafe.example"
	for i := 0; i < loginMaxFailures; i++ {
		if code, _, _ := s.do("POST", "/api/staff/login", nil, map[string]any{"email": email, "password": "wrong"}); code != 401 {
			t.Fatalf("失敗 %d: %d", i, code)
		}
	}
	if code, b, _ := s.do("POST", "/api/staff/login", nil, map[string]any{"email": email, "password": goldenStaffPass}); code != 429 || !strings.Contains(string(b), "too_many_attempts") {
		t.Fatalf("上限のあとは 429（正しいパスワードでも）: %d %s", code, b)
	}
	// 別のメールには及ばない。成功すれば、そのメールの試行は消える
	other := "staff-residential-market@oasis-cafe.example"
	s.do("POST", "/api/staff/login", nil, map[string]any{"email": other, "password": "wrong"})
	s.must("POST", "/api/staff/login", nil, map[string]any{"email": other, "password": goldenStaffPass}, 200)
	if n := inTx(func(tx *tx) int {
		return tx.one("SELECT count(*) AS n FROM staff_login_attempts WHERE email_hash = $1", emailHash(other)).i("n")
	}); n != 0 {
		t.Errorf("成功のあと、試行が %d 件残っている", n)
	}
	// 窓（15 分）が過ぎれば、また試せる
	at := time.Now().Add(16 * time.Minute)
	freezeClock(&at)
	s.must("POST", "/api/staff/login", nil, map[string]any{"email": email, "password": goldenStaffPass}, 200)
}

func TestSweepRemovesOldRowsOnly(t *testing.T) {
	s := newShop(t)
	h1, h2 := s.user(), s.user()
	v := s.variant("americano", "M", "hot")
	old := s.proposal(h1, "residential-main", [][2]int{{v, 1}})
	fresh := s.proposal(h2, "residential-main", [][2]int{{v, 1}})
	withTx(func(tx *tx) {
		tx.exec("UPDATE checkout_proposals SET expires_at = $1 WHERE id = $2", utcNow().Add(-48*time.Hour), old["id"].(string))
		tx.exec("INSERT INTO staff_login_attempts (email_hash, at) VALUES ($1, $2)", strings.Repeat("ab", 32), utcNow().Add(-48*time.Hour))
	})
	if sweepRun() < 2 {
		t.Fatal("掃除が足りない")
	}
	exists := func(id string) bool {
		return inTx(func(tx *tx) bool { return tx.one("SELECT 1 FROM checkout_proposals WHERE id = $1", id) != nil })
	}
	if exists(old["id"].(string)) || !exists(fresh["id"].(string)) {
		t.Error("古い提案だけが消えるはず")
	}
}

func TestExpireStaleReleasesEachOrderInItsOwnTransaction(t *testing.T) {
	s := newShop(t)
	v := s.variant("americano", "M", "hot")
	var ids []string
	for i := 0; i < 3; i++ {
		o := s.order(s.user(), "rock-plaza", [][2]int{{v, 1}})
		ids = append(ids, o["public_id"].(string))
	}
	withTx(func(tx *tx) {
		tx.exec("UPDATE stock_reservations SET expires_at = $1 WHERE order_id IN (SELECT id FROM orders WHERE public_id = ANY($2))", utcNow().Add(-time.Minute), ids)
	})
	if expireStale() < 3 {
		t.Fatal("3 件戻るはず")
	}
	if inTx(func(tx *tx) int { return len(reconcileStock(tx)) }) != 0 {
		t.Error("台帳と残高が合わない")
	}
}

func TestWorkerRunOnceRestoresExpiredAndSweeps(t *testing.T) {
	s := newShop(t)
	o := s.order(s.user(), "rock-plaza", [][2]int{{s.variant("americano", "M", "hot"), 1}})
	withTx(func(tx *tx) {
		tx.exec("UPDATE stock_reservations SET expires_at = $1 WHERE order_id = (SELECT id FROM orders WHERE public_id = $2)", utcNow().Add(-time.Minute), o["public_id"].(string))
	})
	if workerRunOnce() < 1 {
		t.Fatal("期限切れの注文を戻すはず")
	}
	st := inTx(func(tx *tx) string {
		return tx.one("SELECT status FROM orders WHERE public_id = $1", o["public_id"].(string)).s("status")
	})
	if st != "cancelled" {
		t.Errorf("status=%s", st)
	}
}

func TestAnalyticsBuildIsIdempotentAndRekeyIsRequired(t *testing.T) {
	newTestDB(t)
	freezeClock(&goldenNow)
	today := dateOf(goldenNow.Add(9 * time.Hour))
	key := []byte("unit-test-pseudonym-key-0123456789")
	snapshot := func() string {
		return inTx(func(tx *tx) string {
			a := tx.one("SELECT count(*) AS n, COALESCE(sum(sales_lumi), 0) AS s FROM analytics.daily_store_summary")
			b := tx.one("SELECT count(*) AS n FROM analytics.customer_rfm")
			return fmt.Sprintf("%d/%d/%d", a.i("n"), a.i64("s"), b.i("n"))
		})
	}
	// 鍵は seed のときの開発用の鍵。別の鍵では、止まる（--rekey で作り直す）
	before := snapshot()
	withTx(func(tx *tx) {
		analyticsBuild(tx, today, devPseudonymKeyBytes(), 9, goldenNow, nil, nil, false)
	})
	if snapshot() != before {
		t.Errorf("同じ入力で、作り直しても同じ: %s → %s", before, snapshot())
	}
	func() {
		defer func() {
			if _, ok := recover().(keyChanged); !ok {
				t.Error("鍵が違うのに、止まらなかった")
			}
		}()
		withTx(func(tx *tx) { analyticsBuild(tx, today, key, 9, goldenNow, nil, nil, false) })
	}()
	withTx(func(tx *tx) { analyticsBuild(tx, today, key, 9, goldenNow, nil, nil, true) }) // --rekey は通る
}

func devPseudonymKeyBytes() []byte { return []byte(devPseudonymKey) }
