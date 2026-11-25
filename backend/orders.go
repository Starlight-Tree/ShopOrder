package main

// 注文の確定・支払い・取消し・スタッフの状態遷移・期限切れの戻し（docs/order-flow.md。backend/app/orders.py の移植）。
//
// トランザクションは、1 回の操作に 1 つ（途中で失敗すれば、在庫・台帳・冪等キーも全部戻る）。ただし、支払いの拒否・期限切れは
// 「取消しを commit してから、エラーで答える」（注文を cancelled にして確保を戻した結果を残すため）。
// ロックの順（デッドロックを避ける）: 冪等キー → カート → 在庫の残高（品目 ID の昇順）→ 受け取り番号の採番。
// 既にある注文を触る操作は、注文の行 → 確保 → 在庫の残高（品目 ID の昇順）。期限切れの戻しは 1 注文ごとに別のトランザクション。
// デッドロック（40P01）・直列化失敗（40001）は、確定だけ数回やり直す。ログには、住所・注文の中身・金額を出さない。

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"sort"
	"strings"
	"time"
)

type transitionKey struct{ from, to string }

// transitions は状態遷移の表（1 か所）。(from, to) → 許す actor_type。表に無い遷移は 409。
var transitions = map[transitionKey][]string{
	{"placed", "paid"}:         {"system"},
	{"placed", "cancelled"}:    {"customer", "system"},
	{"paid", "accepted"}:       {"staff"},
	{"paid", "cancelled"}:      {"customer", "staff"},
	{"accepted", "preparing"}:  {"staff"},
	{"accepted", "cancelled"}:  {"staff"},
	{"preparing", "ready"}:     {"staff"},
	{"preparing", "cancelled"}: {"staff"},
	{"ready", "completed"}:     {"staff"},
	{"ready", "cancelled"}:     {"staff"},
	// 宅配（P2）
	{"ready", "assigned"}:             {"staff", "system"},
	{"assigned", "picked_up"}:         {"staff", "system"},
	{"picked_up", "delivering"}:       {"staff", "system"},
	{"delivering", "delivered"}:       {"staff", "system"},
	{"delivered", "completed"}:        {"system"},
	{"delivering", "delivery_failed"}: {"staff", "system"},
	{"delivery_failed", "ready"}:      {"staff"},
	{"delivery_failed", "cancelled"}:  {"staff"},
	{"assigned", "cancelled"}:         {"staff"},
}

type staffAction struct{ from, to string }

// staffActions はスタッフの操作 → (今の状態, 次の状態)。cancel は「どの状態からでも cancelled へ」（表が許す状態だけ通る）。
var staffActions = map[string]staffAction{
	"accept":   {"paid", "accepted"},
	"start":    {"accepted", "preparing"},
	"ready":    {"preparing", "ready"},
	"complete": {"ready", "completed"},
}

var staffActionOrder = []string{"accept", "start", "ready", "complete"}

var allStatuses = []string{"placed", "paid", "accepted", "preparing", "ready", "assigned", "picked_up", "delivering", "delivered", "delivery_failed", "completed", "cancelled"}

// staffVisibleStatuses はスタッフが一覧で指定できる状態（P1 の店頭）。placed（支払い前）は店が見ない。
var staffVisibleStatuses = []string{"paid", "accepted", "preparing", "ready", "completed", "cancelled"}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

const publicIDAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 紛らわしい I・O・0・1 を除く

func checkTransition(from, to, actor, code string) {
	if !contains(transitions[transitionKey{from, to}], actor) {
		fail(409, code)
	}
}

// staffAllowedActions は店のスタッフが、その注文にできる操作。宅配は complete が無く（配達員が完了する）、assign / redeliver が足される。
func staffAllowedActions(status, fulfillment string) []string {
	actions := []string{}
	for _, name := range staffActionOrder {
		a := staffActions[name]
		if a.from == status && contains(transitions[transitionKey{a.from, a.to}], "staff") && !(fulfillment == "delivery" && name == "complete") {
			actions = append(actions, name)
		}
	}
	if fulfillment == "delivery" {
		if status == "ready" || status == "assigned" {
			actions = append(actions, "assign")
		}
		if status == "delivery_failed" {
			actions = append(actions, "redeliver")
		}
	}
	if contains(transitions[transitionKey{status, "cancelled"}], "staff") {
		actions = append(actions, "cancel")
	}
	return actions
}

func newPublicID() string {
	b := make([]byte, 8)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(publicIDAlphabet))))
		if err != nil {
			panic("乱数を読めません")
		}
		b[i] = publicIDAlphabet[n.Int64()]
	}
	return string(b)
}

// ---- 読み取り（注文の形に組み立てる）----

const orderSelect = "SELECT o.id, o.public_id, o.user_id, o.store_id, o.status, o.fulfillment, o.pickup_no, o.subtotal_lumi, o.delivery_fee_lumi, o.total_lumi, " +
	"o.placed_at, o.cancel_reason, s.name AS store_name, r.status AS reservation_status, r.expires_at AS reservation_expires_at, " +
	"p.provider AS payment_provider, p.status AS payment_status " +
	"FROM orders o JOIN stores s ON s.id = o.store_id LEFT JOIN stock_reservations r ON r.order_id = o.id LEFT JOIN payments p ON p.order_id = o.id "

// numberQuestionMarks は SQL の ? を $1, $2, … にする（条件を組み立てるときの便宜。? を使う演算子は、このアプリの SQL に無い）。
func numberQuestionMarks(sql string) string {
	var b strings.Builder
	n := 0
	for i := 0; i < len(sql); i++ {
		if sql[i] == '?' {
			n++
			b.WriteString("$")
			b.WriteString(itoa(n))
			continue
		}
		b.WriteByte(sql[i])
	}
	return b.String()
}

func itoa(n int) string { return big.NewInt(int64(n)).String() }

// fetchOrders は where（? のパラメーター）・orderBy は、このファイルの固定の文字列だけ（値は params で渡す）。
func fetchOrders(t *tx, where string, params []any, orderBy string, limit int) []row {
	sql := orderSelect + "WHERE " + where + " ORDER BY " + orderBy + " LIMIT ?"
	return t.all(numberQuestionMarks(sql), append(append([]any{}, params...), limit)...)
}

type orderParts struct {
	items  map[int][]orderItemOut
	events map[int][]orderEventOut
}

func loadOrderParts(t *tx, rows []row, staff bool) orderParts {
	ids := make([]int, len(rows))
	p := orderParts{items: map[int][]orderItemOut{}, events: map[int][]orderEventOut{}}
	for i, r := range rows {
		ids[i] = r.i("id")
		p.items[ids[i]] = []orderItemOut{}
		p.events[ids[i]] = []orderEventOut{}
	}
	if len(ids) == 0 {
		return p
	}
	for _, it := range t.all("SELECT order_id, name, size, temperature, unit_price_lumi, qty, line_total_lumi FROM order_items WHERE order_id = ANY($1) ORDER BY id", ids) {
		p.items[it.i("order_id")] = append(p.items[it.i("order_id")], orderItemOut{
			Name: it.s("name"), Size: it.s("size"), Temperature: it.s("temperature"), UnitPriceLumi: it.i("unit_price_lumi"), Qty: it.i("qty"), LineTotalLumi: it.i("line_total_lumi"),
		})
	}
	for _, ev := range t.all("SELECT order_id, to_status, at, actor_type, reason FROM order_events WHERE order_id = ANY($1) ORDER BY id", ids) {
		reason := ev.sN("reason")
		if !staff && reason != nil && strings.HasPrefix(*reason, "courier:") {
			reason = nil // 配達員の内部 ID は顧客へ返さない（docs/api.md「courier は名前だけ」）
		}
		p.events[ev.i("order_id")] = append(p.events[ev.i("order_id")], orderEventOut{
			ToStatus: ev.s("to_status"), At: isoTime(ev.t("at")), ActorType: ev.s("actor_type"), Reason: reason,
		})
	}
	return p
}

func deliveryOrderIDs(rows []row) []int {
	var ids []int
	for _, r := range rows {
		if r.s("fulfillment") == "delivery" {
			ids = append(ids, r.i("id"))
		}
	}
	return ids
}

func reservationExpiry(r row) *time.Time {
	if r.s("status") == "placed" {
		return r.tN("reservation_expires_at")
	}
	return nil
}

func assembleCustomerOrders(t *tx, rows []row, now time.Time) []orderOut {
	parts := loadOrderParts(t, rows, false)
	deliveries := customerDeliveryViews(t, deliveryOrderIDs(rows), now)
	out := make([]orderOut, 0, len(rows))
	for _, r := range rows {
		id := r.i("id")
		expires := reservationExpiry(r)
		o := orderOut{
			PublicID: r.s("public_id"), PickupNo: r.i("pickup_no"), Status: r.s("status"), Fulfillment: r.s("fulfillment"),
			Store: storeRef{ID: r.i("store_id"), Name: r.s("store_name")}, Items: parts.items[id],
			SubtotalLumi: r.i("subtotal_lumi"), DeliveryFeeLumi: r.i("delivery_fee_lumi"), TotalLumi: r.i("total_lumi"),
			PlacedAt: isoTime(r.t("placed_at")), ReservationExpiresAt: isoTimePtr(expires),
			Events: parts.events[id], CancelReason: r.sN("cancel_reason"), Delivery: deliveries[id],
		}
		if !r.isNull("payment_provider") {
			o.Payment = &paymentInfo{Provider: r.s("payment_provider"), Status: r.s("payment_status")}
		}
		o.CanPay = r.s("status") == "placed" && (expires == nil || expires.After(now))
		o.CanCancel = r.s("status") == "placed" || r.s("status") == "paid"
		out = append(out, o)
	}
	return out
}

func assembleStaffOrders(t *tx, rows []row, now time.Time) []staffOrderOut {
	parts := loadOrderParts(t, rows, true)
	deliveries := staffDeliveryViews(t, deliveryOrderIDs(rows), now)
	out := make([]staffOrderOut, 0, len(rows))
	for _, r := range rows {
		id := r.i("id")
		expires := reservationExpiry(r)
		actions := staffAllowedActions(r.s("status"), r.s("fulfillment"))
		out = append(out, staffOrderOut{
			PublicID: r.s("public_id"), PickupNo: r.i("pickup_no"), Status: r.s("status"), Fulfillment: r.s("fulfillment"),
			Store: storeRef{ID: r.i("store_id"), Name: r.s("store_name")}, Items: parts.items[id],
			SubtotalLumi: r.i("subtotal_lumi"), DeliveryFeeLumi: r.i("delivery_fee_lumi"), TotalLumi: r.i("total_lumi"),
			PlacedAt: isoTime(r.t("placed_at")), ReservationExpiresAt: isoTimePtr(expires),
			Events: parts.events[id], CancelReason: r.sN("cancel_reason"),
			CanPay: false, CanCancel: contains(actions, "cancel"), AllowedActions: actions, Delivery: deliveries[id],
		})
	}
	return out
}

func oneCustomerOrder(t *tx, where string, params []any, now time.Time) orderOut {
	rows := fetchOrders(t, where, params, "o.id", 1)
	if len(rows) == 0 {
		fail(404, "not_found")
	}
	return assembleCustomerOrders(t, rows, now)[0]
}

func oneStaffOrder(t *tx, where string, params []any, now time.Time) staffOrderOut {
	rows := fetchOrders(t, where, params, "o.id", 1)
	if len(rows) == 0 {
		fail(404, "not_found")
	}
	return assembleStaffOrders(t, rows, now)[0]
}

func orderScope(staffStoreID *int) (string, []any) {
	if staffStoreID != nil {
		return "o.store_id = ?", []any{*staffStoreID}
	}
	return "true", nil
}

func listOrdersForCustomer(customerID int) []orderSummaryOut {
	expireStale()
	rows := inTx(func(t *tx) []row {
		return fetchOrders(t, "o.user_id = ?", []any{customerID}, "o.placed_at DESC, o.id DESC", customerOrderListLimit)
	})
	out := make([]orderSummaryOut, 0, len(rows))
	for _, r := range rows {
		out = append(out, orderSummaryOut{
			PublicID: r.s("public_id"), PickupNo: r.i("pickup_no"), Status: r.s("status"), Fulfillment: r.s("fulfillment"),
			Store: storeRef{ID: r.i("store_id"), Name: r.s("store_name")}, TotalLumi: r.i("total_lumi"), PlacedAt: isoTime(r.t("placed_at")),
		})
	}
	return out
}

func getOrderForCustomer(customerID int, publicID string) orderOut {
	expireStale()
	return inTx(func(t *tx) orderOut {
		return oneCustomerOrder(t, "o.user_id = ? AND o.public_id = ?", []any{customerID, publicID}, utcNow())
	})
}

func listOrdersForStaff(storeID *int, statuses []string) []staffOrderOut {
	expireStale()
	now := utcNow()
	where, params := orderScope(storeID)
	return inTx(func(t *tx) []staffOrderOut {
		rows := fetchOrders(t, where+" AND o.status = ANY(?)", append(params, statuses), "o.placed_at, o.id", staffOrderListLimit)
		return assembleStaffOrders(t, rows, now)
	})
}

// ---- 書き込みの共通部品 ----

func orderEvent(t *tx, orderID int, from *string, to, actorType string, actorID *string, reason *string, now time.Time) {
	t.exec("INSERT INTO order_events (order_id, from_status, to_status, actor_type, actor_id, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
		orderID, from, to, actorType, actorID, reason, now)
}

// lockOrder は注文の行を FOR UPDATE で押さえる。他人の注文・他店の注文は 404（存在を教えない）。
func lockOrder(t *tx, publicID string, userID, storeID *int) row {
	sql := "SELECT id, public_id, user_id, store_id, status, fulfillment, total_lumi, cancel_reason FROM orders WHERE public_id = $1"
	params := []any{publicID}
	if userID != nil {
		params = append(params, *userID)
		sql += " AND user_id = $" + itoa(len(params))
	}
	if storeID != nil {
		params = append(params, *storeID)
		sql += " AND store_id = $" + itoa(len(params))
	}
	r := t.one(sql+" FOR UPDATE", params...)
	if r == nil {
		fail(404, "not_found")
	}
	return r
}

func reservationLines(t *tx, reservationID int) map[int]int {
	out := map[int]int{}
	for _, r := range t.all("SELECT item_id, qty FROM stock_reservation_lines WHERE reservation_id = $1 ORDER BY item_id", reservationID) {
		out[r.i("item_id")] = r.i("qty")
	}
	return out
}

// cancelOrder は取消し: 確保が held なら戻す。支払い済みなら返金。準備後（確保が consumed）は何も戻さない。注文の行は呼ぶ側が FOR UPDATE 済み。
func cancelOrder(t *tx, order row, actorType string, actorID *string, reason, reservationFinal string, now time.Time) {
	code := "invalid_transition"
	if actorType == "customer" {
		code = "not_cancellable"
	}
	checkTransition(order.s("status"), "cancelled", actorType, code)
	res := t.one("SELECT id, status FROM stock_reservations WHERE order_id = $1 FOR UPDATE", order.i("id"))
	if res != nil && res.s("status") == "held" {
		actor := actorType
		if actorID != nil && *actorID != "" {
			actor = actorType + ":" + *actorID
		}
		releaseStock(t, order.i("store_id"), reservationLines(t, res.i("id")), "order", order.s("public_id"), reason, actor, now)
		t.exec("UPDATE stock_reservations SET status = $1, expires_at = NULL, updated_at = $2 WHERE id = $3", reservationFinal, now, res.i("id"))
	}
	pay := t.one("SELECT id, status, provider_ref, amount_lumi FROM payments WHERE order_id = $1 FOR UPDATE", order.i("id"))
	if pay != nil {
		switch pay.s("status") {
		case "paid":
			if !getPaymentProvider().refund(pay.sN("provider_ref"), pay.i("amount_lumi")) {
				panic("返金に失敗しました")
			}
			t.exec("UPDATE payments SET status = 'refunded', updated_at = $1 WHERE id = $2", now, pay.i("id"))
		case "pending":
			t.exec("UPDATE payments SET status = 'failed', updated_at = $1 WHERE id = $2", now, pay.i("id"))
		}
	}
	if order.s("fulfillment") == "delivery" {
		cancelDelivery(t, order.i("id")) // 枠を戻して配達を cancelled に（在庫の後。ロックの順は delivery.go の冒頭）
	}
	t.exec("UPDATE orders SET status = 'cancelled', cancelled_at = $1, cancel_reason = $2 WHERE id = $3", now, reason, order.i("id"))
	from := order.s("status")
	orderEvent(t, order.i("id"), &from, "cancelled", actorType, actorID, &reason, now)
}

// ---- 期限切れの戻し（worker が 30 秒ごと。読み取り・確定・スタッフの一覧の前にも、遅延で呼ぶ）----

// expireOne は 1 件を 1 つのトランザクションで戻す（件数 1 or 0）。ほかの操作と待ち合っても、ロックを持つ範囲は 1 注文だけ。
func expireOne(publicID string) int {
	now := utcNow()
	return inTx(func(t *tx) int {
		order := t.one("SELECT o.id, o.public_id, o.user_id, o.store_id, o.status, o.fulfillment, o.total_lumi FROM orders o JOIN stock_reservations r ON r.order_id = o.id "+
			"WHERE o.public_id = $1 AND o.status = 'placed' AND r.status = 'held' AND r.expires_at IS NOT NULL AND r.expires_at <= $2 "+
			"FOR UPDATE OF o SKIP LOCKED", publicID, now)
		if order == nil {
			return 0 // 既に戻された・支払われた・ほかが処理中
		}
		cancelOrder(t, order, "system", nil, "payment_timeout", "expired", now)
		return 1
	})
}

// expireStale は placed のまま確保の期限を過ぎた注文を cancelled（payment_timeout・actor は system）にして確保を戻す。戻した件数を返す。
// 1 注文ごとに別のトランザクションで処理する。呼び出し元を止めないよう、失敗は panic にせず、種類だけをログに残す（次の巡回・次の呼び出しでやり直す）。
func expireStale() (count int) {
	defer func() {
		if rec := recover(); rec != nil {
			logf("期限切れの戻しに失敗しました（%s）", panicKind(rec))
		}
	}()
	now := utcNow()
	ids := inTx(func(t *tx) []string {
		var out []string
		for _, r := range t.all("SELECT o.public_id FROM orders o JOIN stock_reservations r ON r.order_id = o.id "+
			"WHERE o.status = 'placed' AND r.status = 'held' AND r.expires_at IS NOT NULL AND r.expires_at <= $1 ORDER BY r.expires_at LIMIT $2", now, expireBatch) {
			out = append(out, r.s("public_id"))
		}
		return out
	})
	for _, id := range ids {
		pid := id
		count += withRetry(func() int { return expireOne(pid) })
	}
	if count > 0 {
		logf("支払い期限切れの注文を %d 件、取り消して確保を戻しました", count)
	}
	return count
}

// ---- 注文の確定 ----

// placeOrder は (注文, 新しく作ったか)。同じキー・同じ本文の再送は、同じ注文を返す（created=false）。
func placeOrder(customerID int, key, proposalID string) (orderOut, bool) {
	expireStale()
	sum := sha256.Sum256([]byte("POST /api/orders " + proposalID))
	requestHash := hex.EncodeToString(sum[:])
	type result struct {
		order   orderOut
		created bool
	}
	r := withRetry(func() result {
		o, c := placeOrderOnce(customerID, key, requestHash, proposalID)
		return result{o, c}
	})
	return r.order, r.created
}

func placeOrderOnce(customerID int, key, requestHash, proposalID string) (orderOut, bool) {
	now := utcNow()
	local := localNow()
	var order orderOut
	var created bool
	withTx(func(t *tx) {
		// 1. 冪等キー。先に INSERT ... ON CONFLICT DO NOTHING で取る（同じキーの並行リクエストは、先の commit まで待つ）
		taken := t.one("INSERT INTO idempotency_keys (user_id, key, request_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, key) DO NOTHING RETURNING key",
			customerID, key, requestHash, now)
		if taken == nil {
			existing := t.one("SELECT request_hash, response FROM idempotency_keys WHERE user_id = $1 AND key = $2", customerID, key)
			if existing.s("request_hash") != requestHash {
				fail(422, "idempotency_conflict")
			}
			publicID := ""
			if resp, ok := existing["response"].(map[string]any); ok {
				publicID, _ = resp["public_id"].(string)
			}
			if publicID == "" {
				fail(409, "idempotency_in_progress")
			}
			order = oneCustomerOrder(t, "o.user_id = ? AND o.public_id = ?", []any{customerID, publicID}, now)
			created = false
			return
		}

		// 1b. 未払い（placed）の注文の上限。払わずに確定を繰り返して、店の在庫を押さえ続けることを防ぐ
		if t.one("SELECT count(*) AS n FROM orders WHERE user_id = $1 AND status = 'placed'", customerID).i("n") >= maxUnpaidOrders {
			fail(409, "too_many_unpaid_orders")
		}

		// 2. 確定の許可証（版・期限・使用済み）
		cart := getCart(t, customerID, now, true)
		proposal := t.one("SELECT id, cart_version, total_lumi, expires_at, used_at FROM checkout_proposals WHERE id = $1 AND cart_id = $2 FOR UPDATE", proposalID, cart.i("id"))
		if proposal == nil {
			fail(404, "proposal_not_found")
		}
		if !proposal.isNull("used_at") {
			fail(409, "proposal_stale")
		}
		if !proposal.t("expires_at").After(now) {
			fail(409, "proposal_expired")
		}
		if proposal.i("cart_version") != cart.i("version") {
			fail(409, "proposal_stale")
		}

		// 3. カートの再検証（価格は今のメニューの値で計算し直す。営業時間・品揃い・上限）
		lines := priceLines(t, cart, local)
		total := validateCheckout(t, cart, lines, local, false)
		if total != proposal.i("total_lumi") {
			fail(409, "proposal_stale")
		}
		subtotal := subtotalOf(lines)
		var quote *resolution
		if cart.s("fulfillment") == "delivery" {
			quote = quoteForCart(t, cart, subtotal, now) // 宅配（P2）の住所・区画・枠。上の検査と同じ
		}
		deliveryFee := total - subtotal

		// 4. 在庫の確保（品目 ID の昇順に条件付き UPDATE。0 行なら売り切れ）。台帳に reserve を追記
		publicID := newPublicID()
		for t.one("SELECT 1 FROM orders WHERE public_id = $1", publicID) != nil {
			publicID = newPublicID()
		}
		ids := make([]int, len(lines))
		ol := make([]orderLine, len(lines))
		for i, l := range lines {
			ids[i] = l.variantID
			ol[i] = orderLine{l.variantID, l.qty}
		}
		recipeMap := recipes(t, ids)
		need := requirements(ol, recipeMap)
		if short := reserveStock(t, cart.i("store_id"), need, "order", publicID, "customer:"+itoa(customerID), now); short != nil {
			fail(409, "sold_out", kv{"item_name", firstLineUsing(lines, recipeMap, map[int]bool{short.itemID: true})})
		}

		// 5. 宅配の枠（P2）。条件付き UPDATE（booked < capacity）で確保する。取れなければ 409 で、在庫も冪等キーも全部戻る
		if quote != nil {
			bookSlot(t, quote.slot.i("id"), cart.i("store_id"))
		}
		// 6. 注文・行（スナップショット）・支払い・確保・履歴
		businessDate := dateOf(local).String()
		pickupNo := t.one("INSERT INTO store_order_counters (store_id, business_date, last_no) VALUES ($1, $2, 1) "+
			"ON CONFLICT (store_id, business_date) DO UPDATE SET last_no = store_order_counters.last_no + 1 RETURNING last_no", cart.i("store_id"), businessDate).i("last_no")
		orderID := t.one("INSERT INTO orders (public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, delivery_fee_lumi, total_lumi, "+
			"source, idempotency_key, placed_at) VALUES ($1, $2, $3, 'placed', $4, $5, $6, $7, $8, $9, 'screen', $10, $11) RETURNING id",
			publicID, customerID, cart.i("store_id"), cart.s("fulfillment"), pickupNo, businessDate, subtotal, deliveryFee, total, key, now).i("id")
		if quote != nil {
			createDelivery(t, orderID, cart.i("store_id"), quote, now)
		}
		for _, l := range lines {
			t.exec("INSERT INTO order_items (order_id, variant_id, name, size, temperature, unit_price_lumi, qty, line_total_lumi) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
				orderID, l.variantID, l.itemName, l.size, l.temperature, l.unitPriceLumi, l.qty, l.lineTotal())
		}
		t.exec("INSERT INTO payments (order_id, provider, status, amount_lumi, created_at, updated_at) VALUES ($1, $2, 'pending', $3, $4, $5)",
			orderID, getPaymentProvider().name(), total, now, now)
		reservationID := t.one("INSERT INTO stock_reservations (order_id, status, expires_at, created_at, updated_at) VALUES ($1, 'held', $2, $3, $4) RETURNING id",
			orderID, now.Add(reservationTTL), now, now).i("id")
		for _, itemID := range sortedKeys(need) {
			t.exec("INSERT INTO stock_reservation_lines (reservation_id, item_id, qty) VALUES ($1, $2, $3)", reservationID, itemID, need[itemID])
		}
		orderEvent(t, orderID, nil, "placed", "customer", ptr(itoa(customerID)), nil, now)

		// 許可証を使用済みにして、カートを空にする（版も上げる）
		t.exec("UPDATE checkout_proposals SET used_at = $1 WHERE id = $2", now, proposal.s("id"))
		t.exec("DELETE FROM cart_items WHERE cart_id = $1", cart.i("id"))
		t.exec("UPDATE carts SET version = version + 1, updated_at = $1 WHERE id = $2", now, cart.i("id"))

		order = oneCustomerOrder(t, "o.id = ?", []any{orderID}, now)
		raw, _ := json.Marshal(order)
		t.exec("UPDATE idempotency_keys SET response = $1::jsonb WHERE user_id = $2 AND key = $3", string(raw), customerID, key)
		created = true
	})
	return order, created
}

// ---- 支払い・顧客の取消し ----

func payOrder(customerID int, publicID, simulate string) orderOut {
	var order orderOut
	verdict := ""
	order = withRetry(func() orderOut {
		now := utcNow()
		verdict = ""
		var result orderOut
		withTx(func(t *tx) {
			o := lockOrder(t, publicID, &customerID, nil)
			if o.s("status") != "placed" {
				if o.s("status") == "cancelled" && o.sN("cancel_reason") != nil && *o.sN("cancel_reason") == "payment_timeout" {
					fail(409, "reservation_expired")
				}
				fail(409, "invalid_transition")
			}
			res := t.one("SELECT id, expires_at FROM stock_reservations WHERE order_id = $1 FOR UPDATE", o.i("id"))
			if res != nil && !res.isNull("expires_at") && !res.t("expires_at").After(now) {
				cancelOrder(t, o, "system", nil, "payment_timeout", "expired", now)
				verdict = "expired"
			} else {
				charge := getPaymentProvider().charge(o.s("public_id"), o.i("total_lumi"), simulate)
				if charge.ok {
					checkTransition("placed", "paid", "system", "invalid_transition")
					t.exec("UPDATE payments SET status = 'paid', provider_ref = $1, updated_at = $2 WHERE order_id = $3", charge.providerRef, now, o.i("id"))
					t.exec("UPDATE stock_reservations SET expires_at = NULL, updated_at = $1 WHERE order_id = $2", now, o.i("id"))
					t.exec("UPDATE orders SET status = 'paid', paid_at = $1 WHERE id = $2", now, o.i("id"))
					orderEvent(t, o.i("id"), ptr("placed"), "paid", "system", nil, nil, now)
				} else {
					cancelOrder(t, o, "system", nil, "payment_declined", "released", now)
					verdict = "declined"
				}
			}
			result = oneCustomerOrder(t, "o.id = ?", []any{o.i("id")}, now)
		})
		return result
	})
	switch verdict {
	case "expired":
		fail(409, "reservation_expired")
	case "declined":
		fail(402, "payment_declined")
	}
	return order
}

func cancelByCustomer(customerID int, publicID string) orderOut {
	return withRetry(func() orderOut {
		now := utcNow()
		return inTx(func(t *tx) orderOut {
			o := lockOrder(t, publicID, &customerID, nil)
			cancelOrder(t, o, "customer", ptr(itoa(customerID)), "customer_request", "released", now)
			return oneCustomerOrder(t, "o.id = ?", []any{o.i("id")}, now)
		})
	})
}

// ---- スタッフの状態遷移 ----

func staffTransition(staffID int, staffStoreID *int, publicID, action string, reason *string) staffOrderOut {
	return withRetry(func() staffOrderOut {
		now := utcNow()
		var rsn *string // Python: reason.strip() if reason else None（空白だけの文字列は strip して ""）
		if reason != nil && *reason != "" {
			s := pyStrip(*reason)
			rsn = &s
		}
		actorID := itoa(staffID)
		return inTx(func(t *tx) staffOrderOut {
			o := lockOrder(t, publicID, nil, staffStoreID)
			if action == "cancel" {
				if rsn == nil || *rsn == "" {
					fail(422, "reason_required")
				}
				cancelOrder(t, o, "staff", &actorID, *rsn, "released", now)
			} else {
				act := staffActions[action]
				if o.s("status") != act.from || (action == "complete" && o.s("fulfillment") == "delivery") { // 宅配は配達員が完了する
					fail(409, "invalid_transition")
				}
				checkTransition(act.from, act.to, "staff", "invalid_transition")
				switch action {
				case "accept":
					t.exec("UPDATE orders SET status = 'accepted', accepted_at = $1 WHERE id = $2", now, o.i("id"))
				case "start":
					consumeReservation(t, o, "staff:"+actorID, now)
					t.exec("UPDATE orders SET status = 'preparing' WHERE id = $1", o.i("id"))
				case "ready":
					t.exec("UPDATE orders SET status = 'ready', ready_at = $1 WHERE id = $2", now, o.i("id"))
				default: // complete
					t.exec("UPDATE orders SET status = 'completed', completed_at = $1 WHERE id = $2", now, o.i("id"))
					awardPoints(t, o, now)
				}
				orderEvent(t, o.i("id"), &act.from, act.to, "staff", &actorID, rsn, now)
			}
			return oneStaffOrder(t, "o.id = ?", []any{o.i("id")}, now)
		})
	})
}

// consumeReservation は調理開始: 確保した原材料を消費に変える（確保 → 消費）。
func consumeReservation(t *tx, order row, actor string, now time.Time) {
	res := t.one("SELECT id, status FROM stock_reservations WHERE order_id = $1 FOR UPDATE", order.i("id"))
	if res == nil || res.s("status") != "held" {
		fail(409, "invalid_transition")
	}
	consumeStock(t, order.i("store_id"), reservationLines(t, res.i("id")), "order", order.s("public_id"), actor, now)
	t.exec("UPDATE stock_reservations SET status = 'consumed', updated_at = $1 WHERE id = $2", now, res.i("id"))
}

// awardPoints は受け取り（completed）のとき、floor(合計 / 100) 点。台帳（earn は 1 注文に 1 回の部分 UNIQUE）と users.loyalty_points を同じトランザクションで。
func awardPoints(t *tx, order row, now time.Time) {
	points := order.i("total_lumi") / loyaltyLumiPerPoint
	if points <= 0 {
		return
	}
	earned := t.one("INSERT INTO loyalty_ledger (user_id, order_id, points, kind, at) VALUES ($1, $2, $3, 'earn', $4) "+
		"ON CONFLICT (order_id) WHERE kind = 'earn' DO NOTHING RETURNING id", order.i("user_id"), order.i("id"), points, now)
	if earned != nil {
		t.exec("UPDATE users SET loyalty_points = loyalty_points + $1 WHERE id = $2", points, order.i("user_id"))
	}
}

var _ = sort.Ints
