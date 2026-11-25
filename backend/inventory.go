package main

// 在庫: 台帳（stock_movements。追記のみ）+ 残高（stock_balances）。docs/decisions/0004（backend/app/inventory.py の移植）。
//   - 残高の更新と台帳の追記は、呼ぶ側のトランザクションの中で行う（途中で失敗すれば両方戻る）。ここでは commit しない
//   - 確保（reserve）は、品目 ID の昇順に、1 文の条件付き UPDATE（available = on_hand - reserved - safety_stock >= n）。0 行なら不足
//   - 台帳の符号つきの数量: reserve +n / release -n / consume -n（on_hand と reserved の両方）/ receive +n / waste -n / adjust ±n

import (
	"sort"
	"time"
)

// insufficientStock は確保・廃棄・調整ができない（在庫が足りない）。itemID は足りなかった品目。
type insufficientStock struct{ itemID int }

type recipeLine struct{ itemID, perUnit int }

type stockPair struct{ perUnit, available int }

func movement(t *tx, storeID, itemID int, kind string, qty int, refType, refID, reason *string, actor string, now time.Time) {
	t.exec("INSERT INTO stock_movements (store_id, item_id, kind, qty, ref_type, ref_id, reason, actor, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		storeID, itemID, kind, qty, refType, refID, reason, actor, now)
}

func sortedUnique(ids []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, i := range ids {
		if !seen[i] {
			seen[i] = true
			out = append(out, i)
		}
	}
	sort.Ints(out)
	return out
}

// recipes は変種 ID → [(品目 ID, 1 つあたりの量)]。レシピの無い変種は空のリスト。
func recipes(t *tx, variantIDs []int) map[int][]recipeLine {
	ids := sortedUnique(variantIDs)
	result := map[int][]recipeLine{}
	for _, v := range ids {
		result[v] = nil
	}
	if len(ids) > 0 {
		for _, r := range t.all("SELECT variant_id, stock_item_id, qty FROM recipe_lines WHERE variant_id = ANY($1) ORDER BY variant_id, stock_item_id", ids) {
			result[r.i("variant_id")] = append(result[r.i("variant_id")], recipeLine{r.i("stock_item_id"), r.i("qty")})
		}
	}
	return result
}

type orderLine struct{ variantID, qty int }

// requirements は注文の行 × レシピ → 品目 ID ごとの必要量の合計。
func requirements(lines []orderLine, recipeMap map[int][]recipeLine) map[int]int {
	need := map[int]int{}
	for _, l := range lines {
		for _, rl := range recipeMap[l.variantID] {
			need[rl.itemID] += rl.perUnit * l.qty
		}
	}
	return need
}

// availableByItem は品目 ID → 今出せる量（on_hand - reserved - safety_stock。残高の行が無ければ 0 から安全在庫を引いた値）。
func availableByItem(t *tx, storeID int, itemIDs []int) map[int]int {
	ids := sortedUnique(itemIDs)
	out := map[int]int{}
	if len(ids) == 0 {
		return out
	}
	for _, r := range t.all("SELECT i.id AS item_id, COALESCE(b.on_hand - b.reserved, 0) - i.safety_stock AS available "+
		"FROM stock_items i LEFT JOIN stock_balances b ON b.item_id = i.id AND b.store_id = $1 WHERE i.id = ANY($2)", storeID, ids) {
		out[r.i("item_id")] = r.i("available")
	}
	return out
}

// variantStock は変種 ID → [(1 つあたりの量, 今出せる量)]。メニュー・カートの「売り切れ」の表示に使う（確保はしない）。
func variantStock(t *tx, storeID int, variantIDs []int) map[int][]stockPair {
	ids := sortedUnique(variantIDs)
	result := map[int][]stockPair{}
	for _, v := range ids {
		result[v] = nil
	}
	if len(ids) > 0 {
		for _, r := range t.all("SELECT r.variant_id, r.qty AS per_unit, COALESCE(b.on_hand - b.reserved, 0) - i.safety_stock AS available "+
			"FROM recipe_lines r JOIN stock_items i ON i.id = r.stock_item_id "+
			"LEFT JOIN stock_balances b ON b.item_id = r.stock_item_id AND b.store_id = $1 WHERE r.variant_id = ANY($2)", storeID, ids) {
			result[r.i("variant_id")] = append(result[r.i("variant_id")], stockPair{r.i("per_unit"), r.i("available")})
		}
	}
	return result
}

func isSoldOut(stock []stockPair, qty int) bool {
	for _, p := range stock {
		if p.available < p.perUnit*qty {
			return true
		}
	}
	return false
}

func sortedKeys(m map[int]int) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}

// reserveStock は品目 ID の昇順に条件付き UPDATE。足りなければ *insufficientStock（呼ぶ側がトランザクションごと戻す）。
func reserveStock(t *tx, storeID int, need map[int]int, refType, refID, actor string, now time.Time) *insufficientStock {
	for _, itemID := range sortedKeys(need) {
		n := need[itemID]
		cur := t.exec("UPDATE stock_balances AS b SET reserved = b.reserved + $1, updated_at = $2 FROM stock_items AS i "+
			"WHERE b.store_id = $3 AND b.item_id = $4 AND i.id = b.item_id AND b.on_hand - b.reserved - i.safety_stock >= $5", n, now, storeID, itemID, n)
		if cur != 1 {
			return &insufficientStock{itemID}
		}
		movement(t, storeID, itemID, "reserve", n, &refType, &refID, nil, actor, now)
	}
	return nil
}

func releaseStock(t *tx, storeID int, need map[int]int, refType, refID, reason, actor string, now time.Time) {
	for _, itemID := range sortedKeys(need) {
		n := need[itemID]
		if t.exec("UPDATE stock_balances SET reserved = reserved - $1, updated_at = $2 WHERE store_id = $3 AND item_id = $4", n, now, storeID, itemID) != 1 {
			panic("確保した残高の行がありません")
		}
		movement(t, storeID, itemID, "release", -n, &refType, &refID, &reason, actor, now)
	}
}

// consumeStock は確保した分を消費に変える（on_hand と reserved の両方から引く）。
func consumeStock(t *tx, storeID int, need map[int]int, refType, refID, actor string, now time.Time) {
	for _, itemID := range sortedKeys(need) {
		n := need[itemID]
		if t.exec("UPDATE stock_balances SET on_hand = on_hand - $1, reserved = reserved - $2, updated_at = $3 WHERE store_id = $4 AND item_id = $5", n, n, now, storeID, itemID) != 1 {
			panic("確保した残高の行がありません")
		}
		movement(t, storeID, itemID, "consume", -n, &refType, &refID, nil, actor, now)
	}
}

// ---- スタッフの操作（入荷・廃棄・棚卸し）----

func receiveStock(t *tx, storeID, itemID, qty int, reason *string, actor string, now time.Time) {
	t.exec("INSERT INTO stock_balances (store_id, item_id, on_hand, reserved, updated_at) VALUES ($1, $2, $3, 0, $4) "+
		"ON CONFLICT (store_id, item_id) DO UPDATE SET on_hand = stock_balances.on_hand + EXCLUDED.on_hand, updated_at = EXCLUDED.updated_at", storeID, itemID, qty, now)
	movement(t, storeID, itemID, "receive", qty, ptr("manual"), nil, reason, actor, now)
}

// wasteStock は廃棄。確保中の分は捨てられない（on_hand - reserved >= qty）。
func wasteStock(t *tx, storeID, itemID, qty int, reason, actor string, now time.Time) *insufficientStock {
	if t.exec("UPDATE stock_balances SET on_hand = on_hand - $1, updated_at = $2 WHERE store_id = $3 AND item_id = $4 AND on_hand - reserved >= $5", qty, now, storeID, itemID, qty) != 1 {
		return &insufficientStock{itemID}
	}
	movement(t, storeID, itemID, "waste", -qty, ptr("manual"), nil, &reason, actor, now)
	return nil
}

// adjustStock は棚卸しの差異を、調整の行として足す（履歴は書き換えない）。確保中の分を下回る調整はできない。
func adjustStock(t *tx, storeID, itemID, delta int, reason, actor string, now time.Time) *insufficientStock {
	if delta > 0 {
		t.exec("INSERT INTO stock_balances (store_id, item_id, on_hand, reserved, updated_at) VALUES ($1, $2, 0, 0, $3) ON CONFLICT (store_id, item_id) DO NOTHING", storeID, itemID, now)
	}
	if t.exec("UPDATE stock_balances SET on_hand = on_hand + $1, updated_at = $2 WHERE store_id = $3 AND item_id = $4 AND on_hand + $5 >= reserved", delta, now, storeID, itemID, delta) != 1 {
		return &insufficientStock{itemID}
	}
	movement(t, storeID, itemID, "adjust", delta, ptr("manual"), nil, &reason, actor, now)
	return nil
}

func stockItemExists(t *tx, itemID int) bool {
	return t.one("SELECT 1 FROM stock_items WHERE id = $1", itemID) != nil
}

func stockRowFor(t *tx, storeID, itemID int) *stockRowOut {
	rows := listStock(t, storeID, &itemID)
	if len(rows) == 0 {
		return nil
	}
	return &rows[0]
}

// listStock は店の在庫の一覧（残高の行が無い品目は 0）。available = on_hand - reserved - safety_stock、low = available < reorder_point。
func listStock(t *tx, storeID int, itemID *int) []stockRowOut {
	var item any
	if itemID != nil {
		item = *itemID
	}
	rows := t.all("SELECT i.id AS item_id, i.code, i.name, i.kind, i.unit, COALESCE(b.on_hand, 0) AS on_hand, COALESCE(b.reserved, 0) AS reserved, "+
		"i.safety_stock, i.reorder_point FROM stock_items i LEFT JOIN stock_balances b ON b.item_id = i.id AND b.store_id = $1 "+
		"WHERE ($2::int IS NULL OR i.id = $2::int) ORDER BY i.kind, i.id", storeID, item)
	out := []stockRowOut{}
	for _, r := range rows {
		available := r.i("on_hand") - r.i("reserved") - r.i("safety_stock")
		out = append(out, stockRowOut{
			ItemID: r.i("item_id"), Code: r.s("code"), Name: r.s("name"), Kind: r.s("kind"), Unit: r.s("unit"),
			OnHand: r.i("on_hand"), Reserved: r.i("reserved"), Available: available,
			ReorderPoint: r.i("reorder_point"), Low: available < r.i("reorder_point"),
		})
	}
	return out
}

// reconcile は台帳から再計算した on_hand・reserved と、残高の食い違い（夜間の照合の本体）。食い違いが無ければ空。
func reconcileStock(t *tx) []row {
	return t.all("WITH led AS (SELECT store_id, item_id, " +
		"COALESCE(SUM(qty) FILTER (WHERE kind IN ('receive', 'consume', 'waste', 'adjust')), 0) AS on_hand, " +
		"COALESCE(SUM(qty) FILTER (WHERE kind IN ('reserve', 'release', 'consume')), 0) AS reserved " +
		"FROM stock_movements GROUP BY store_id, item_id) " +
		"SELECT COALESCE(b.store_id, l.store_id) AS store_id, COALESCE(b.item_id, l.item_id) AS item_id, " +
		"b.on_hand AS balance_on_hand, b.reserved AS balance_reserved, l.on_hand AS ledger_on_hand, l.reserved AS ledger_reserved " +
		"FROM stock_balances b FULL JOIN led l ON l.store_id = b.store_id AND l.item_id = b.item_id " +
		"WHERE COALESCE(b.on_hand, 0) <> COALESCE(l.on_hand, 0) OR COALESCE(b.reserved, 0) <> COALESCE(l.reserved, 0) " +
		"ORDER BY 1, 2")
}
