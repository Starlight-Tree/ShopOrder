package main

// カート（顧客）。価格はいつも今のメニューから計算し、カートには保存しない。変更のたびに version を上げる（backend/app/cart.py の移植）。
// カートの行のロック: 変更・確定は carts の行を FOR UPDATE で押さえてから行う（版の増加・行数の上限・提案の検査を、同じ利用者の並行リクエストでも崩さない）。

import (
	"time"
)

const pickupNote = "店頭でお渡しします"

type cartLine struct {
	variantID, itemID                     int
	itemCode, itemName, size, temperature string
	unitPriceLumi, qty                    int
	reason                                *string // nil なら出せる
}

func (l cartLine) lineTotal() int { return l.unitPriceLumi * l.qty }

func (l cartLine) public() cartLineOut {
	return cartLineOut{
		VariantID: l.variantID, ItemCode: l.itemCode, Name: l.itemName, Size: l.size, Temperature: l.temperature,
		UnitPriceLumi: l.unitPriceLumi, Qty: l.qty, LineTotalLumi: l.lineTotal(), Available: l.reason == nil, UnavailableReason: l.reason,
	}
}

func publicLines(lines []cartLine) []cartLineOut {
	out := make([]cartLineOut, 0, len(lines))
	for _, l := range lines {
		out = append(out, l.public())
	}
	return out
}

func getCart(t *tx, userID int, now time.Time, lock bool) row {
	sql := "SELECT id, store_id, fulfillment, version, address_id, slot_id FROM carts WHERE user_id = $1"
	if lock {
		sql += " FOR UPDATE"
	}
	rw := t.one(sql, userID)
	if rw == nil {
		t.exec("INSERT INTO carts (user_id, updated_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING", userID, now)
		rw = t.one(sql, userID)
	}
	return rw
}

// priceLines はカートの行を、今のメニューの価格と、季節・時間帯・（店が決まっていれば）在庫の状態で組み立てる。
func priceLines(t *tx, cart row, nowLocal time.Time) []cartLine {
	rows := t.all("SELECT ci.variant_id, ci.qty, v.size, v.temperature, v.price_lumi, i.id AS item_id, i.code AS item_code, i.name, "+
		"i.is_active, i.season_from, i.season_to, i.sold_from::text AS sold_from, i.sold_until::text AS sold_until "+
		"FROM cart_items ci JOIN menu_variants v ON v.id = ci.variant_id JOIN menu_items i ON i.id = v.item_id "+
		"WHERE ci.cart_id = $1 ORDER BY ci.added_at, ci.variant_id", cart.i("id"))
	var stock map[int][]stockPair
	if !cart.isNull("store_id") {
		ids := make([]int, len(rows))
		for i, r := range rows {
			ids[i] = r.i("variant_id")
		}
		stock = variantStock(t, cart.i("store_id"), ids)
	}
	lines := make([]cartLine, 0, len(rows))
	for _, r := range rows {
		reason := itemUnavailableReason(r, nowLocal)
		if reason == nil && !cart.isNull("store_id") && isSoldOut(stock[r.i("variant_id")], r.i("qty")) {
			reason = ptr("sold_out")
		}
		lines = append(lines, cartLine{
			variantID: r.i("variant_id"), itemID: r.i("item_id"), itemCode: r.s("item_code"), itemName: r.s("name"), size: r.s("size"),
			temperature: r.s("temperature"), unitPriceLumi: r.i("price_lumi"), qty: r.i("qty"), reason: reason,
		})
	}
	return lines
}

func subtotalOf(lines []cartLine) int {
	n := 0
	for _, l := range lines {
		n += l.lineTotal()
	}
	return n
}

func cartView(t *tx, cart row, lines []cartLine, now time.Time) cartOut {
	var store *storeRef
	if !cart.isNull("store_id") {
		if r := t.one("SELECT id, name FROM stores WHERE id = $1", cart.i("store_id")); r != nil {
			store = &storeRef{ID: r.i("id"), Name: r.s("name")}
		}
	}
	subtotal := subtotalOf(lines)
	out := cartOut{
		Version: cart.i("version"), Store: store, Fulfillment: cart.s("fulfillment"), Lines: publicLines(lines),
		SubtotalLumi: subtotal, DeliveryFeeLumi: 0, TotalLumi: subtotal,
	}
	if cart.s("fulfillment") == "delivery" { // 宅配（P2）: 送料と、選択の状態（issues）
		res := resolveDelivery(t, cart, subtotal, now)
		out.DeliveryFeeLumi = res.feeLumi
		out.TotalLumi = subtotal + res.feeLumi
		out.Delivery = cartDeliveryView(res)
	}
	return out
}

func bumpCart(t *tx, cartID int, now time.Time) {
	t.exec("UPDATE carts SET version = version + 1, updated_at = $1 WHERE id = $2", now, cartID)
}

func reloadCart(t *tx, userID int, now, nowLocal time.Time) cartOut {
	cart := getCart(t, userID, now, false)
	return cartView(t, cart, priceLines(t, cart, nowLocal), now)
}

func readCart(t *tx, userID int, now, nowLocal time.Time) cartOut {
	return reloadCart(t, userID, now, nowLocal)
}

// setCartStore は店と受け取り方法（と、宅配の住所・枠）を、全部置き換える。省略した addressID・slotID は nil。
func setCartStore(t *tx, userID int, storeID *int, fulfillment string, now, nowLocal time.Time, addressID, slotID *int) cartOut {
	hasDeliveryFields := addressID != nil || slotID != nil
	if fulfillment == "pickup" && hasDeliveryFields {
		fail(422, "pickup_with_delivery_fields")
	}
	if storeID != nil && loadStore(t, *storeID) == nil {
		fail(404, "store_not_found")
	}
	if fulfillment == "delivery" && storeID == nil && hasDeliveryFields {
		fail(422, "store_required")
	}
	if fulfillment == "delivery" && storeID != nil {
		// 住所の行ロック（FOR SHARE）を、カートのロックより先に取る（住所の削除は 住所 → カートの順。逆にしない）
		if addressID != nil && t.one("SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2", *addressID, userID) == nil {
			fail(404, "address_not_found")
		}
		validateSelection(t, *storeID, addressID, slotID, now)
	}
	cart := getCart(t, userID, now, true)
	t.exec("UPDATE carts SET store_id = $1, fulfillment = $2, address_id = $3, slot_id = $4 WHERE id = $5", storeID, fulfillment, addressID, slotID, cart.i("id"))
	bumpCart(t, cart.i("id"), now)
	return reloadCart(t, userID, now, nowLocal)
}

// setCartItem は絶対値指定。qty 0 で外す。1 注文の行は 30 まで。値が変わらないときは版を上げない（二重クリック・再送・チャットと画面の同じ指定で、確定の許可証が無効にならない）。
func setCartItem(t *tx, userID, variantID, qty int, now, nowLocal time.Time) cartOut {
	cart := getCart(t, userID, now, true)
	changed := true
	if qty == 0 {
		changed = t.one("DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2 RETURNING 1", cart.i("id"), variantID) != nil
	} else {
		if t.one("SELECT v.id FROM menu_variants v JOIN menu_items i ON i.id = v.item_id WHERE v.id = $1 AND i.is_active", variantID) == nil {
			fail(404, "variant_not_found")
		}
		current := t.one("SELECT qty FROM cart_items WHERE cart_id = $1 AND variant_id = $2", cart.i("id"), variantID)
		if current == nil {
			if t.one("SELECT count(*) AS n FROM cart_items WHERE cart_id = $1", cart.i("id")).i("n") >= maxLines {
				fail(422, "too_many_lines")
			}
		} else if current.i("qty") == qty {
			changed = false
		}
		if changed {
			t.exec("INSERT INTO cart_items (cart_id, variant_id, qty, added_at) VALUES ($1, $2, $3, $4) "+
				"ON CONFLICT (cart_id, variant_id) DO UPDATE SET qty = EXCLUDED.qty", cart.i("id"), variantID, qty, now)
		}
	}
	if changed {
		bumpCart(t, cart.i("id"), now)
	}
	return reloadCart(t, userID, now, nowLocal)
}

// clearCart はカートの品を空にする（受け取る店の選択は残す）。
func clearCart(t *tx, userID int, now, nowLocal time.Time) cartOut {
	cart := getCart(t, userID, now, true)
	t.exec("DELETE FROM cart_items WHERE cart_id = $1", cart.i("id"))
	bumpCart(t, cart.i("id"), now)
	return reloadCart(t, userID, now, nowLocal)
}

// ---- 確定の検証（提案の作成と、注文の確定が同じ検査を使う）----

// firstLineUsing は指定の在庫品目を使う、最初の行の品名。
func firstLineUsing(lines []cartLine, recipeMap map[int][]recipeLine, itemIDs map[int]bool) *string {
	for _, l := range lines {
		for _, rl := range recipeMap[l.variantID] {
			if itemIDs[rl.itemID] {
				n := l.itemName
				return &n
			}
		}
	}
	return nil
}

// validateCheckout は確定できる状態か検査し、合計を返す。できなければ 409（code つき）。checkStock は、確保の前の目安の検査（確保そのものが最終の判定）。
func validateCheckout(t *tx, cart row, lines []cartLine, nowLocal time.Time, checkStock bool) int {
	if len(lines) == 0 {
		fail(409, "cart_empty")
	}
	if cart.isNull("store_id") {
		fail(409, "store_not_selected")
	}
	store := loadStore(t, cart.i("store_id"))
	if reason := storeClosedReason(t, store, nowLocal); reason != nil {
		fail(409, "store_closed", kv{"closed_reason", *reason})
	}
	var unavailable []int
	for _, l := range lines {
		if l.reason != nil && (*l.reason == "out_of_season" || *l.reason == "out_of_hours") {
			unavailable = append(unavailable, l.variantID)
		}
	}
	if len(unavailable) > 0 {
		fail(409, "item_unavailable", kv{"variant_ids", unavailable})
	}
	total := subtotalOf(lines)
	if total > maxTotalLumi {
		fail(409, "over_limit")
	}
	subtotal := total
	if checkStock {
		ids := make([]int, len(lines))
		ol := make([]orderLine, len(lines))
		for i, l := range lines {
			ids[i] = l.variantID
			ol[i] = orderLine{l.variantID, l.qty}
		}
		recipeMap := recipes(t, ids)
		need := requirements(ol, recipeMap)
		keys := make([]int, 0, len(need))
		for k := range need {
			keys = append(keys, k)
		}
		available := availableByItem(t, cart.i("store_id"), keys)
		short := map[int]bool{}
		for itemID, n := range need {
			if a, ok := available[itemID]; !ok || a < n {
				short[itemID] = true
			}
		}
		if len(short) > 0 {
			fail(409, "sold_out", kv{"item_name", firstLineUsing(lines, recipeMap, short)})
		}
	}
	if cart.s("fulfillment") == "delivery" { // 宅配（P2）: 住所・区画・砂嵐・最低注文額・枠を検査し、送料を足す（通らなければ 409）
		total = subtotal + quoteForCart(t, cart, subtotal, utcNow()).feeLumi
	}
	return total
}

func createProposal(t *tx, userID int, now, nowLocal time.Time) proposalOut {
	cart := getCart(t, userID, now, true)
	lines := priceLines(t, cart, nowLocal)
	total := validateCheckout(t, cart, lines, nowLocal, true)
	expiresAt := now.Add(proposalTTL)
	proposalID := t.one("INSERT INTO checkout_proposals (cart_id, cart_version, total_lumi, expires_at, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
		cart.i("id"), cart.i("version"), total, expiresAt, now).s("id")
	store := t.one("SELECT id, name FROM stores WHERE id = $1", cart.i("store_id"))
	subtotal := subtotalOf(lines)
	delivering := cart.s("fulfillment") == "delivery"
	out := proposalOut{
		ID: proposalID, CartVersion: cart.i("version"), TotalLumi: total, ExpiresAt: isoTime(expiresAt),
		Store: storeRef{ID: store.i("id"), Name: store.s("name")}, Lines: publicLines(lines),
		Fulfillment: cart.s("fulfillment"), SubtotalLumi: subtotal, DeliveryFeeLumi: total - subtotal,
	}
	if delivering {
		out.Delivery = cartDeliveryView(resolveDelivery(t, cart, subtotal, now))
	} else {
		out.PickupNote = ptr(pickupNote)
	}
	return out
}
