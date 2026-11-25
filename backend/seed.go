package main

// ローカル用のダミーデータ（架空の惑星ザーハード、アルカ市のオアシス珈琲）を入れる。実在の店・人・企業のデータは使わない（backend/app/seed_demo.py の移植）。
//
//	DEMO_DATA=allow api seed                      足りないものを入れる（何度流しても同じ。価格・レシピ・スタッフは書き直す。在庫の数は上書きしない）
//	DEMO_DATA=allow api seed --reset              店・メニュー・在庫・注文・スタッフを消して入れ直す（台帳の削除は、このときだけ許す）
//	DEMO_DATA=allow api seed --reset --history    上に加えて、過去 90 日のダミーの注文・在庫の台帳と、分析の日次集計（seedhistory.go。--reset と一緒のときだけ）
//
// 店・営業時間・席は docs/world.md の「店舗（12）」。メニューと価格は「新設」の参考値。資料の事実（店・席・営業時間）と、新設の値（メニュー・価格）を、ここでも混ぜない。
// 本番の DB には向けない。DEMO_DATA=allow が無いと、実行を拒否する。データの表は seed_data.go（Python のデータから生成した）。

import (
	"context"
	"fmt"
	"math"
	"os"
	"strings"
	"time"
)

func staffPassword() string {
	if v := os.Getenv("DEMO_STAFF_PASSWORD"); v != "" {
		return v
	}
	return "oasis-demo-pass" // ダミーで、秘密ではない（docs/api.md）
}

// resetOrder はリセットで消す順（外部キーの子から親へ）。台帳（stock_movements・order_events）は、SET LOCAL shop_order.allow_ledger_reset = 'on' のときだけ消せる。
var resetOrder = []string{
	"loyalty_ledger", "stock_reservation_lines", "stock_reservations", "payments", "idempotency_keys", "order_events", "order_items", "deliveries", "orders",
	"store_order_counters", "checkout_proposals", "cart_items", "carts", "addresses", "delivery_slots", "users", "staff_sessions", "staff_login_attempts",
	"couriers", "staff_accounts",
	"stock_movements", "stock_balances", "recipe_lines", "stock_items",
	"menu_variants", "menu_items", "store_closures", "store_zones", "zone_travel_minutes", "delivery_zones", "stores", "areas",
}

type seedOptions struct {
	reset, history bool
	today          *dateOnly
	asOf           *time.Time
}

// seedDemo は seed_demo.main。標準出力に出す要約（1〜2 行）を返す。条件に合わないときは error（実行しない）。
func seedDemo(opts seedOptions) (string, error) {
	if opts.history && !opts.reset {
		return "", fmt.Errorf("--history は --reset と一緒に指定してください（履歴は、空にした DB へ入れます）。実行しませんでした。")
	}
	var today dateOnly
	var asOf time.Time
	if opts.history { // 履歴（P4 の分析用ダミー）。--history のときだけ読み込む
		asOf = utcNow()
		if opts.asOf != nil {
			asOf = *opts.asOf
		}
		if opts.today != nil {
			today = *opts.today
		} else {
			today = dateOf(asOf.Add(time.Duration(localUTCOffsetHours()) * time.Hour))
		}
	}
	var historyCounts []countKV
	withTx(func(t *tx) {
		if opts.reset {
			t.exec("SET LOCAL shop_order.allow_ledger_reset = 'on'") // このトランザクションの中だけ。追記のみの表の DELETE を通す
			resetAnalytics(t)                                        // 分析の表（派生データ）は、元の表より先に空にする
			for _, table := range resetOrder {
				t.exec("DELETE FROM " + table) // 固定の表名。ダミーの入れ直しだけ
			}
		}
		for _, a := range seedAreas {
			t.exec("INSERT INTO areas (code, name, sort) VALUES ($1, $2, $3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort = EXCLUDED.sort", a.code, a.name, a.sort)
		}
		for _, s := range seedStores {
			t.exec("INSERT INTO stores (code, name, area_code, address, open_time, close_time, closed_weekday, last_order_minutes, mobile_order, seats) "+
				"VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, area_code = EXCLUDED.area_code, "+
				"address = EXCLUDED.address, open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time, closed_weekday = EXCLUDED.closed_weekday, "+
				"last_order_minutes = EXCLUDED.last_order_minutes, mobile_order = EXCLUDED.mobile_order, seats = EXCLUDED.seats",
				s.code, s.name, s.area, s.address, s.openTime, s.closeTime, s.closedWeekday, s.lastOrderMinutes, s.mobileOrder, s.seats)
		}
		for i, m := range seedMenu {
			itemID := t.one("INSERT INTO menu_items (code, name, category, description, allergens, season_from, season_to, sold_from, sold_until, sort) "+
				"VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, "+
				"description = EXCLUDED.description, allergens = EXCLUDED.allergens, season_from = EXCLUDED.season_from, season_to = EXCLUDED.season_to, "+
				"sold_from = EXCLUDED.sold_from, sold_until = EXCLUDED.sold_until, sort = EXCLUDED.sort RETURNING id",
				m.code, m.name, m.category, m.description, m.allergens, m.seasonFrom, m.seasonTo, m.soldFrom, m.soldUntil, i+1).i("id")
			for _, v := range m.variants {
				t.exec("INSERT INTO menu_variants (item_id, size, temperature, price_lumi) VALUES ($1, $2, $3, $4) "+
					"ON CONFLICT (item_id, size, temperature) DO UPDATE SET price_lumi = EXCLUDED.price_lumi", itemID, v.size, v.temperature, v.price)
			}
		}
		var openingAt *time.Time
		if opts.history { // 初期在庫の日付を、履歴の期間の前日にする（台帳の残量が、期間の初めから合うように）
			first := today.addDays(-(historyDays + 1))
			at := time.Date(first.y, time.Month(first.m), first.d, 12, 0, 0, 0, time.UTC)
			openingAt = &at
		}
		seedInventory(t, openingAt)
		seedStaff(t)
		seedDelivery(t)
		if opts.history {
			historyCounts = seedHistory(t, today, asOf)
		}
	})
	out := fmt.Sprintf("店 %d 件・メニュー %d 品・在庫の品目 %d 件・デモのスタッフ %d 人・宅配の区画 %d 件・配達員 %d 人を入れました",
		len(seedStores), len(seedMenu), len(seedStockItems), len(seedStores)+1, len(seedZones), len(seedCouriers))
	if opts.history {
		parts := make([]string, 0, len(historyCounts))
		for _, kv := range historyCounts {
			if kv.key != "analytics" {
				parts = append(parts, fmt.Sprintf("%s %d", kv.key, kv.val))
			}
		}
		out += "\nダミーの履歴（過去 90 日。すべてダミー）: " + strings.Join(parts, ", ")
	}
	return out, nil
}

type countKV struct {
	key string
	val int
}

var (
	beansG        = map[string]int{"S": 14, "M": 18, "L": 22}
	milkMl        = map[string]int{"S": 150, "M": 200, "L": 250}
	cappuccinoMl  = map[string]int{"S": 120, "M": 160, "L": 200}
	matchaG       = map[string]int{"S": 4, "M": 5, "L": 6}
	teaG          = map[string]int{"S": 3, "M": 4, "L": 5}
	cupFor        = map[string]string{"S": "cup-s", "M": "cup-m", "L": "cup-l"}
	sellableFoods = map[string]bool{"hot-sandwich": true, "meat-pie": true, "cheesecake": true, "gateau-chocolat": true}
)

type stockQty struct {
	code string
	qty  int
}

// recipeFor は変種 1 つ（ドリンク 1 杯・菓子 1 個など）の使用量 [(在庫品目の code, 量)]。ホットとアイスは同じ。
func recipeFor(itemCode, size string) []stockQty {
	switch itemCode {
	case "oasis-blend", "seasonal-blend", "kikan-limited", "americano":
		return []stockQty{{"coffee-beans", beansG[size]}, {cupFor[size], 1}}
	case "cafe-latte":
		return []stockQty{{"coffee-beans", beansG[size]}, {"milk", milkMl[size]}, {cupFor[size], 1}}
	case "cappuccino":
		return []stockQty{{"coffee-beans", beansG[size]}, {"milk", cappuccinoMl[size]}, {cupFor[size], 1}}
	case "matcha-latte":
		return []stockQty{{"matcha", matchaG[size]}, {"milk", milkMl[size]}, {cupFor[size], 1}}
	case "black-tea":
		return []stockQty{{"tea-leaves", teaG[size]}, {cupFor[size], 1}}
	case "morning-set":
		return []stockQty{{"coffee-beans", beansG["S"]}, {"cup-s", 1}, {"bread", 1}}
	case "beans-oasis":
		return []stockQty{{"beans-bag-oasis", 1}}
	case "beans-seasonal":
		return []stockQty{{"beans-bag-seasonal", 1}}
	}
	if sellableFoods[itemCode] {
		return []stockQty{{itemCode, 1}}
	}
	panic(fmt.Sprintf("レシピが未定義の品です: %s", itemCode))
}

func seedInventory(t *tx, openingAt *time.Time) {
	for _, s := range seedStockItems {
		t.exec("INSERT INTO stock_items (code, name, kind, unit, reorder_point, safety_stock) VALUES ($1, $2, $3, $4, $5, $6) "+
			"ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, unit = EXCLUDED.unit, "+
			"reorder_point = EXCLUDED.reorder_point, safety_stock = EXCLUDED.safety_stock", s.code, s.name, s.kind, s.unit, s.reorderPoint, s.safetyStock)
	}
	stockIDs := map[string]int{}
	for _, r := range t.all("SELECT code, id FROM stock_items") {
		stockIDs[r.s("code")] = r.i("id")
	}
	// レシピ: 全ての変種に必要（足りなければ、ここで止める。注文が「材料なしで通る」品を作らない）
	for _, v := range t.all("SELECT v.id, i.code, v.size FROM menu_variants v JOIN menu_items i ON i.id = v.item_id ORDER BY v.id") {
		lines := recipeFor(v.s("code"), v.s("size"))
		t.exec("DELETE FROM recipe_lines WHERE variant_id = $1", v.i("id"))
		for _, l := range lines {
			t.exec("INSERT INTO recipe_lines (variant_id, stock_item_id, qty) VALUES ($1, $2, $3)", v.i("id"), stockIDs[l.code], l.qty)
		}
	}
	// 残高: 無い店・品目だけ入れる（再実行しても、今の在庫を上書きしない）。台帳には、初期在庫の receive を同時に追記する（台帳と残高を合わせる）
	now := time.Now().UTC()
	if openingAt != nil {
		now = *openingAt
	}
	for _, st := range t.all("SELECT id, code, seats FROM stores ORDER BY id") {
		for _, s := range seedStockItems {
			qty, ok := seedLowStock[[2]string{st.s("code"), s.code}]
			if !ok {
				qty = int(math.Max(1, math.RoundToEven(float64(s.baseQty*st.i("seats"))/40)))
			}
			inserted := t.one("INSERT INTO stock_balances (store_id, item_id, on_hand, reserved, updated_at) VALUES ($1, $2, $3, 0, $4) ON CONFLICT (store_id, item_id) DO NOTHING RETURNING item_id",
				st.i("id"), stockIDs[s.code], qty, now)
			if inserted != nil {
				t.exec("INSERT INTO stock_movements (store_id, item_id, kind, qty, ref_type, reason, actor, occurred_at) VALUES ($1, $2, 'receive', $3, 'seed', $4, 'seed', $5)",
					st.i("id"), stockIDs[s.code], qty, "初期在庫（ダミー）", now)
			}
		}
	}
}

// seedStaff はデモのスタッフ（docs/api.md）: 各店 staff-<店の code>@oasis-cafe.example、店長（全店）manager@oasis-cafe.example。パスワードは DEMO_STAFF_PASSWORD。
func seedStaff(t *tx) {
	password := staffPassword()
	type account struct {
		email, name, role string
		storeCode         *string
	}
	var accounts []account
	for _, s := range seedStores {
		code := s.code
		accounts = append(accounts, account{"staff-" + s.code + "@oasis-cafe.example", s.name + "のスタッフ", "staff", &code})
	}
	accounts = append(accounts, account{"manager@oasis-cafe.example", "店長（全店）", "manager", nil})
	for _, a := range accounts {
		var storeID any
		if a.storeCode != nil {
			storeID = t.one("SELECT id FROM stores WHERE code = $1", *a.storeCode).i("id")
		}
		t.exec("INSERT INTO staff_accounts (store_id, role, name, email, password_hash, is_active) VALUES ($1, $2, $3, $4, $5, true) "+
			"ON CONFLICT (email) DO UPDATE SET store_id = EXCLUDED.store_id, role = EXCLUDED.role, name = EXCLUDED.name, "+
			"password_hash = EXCLUDED.password_hash, is_active = true", storeID, a.role, a.name, a.email, hashPassword(password))
	}
}

func courierEmail(storeCode string, n int) string {
	return fmt.Sprintf("courier-%s-%d@oasis-cafe.example", storeCode, n)
}

// deliveryNeighbor は隣接 1 エリア（居住区—発着場—岩山—遺跡の順の「次」。最後の遺跡だけ手前の岩山）。新設。
func deliveryNeighbor(area int) int {
	if area < len(seedZones) {
		return area + 1
	}
	return area - 1
}

// seedDelivery は区画・区画間の分・宅配をする店・配達員（courier ロールのデモのアカウント）・今日から 7 日先までの時間枠。
// 何度流しても同じ（今の is_suspended・勤務・枠の予約数は上書きしない）。
func seedDelivery(t *tx) {
	for _, z := range seedZones {
		t.exec("INSERT INTO delivery_zones (area_code, name, fee_lumi, free_over_lumi, min_order_lumi, base_minutes) VALUES ($1, $2, $3, $4, $5, $6) "+
			"ON CONFLICT (area_code) DO UPDATE SET name = EXCLUDED.name, fee_lumi = EXCLUDED.fee_lumi, free_over_lumi = EXCLUDED.free_over_lumi, "+
			"min_order_lumi = EXCLUDED.min_order_lumi, base_minutes = EXCLUDED.base_minutes", z.area, z.name, z.fee, z.freeOver, z.minOrder, z.baseMinutes)
	}
	zoneID := map[int]int{}
	for _, r := range t.all("SELECT area_code, id FROM delivery_zones") {
		zoneID[r.i("area_code")] = r.i("id")
	}
	for _, zt := range seedZoneTravel {
		a, b, minutes := zt[0], zt[1], zt[2]
		for _, pair := range [][2]int{{a, b}, {b, a}} {
			t.exec("INSERT INTO zone_travel_minutes (from_zone_id, to_zone_id, minutes) VALUES ($1, $2, $3) "+
				"ON CONFLICT (from_zone_id, to_zone_id) DO UPDATE SET minutes = EXCLUDED.minutes", zoneID[pair[0]], zoneID[pair[1]], minutes)
		}
	}
	// 宅配をする店 = 配達員がいる店。届ける区画は、店のエリア + 隣接 1 エリア
	type storeAt struct{ id, area int }
	storesByCode := map[string]storeAt{}
	for _, r := range t.all("SELECT code, id, area_code FROM stores") {
		storesByCode[r.s("code")] = storeAt{r.i("id"), r.i("area_code")}
	}
	var courierStores []string
	seen := map[string]bool{}
	for _, c := range seedCouriers {
		if !seen[c.storeCode] {
			seen[c.storeCode] = true
			courierStores = append(courierStores, c.storeCode)
		}
	}
	for _, code := range courierStores {
		st := storesByCode[code]
		for _, zoneArea := range []int{st.area, deliveryNeighbor(st.area)} {
			t.exec("INSERT INTO store_zones (store_id, zone_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", st.id, zoneID[zoneArea])
		}
	}
	password := staffPassword()
	counters := map[string]int{}
	for _, c := range seedCouriers {
		counters[c.storeCode]++
		storeID := storesByCode[c.storeCode].id
		staffID := t.one("INSERT INTO staff_accounts (store_id, role, name, email, password_hash, is_active) VALUES ($1, 'courier', $2, $3, $4, true) "+
			"ON CONFLICT (email) DO UPDATE SET store_id = EXCLUDED.store_id, role = EXCLUDED.role, name = EXCLUDED.name, "+
			"password_hash = EXCLUDED.password_hash, is_active = true RETURNING id", storeID, c.name, courierEmail(c.storeCode, counters[c.storeCode]), hashPassword(password)).i("id")
		t.exec("INSERT INTO couriers (staff_id, store_id) VALUES ($1, $2) ON CONFLICT (staff_id) DO UPDATE SET store_id = EXCLUDED.store_id", staffID, storeID)
	}
	today := dateOf(localNow())
	for _, code := range courierStores {
		store := t.one("SELECT id, open_time::text AS open_time, close_time::text AS close_time, closed_weekday, last_order_minutes FROM stores WHERE id = $1", storesByCode[code].id)
		ensureWindow(t, store, today)
	}
}

// seedMain は seed の CLI。
func seedMain(args []string) int {
	if msg := requireDemoDataAllowed(); msg != "" {
		fmt.Fprintln(os.Stderr, msg)
		return 1
	}
	has := func(flag string) bool {
		for _, a := range args {
			if a == flag {
				return true
			}
		}
		return false
	}
	url, err := safeDatabaseURL()
	if err != nil {
		fmt.Printf("失敗しました（RuntimeError）。%v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	pool, err := openPool(ctx, url, 2)
	cancel()
	if err != nil {
		fmt.Printf("失敗しました（%T）。DB への接続でエラーです\n", err)
		return 1
	}
	defer pool.Close()
	dbPool = pool
	var out string
	var serr error
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				if se, ok := rec.(settingsError); ok {
					serr = se
					return
				}
				serr = fmt.Errorf("失敗しました（%s）。SQL の実行でエラーです", panicKind(rec))
			}
		}()
		out, serr = seedDemo(seedOptions{reset: has("--reset"), history: has("--history")})
	}()
	if serr != nil {
		fmt.Fprintln(os.Stderr, serr)
		return 1
	}
	fmt.Println(out)
	return 0
}
