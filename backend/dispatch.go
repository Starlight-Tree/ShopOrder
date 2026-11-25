package main

// 配達の進行: 割り当て・集荷・出発・到着（暗証コード）・不在・再配達・模擬の進行（docs/api.md「宅配（P2）」、docs/order-flow.md「宅配」。backend/app/dispatch.py の移植）。
// トランザクションは、1 回の操作に 1 つ。注文の行を FOR UPDATE で押さえてから、配達の行（FOR UPDATE）→ 枠、の順。
// 暗証コードの誤りの回数は、commit してから 422 / 409 で答える（エラーで巻き戻さない）。ログには、住所・暗証コードを出さない（件数だけ）。

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

// ---- 共通 ----

// lockDelivery は配達の行を FOR UPDATE で押さえる（注文の行を先に押さえておくこと）。無ければ 404。
func lockDelivery(t *tx, orderID int) row {
	d := t.one("SELECT id, order_id, store_id, zone_id, slot_id, courier_id, status, attempt, pin_nonce, pin_hash, pin_attempts, pin_expires_at, "+
		"departed_at FROM deliveries WHERE order_id = $1 FOR UPDATE", orderID)
	if d == nil {
		fail(404, "not_found")
	}
	return d
}

func setCourierZone(t *tx, courierID, zoneID *int, now time.Time) {
	if courierID != nil && zoneID != nil {
		t.exec("UPDATE couriers SET zone_id = $1, updated_at = $2 WHERE staff_id = $3", *zoneID, now, *courierID)
	}
}

// moveOrder は注文の状態を進めて履歴に残す。遷移の表にない遷移は 409。extra は、同じ UPDATE で入れる列（ready_at など。列名はこのファイルの固定の名前だけ）。
func moveOrder(t *tx, order row, toStatus, actorType string, actorID, reason *string, now time.Time, extra ...kv) {
	checkTransition(order.s("status"), toStatus, actorType, "invalid_transition")
	sets := []string{"status = $1"}
	args := []any{toStatus}
	for _, e := range extra {
		args = append(args, e.Value)
		sets = append(sets, e.Key+" = $"+itoa(len(args)))
	}
	args = append(args, order.i("id"))
	t.exec("UPDATE orders SET "+strings.Join(sets, ", ")+" WHERE id = $"+itoa(len(args)), args...)
	from := order.s("status")
	orderEvent(t, order.i("id"), &from, toStatus, actorType, actorID, reason, now)
	order["status"] = toStatus
}

// deliveryOrderLock は宅配の注文の行を FOR UPDATE で押さえる。他店・他人の注文は 404。宅配でない注文は、店には 409（できない操作）、配達員には 404（自分の配達ではない）。
func deliveryOrderLock(t *tx, publicID string, storeID *int, notDeliveryStatus int, notDeliveryCode string) row {
	order := lockOrder(t, publicID, nil, storeID)
	if order.s("fulfillment") != "delivery" {
		fail(notDeliveryStatus, notDeliveryCode)
	}
	return order
}

// ownDelivery は配達員の担当の注文と配達の行（FOR UPDATE）。他の配達員の担当・他店・担当が付いていないものは 404。
func ownDelivery(t *tx, courier staffUser, publicID string) (row, row) {
	order := deliveryOrderLock(t, publicID, nil, 404, "not_found")
	d := lockDelivery(t, order.i("id"))
	if d.isNull("courier_id") || d.i("courier_id") != courier.id || courier.storeID == nil || d.i("store_id") != *courier.storeID {
		fail(404, "not_found")
	}
	return order, d
}

// ---- 店: 割り当て ----

func doAssign(t *tx, order, d row, courierID int, actorType string, actorID *string, now time.Time) {
	reason := ptr("courier:" + itoa(courierID))
	switch order.s("status") {
	case "ready":
		moveOrder(t, order, "assigned", actorType, actorID, reason, now)
	case "assigned": // 担当の付け替え（状態は変わらない。履歴だけ残す）
		orderEvent(t, order.i("id"), ptr("assigned"), "assigned", actorType, actorID, reason, now)
	default:
		fail(409, "invalid_transition")
	}
	t.exec("UPDATE deliveries SET status = 'assigned', courier_id = $1, assigned_at = $2 WHERE id = $3", courierID, now, d.i("id"))
}

// assignOrder は ready → assigned（assigned なら付け替え）。自店の勤務中の配達員だけ。
func assignOrder(staff staffUser, publicID string, courierID int) staffOrderOut {
	now := utcNow()
	return inTx(func(t *tx) staffOrderOut {
		order := deliveryOrderLock(t, publicID, staff.storeID, 409, "invalid_transition")
		d := lockDelivery(t, order.i("id"))
		if order.s("status") != "ready" && order.s("status") != "assigned" {
			fail(409, "invalid_transition")
		}
		courier := t.one("SELECT c.is_on_duty FROM couriers c JOIN staff_accounts a ON a.id = c.staff_id AND a.is_active AND a.role = 'courier' "+
			"WHERE c.staff_id = $1 AND c.store_id = $2", courierID, order.i("store_id"))
		if courier == nil {
			fail(404, "courier_not_found")
		}
		if !courier.b("is_on_duty") {
			fail(409, "courier_off_duty")
		}
		doAssign(t, order, d, courierID, "staff", ptr(itoa(staff.id)), now)
		return oneStaffOrder(t, "o.id = ?", []any{order.i("id")}, now)
	})
}

// ---- 配達員の操作 ----

// doPickup は assigned → picked_up。暗証コードを作る（DB にはハッシュだけ）。配達員は店の区画にいる。
func doPickup(t *tx, order, d row, actorType string, actorID *string, now time.Time) {
	if d.s("status") != "assigned" {
		fail(409, "invalid_transition")
	}
	moveOrder(t, order, "picked_up", actorType, actorID, nil, now)
	secret := deliveryPinSecret()
	nb := make([]byte, 8)
	if _, err := rand.Read(nb); err != nil {
		panic("乱数を読めません")
	}
	nonce := hex.EncodeToString(nb)
	pin := derivePin(secret, d.i("id"), nonce)
	t.exec("UPDATE deliveries SET status = 'picked_up', picked_up_at = $1, pin_nonce = $2, pin_hash = $3, pin_attempts = 0, pin_expires_at = $4 WHERE id = $5",
		now, nonce, pinHash(secret, d.i("id"), pin), now.Add(pinTTL), d.i("id"))
	setCourierZone(t, d.iN("courier_id"), storeHomeZoneID(t, d.i("store_id")), now)
}

func doDepart(t *tx, order, d row, actorType string, actorID *string, now time.Time) {
	if d.s("status") != "picked_up" {
		fail(409, "invalid_transition")
	}
	moveOrder(t, order, "delivering", actorType, actorID, nil, now)
	t.exec("UPDATE deliveries SET status = 'delivering', departed_at = $1 WHERE id = $2", now, d.i("id"))
}

// doComplete は delivering → delivered → completed（同じトランザクション）。ポイントを付ける。配達員は配達先の区画にいる。
func doComplete(t *tx, order, d row, actorType string, actorID *string, now time.Time) {
	if d.s("status") != "delivering" {
		fail(409, "invalid_transition")
	}
	moveOrder(t, order, "delivered", actorType, actorID, nil, now)
	t.exec("UPDATE deliveries SET status = 'delivered', delivered_at = $1 WHERE id = $2", now, d.i("id"))
	full := t.one("SELECT id, user_id, total_lumi FROM orders WHERE id = $1", order.i("id"))
	moveOrder(t, order, "completed", "system", nil, nil, now, kv{"completed_at", now})
	awardPoints(t, full, now)
	zid := d.i("zone_id")
	setCourierZone(t, d.iN("courier_id"), &zid, now)
}

// doFail は delivering → delivery_failed（不在・受け取れない・暗証コードの凍結）。再配達か取消しは店が決める。
func doFail(t *tx, order, d row, reason, actorType string, actorID *string, now time.Time) {
	if d.s("status") != "delivering" {
		fail(409, "invalid_transition")
	}
	moveOrder(t, order, "delivery_failed", actorType, actorID, &reason, now)
	t.exec("UPDATE deliveries SET status = 'failed', failed_at = $1, failure_reason = $2 WHERE id = $3", now, reason, d.i("id"))
	zid := d.i("zone_id")
	setCourierZone(t, d.iN("courier_id"), &zid, now)
}

// courierAction は配達員の pickup / depart / deliver / fail。返すのは操作の後の CourierDelivery。
func courierAction(courier staffUser, publicID, action, pin, reason string) courierDeliveryOut {
	now := utcNow()
	var refusal *apiError
	var view courierDeliveryOut
	withTx(func(t *tx) {
		order, d := ownDelivery(t, courier, publicID)
		actor := ptr(itoa(courier.id))
		switch action {
		case "pickup":
			doPickup(t, order, d, "staff", actor, now)
		case "depart":
			doDepart(t, order, d, "staff", actor, now)
		case "fail":
			r := reason
			if r == "" {
				r = "other"
			}
			doFail(t, order, d, r, "staff", actor, now)
		case "deliver":
			refusal = tryDeliver(t, order, d, pin, actor, now)
		default:
			fail(404, "not_found")
		}
		if refusal == nil {
			view = courierViews(t, courier, "o.id = ?", []any{order.i("id")}, now)[0]
		}
	})
	if refusal != nil {
		panic(refusal) // 誤りの回数は commit 済み
	}
	return view
}

// tryDeliver は暗証コードを確かめて、合えば完了。違えば誤りを数える（5 回で凍結して delivery_failed）。呼ぶ側は、返ったエラーを commit の後に出す。
func tryDeliver(t *tx, order, d row, pin string, actor *string, now time.Time) *apiError {
	if d.s("status") != "delivering" || d.isNull("pin_hash") {
		fail(409, "invalid_transition")
	}
	if d.isNull("pin_expires_at") || !d.t("pin_expires_at").After(now) {
		fail(409, "pin_expired") // 数えない
	}
	secret := deliveryPinSecret()
	if pinMatches(secret, d.i("id"), pin, d.s("pin_hash")) {
		doComplete(t, order, d, "staff", actor, now)
		return nil
	}
	attempts := d.i("pin_attempts") + 1
	t.exec("UPDATE deliveries SET pin_attempts = $1 WHERE id = $2", attempts, d.i("id"))
	if attempts >= pinMaxAttempts {
		doFail(t, order, d, "pin_locked", "system", nil, now) // 凍結して店へ
		logf("暗証コードの誤りが %d 回に達し、配達を止めました", attempts)
		return newAPIError(409, "pin_locked")
	}
	return newAPIError(422, "pin_invalid", kv{"attempts_left", pinMaxAttempts - attempts})
}

// ---- 店: 再配達 ----

// redeliverOrder は delivery_failed → ready。新しい枠を取り（slotID 省略は最も早い枠）、古い枠を戻す。担当・暗証コードを外す。
func redeliverOrder(staff staffUser, publicID string, slotID *int) staffOrderOut {
	now := utcNow()
	return inTx(func(t *tx) staffOrderOut {
		order := deliveryOrderLock(t, publicID, staff.storeID, 409, "invalid_transition")
		d := lockDelivery(t, order.i("id"))
		if order.s("status") != "delivery_failed" {
			fail(409, "invalid_transition")
		}
		checkTransition("delivery_failed", "ready", "staff", "invalid_transition")
		store := t.one("SELECT id, open_time::text AS open_time, close_time::text AS close_time, closed_weekday, last_order_minutes FROM stores WHERE id = $1", order.i("store_id"))
		zone := loadZone(t, d.i("zone_id"))
		if zone == nil || zone.b("is_suspended") {
			fail(409, "zone_suspended")
		}
		var slot row
		if slotID == nil {
			slot = earliestSlot(t, store, zone, now)
			if slot == nil {
				fail(409, "no_slot_available")
			}
		} else {
			slot = loadSlot(t, *slotID)
			if slot == nil || slot.i("store_id") != order.i("store_id") {
				fail(404, "slot_not_found")
			}
			issue := slotIssue(t, slot, now)
			if issue != nil && !(*issue == "slot_full" && slot.i("id") == d.i("slot_id")) { // 同じ枠へ戻すときの満席は、自分の分
				fail(409, *issue)
			}
		}
		// 枠は、ID の昇順に触る（2 つの再配達が逆の順で待ち合って、デッドロックにならないように）。同じ枠なら、何も変えない
		oldID, newID := d.i("slot_id"), slot.i("id")
		if oldID < newID {
			releaseSlot(t, oldID)
			bookSlot(t, newID, order.i("store_id"))
		} else if oldID > newID {
			bookSlot(t, newID, order.i("store_id"))
			releaseSlot(t, oldID)
		}
		t.exec("UPDATE deliveries SET slot_id = $1, status = 'pending', courier_id = NULL, attempt = attempt + 1, failure_reason = NULL, failed_at = NULL, "+
			"pin_nonce = NULL, pin_hash = NULL, pin_attempts = 0, pin_expires_at = NULL, assigned_at = NULL, picked_up_at = NULL, departed_at = NULL "+
			"WHERE id = $2", newID, d.i("id"))
		moveOrder(t, order, "ready", "staff", ptr(itoa(staff.id)), ptr("redelivery"), now)
		return oneStaffOrder(t, "o.id = ?", []any{order.i("id")}, now)
	})
}

// ---- 模擬の配達（DELIVERY_PROVIDER=mock のときだけ）----

func requireMock() {
	if deliveryProvider() != "mock" {
		fail(409, "mock_only")
	}
}

// mockStep は模擬の 1 歩（system が進める）。ready は、提案の配達員を割り当てる。
func mockStep(t *tx, order, d row, now time.Time) {
	switch {
	case order.s("status") == "ready":
		couriers := listCouriers(t, ptr(order.i("store_id")))
		top := suggestionForStore(couriers, storeHomeZoneID(t, order.i("store_id")), loadTravelMatrix(t))
		if top == nil {
			fail(409, "no_courier_available")
		}
		doAssign(t, order, d, top.CourierID, "system", nil, now)
	case d.s("status") == "assigned":
		doPickup(t, order, d, "system", nil, now)
	case d.s("status") == "picked_up":
		doDepart(t, order, d, "system", nil, now)
	case d.s("status") == "delivering":
		doComplete(t, order, d, "system", nil, now) // 暗証コードなし（模擬）
	default:
		fail(409, "invalid_transition")
	}
}

// mockAdvance はデモ用: 模擬の配達を 1 つ進める。DELIVERY_PROVIDER=mock のときだけ。
func mockAdvance(staff staffUser, publicID string) staffOrderOut {
	requireMock()
	now := utcNow()
	return inTx(func(t *tx) staffOrderOut {
		order := deliveryOrderLock(t, publicID, staff.storeID, 409, "invalid_transition")
		d := lockDelivery(t, order.i("id"))
		mockStep(t, order, d, now)
		return oneStaffOrder(t, "o.id = ?", []any{order.i("id")}, now)
	})
}

// mockTick は worker の巡回: 前の変化から step 秒たった配達を、1 歩ずつ進める（assigned 以降。割り当ては人が行う）。進めた件数を返す。
func mockTick(now time.Time) int {
	if deliveryProvider() != "mock" || !deliveryMockAutopilot() {
		return 0
	}
	older := now.Add(-time.Duration(deliveryMockStepSeconds()) * time.Second)
	due := inTx(func(t *tx) []row {
		return t.all("SELECT o.public_id FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.status = ANY($1) "+
			"AND COALESCE(d.departed_at, d.picked_up_at, d.assigned_at) <= $2 ORDER BY d.id LIMIT 50", activeStatuses, older)
	})
	advanced := 0
	for _, r := range due {
		pid := r.s("public_id")
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					if _, ok := rec.(*apiError); ok {
						return // 別の操作が先に進めた
					}
					panic(rec)
				}
			}()
			withTx(func(t *tx) {
				locked := t.one("SELECT id, status, fulfillment, store_id FROM orders WHERE public_id = $1 FOR UPDATE SKIP LOCKED", pid)
				if locked == nil {
					return
				}
				d := lockDelivery(t, locked.i("id"))
				if !contains(activeStatuses, d.s("status")) {
					return
				}
				mockStep(t, locked, d, now)
				advanced++
			})
		}()
	}
	if advanced > 0 {
		logf("模擬の配達を %d 件、進めました", advanced)
	}
	return advanced
}

// ---- 読み取り ----

// dispatchBoard は配車ボード: 配達員（担当中の件数つき）と、宅配の注文（枠の開始が早い順。ready には提案）。
func dispatchBoard(storeID *int, statuses []string) dispatchBoardOut {
	expireStale()
	now := utcNow()
	where, params := orderScope(storeID)
	var out dispatchBoardOut
	withTx(func(t *tx) {
		rows := fetchOrders(t, "o.fulfillment = 'delivery' AND "+where+" AND o.status = ANY(?)", append(params, statuses), "o.placed_at, o.id", 200)
		found := assembleStaffOrders(t, rows, now)
		couriers := listCouriers(t, storeID)
		matrix := loadTravelMatrix(t)
		byStore := map[int][]row{}
		for _, c := range couriers {
			byStore[c.i("store_id")] = append(byStore[c.i("store_id")], c)
		}
		suggestions := map[int]*suggestionOut{}
		seen := map[int]bool{}
		orders := make([]dispatchOrderOut, 0, len(found))
		for _, o := range found {
			d := dispatchOrderOut{staffOrderOut: o}
			if o.Status == "ready" {
				if !seen[o.Store.ID] {
					seen[o.Store.ID] = true
					suggestions[o.Store.ID] = suggestionForStore(byStore[o.Store.ID], storeHomeZoneID(t, o.Store.ID), matrix)
				}
				d.Suggestion = suggestions[o.Store.ID]
			}
			orders = append(orders, d)
		}
		sort.SliceStable(orders, func(i, j int) bool {
			ki, kj := "", ""
			if orders[i].Delivery != nil {
				ki = orders[i].Delivery.Slot.StartsAt
			}
			if orders[j].Delivery != nil {
				kj = orders[j].Delivery.Slot.StartsAt
			}
			if ki != kj {
				return ki < kj
			}
			return orders[i].PlacedAt < orders[j].PlacedAt
		})
		cs := make([]courierOut, 0, len(couriers))
		for _, c := range couriers {
			cs = append(cs, courierPublic(c))
		}
		out = dispatchBoardOut{Provider: deliveryProvider(), Couriers: cs, Orders: orders}
	})
	return out
}

func listCourierOuts(storeID *int) []courierOut {
	return inTx(func(t *tx) []courierOut {
		rows := listCouriers(t, storeID)
		out := make([]courierOut, 0, len(rows))
		for _, c := range rows {
			out = append(out, courierPublic(c))
		}
		return out
	})
}

var courierAllowed = map[string][]string{"assigned": {"pickup"}, "picked_up": {"depart"}, "delivering": {"deliver", "fail"}}

func courierViews(t *tx, courier staffUser, where string, params []any, now time.Time) []courierDeliveryOut {
	args := append([]any{courier.id}, params...)
	rows := t.all(numberQuestionMarks("SELECT o.id AS order_id, o.public_id, o.pickup_no, o.status AS order_status, o.store_id, s.name AS store_name, d.id AS delivery_id, d.status, "+
		"d.zone_id, z.name AS zone_name, z.base_minutes, d.slot_id, sl.starts_at, sl.ends_at, d.attempt, d.pin_attempts, d.departed_at, "+
		"d.address_label, d.address_line, d.address_note "+
		"FROM deliveries d JOIN orders o ON o.id = d.order_id JOIN stores s ON s.id = o.store_id JOIN delivery_zones z ON z.id = d.zone_id "+
		"JOIN delivery_slots sl ON sl.id = d.slot_id WHERE d.courier_id = ? AND "+where+" ORDER BY sl.starts_at, o.id"), args...)
	ids := make([]int, len(rows))
	items := map[int][]courierItemOut{}
	for i, r := range rows {
		ids[i] = r.i("order_id")
		items[ids[i]] = []courierItemOut{}
	}
	if len(ids) > 0 {
		for _, it := range t.all("SELECT order_id, name, size, temperature, qty FROM order_items WHERE order_id = ANY($1) ORDER BY id", ids) {
			items[it.i("order_id")] = append(items[it.i("order_id")], courierItemOut{Name: it.s("name"), Size: it.s("size"), Temperature: it.s("temperature"), Qty: it.i("qty")})
		}
	}
	out := make([]courierDeliveryOut, 0, len(rows))
	for _, r := range rows {
		status := r.s("order_status")
		v := courierDeliveryOut{
			PublicID: r.s("public_id"), PickupNo: r.i("pickup_no"), Status: status, Store: storeRef{ID: r.i("store_id"), Name: r.s("store_name")},
			Zone:  zoneRef{ID: r.i("zone_id"), Name: r.s("zone_name")},
			Slot:  slotRef{ID: r.i("slot_id"), StartsAt: isoTime(r.t("starts_at")), EndsAt: isoTime(r.t("ends_at"))},
			Items: items[r.i("order_id")], Attempt: r.i("attempt"),
			EtaAt:          isoTimePtr(etaAt(r.s("status"), r.t("starts_at"), r.tN("departed_at"), r.i("base_minutes"))),
			AllowedActions: emptyIfNil(courierAllowed[status]),
		}
		if status == "picked_up" || status == "delivering" { // 住所は集荷後だけ（個人情報）
			v.Address = &courierAddressOut{Label: r.s("address_label"), Line: r.s("address_line"), Note: r.sN("address_note")}
		}
		if status == "delivering" {
			left := pinMaxAttempts - r.i("pin_attempts")
			v.PinAttemptsLeft = &left
		}
		out = append(out, v)
	}
	return out
}

// courierDeliveries は自分の担当（assigned / picked_up / delivering）。枠の開始が早い順。
func courierDeliveries(courier staffUser) []courierDeliveryOut {
	now := utcNow()
	return inTx(func(t *tx) []courierDeliveryOut {
		return courierViews(t, courier, "d.status = ANY(?)", []any{activeStatuses}, now)
	})
}
