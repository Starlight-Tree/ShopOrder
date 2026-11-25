package main

// 宅配の DB 操作: 区画・住所・時間枠・カートと確定の検査（見積り）・枠の確保と戻し・注文への配達の見え方・配達員の一覧と提案（backend/app/delivery.py の移植）。
// カート（cart.go）と注文（orders.go）が呼ぶ。配達の進行（割り当て・集荷・到着・不在・再配達）は dispatch.go。
// ログには、住所（line・note）・暗証コードを出さない（このファイルは、ログを出さない）。
//
// ロックの順: 確定は 在庫の残高 → 枠。既存の注文を触る操作は 注文 → 確保 → 在庫 → 配達の行 → 枠（取消しも同じ順）。枠を 2 つ触る再配達は、枠の ID の昇順。

import (
	"time"
)

func checkStartupDelivery() {
	deliveryPinSecret()
	deliveryMockAutopilot()
	deliveryMockStepSeconds()
	provider("DELIVERY_PROVIDER")
	getProposer(assignmentPolicy())
}

func deliveryProvider() string { return provider("DELIVERY_PROVIDER") }

// ---- 区画 ----

const zoneColumns = "id, area_code, name, fee_lumi, free_over_lumi, min_order_lumi, base_minutes, is_suspended"

func zonePublic(r row) zoneOut {
	return zoneOut{
		ID: r.i("id"), Name: r.s("name"), AreaCode: r.i("area_code"), FeeLumi: r.i("fee_lumi"), FreeOverLumi: r.iN("free_over_lumi"),
		MinOrderLumi: r.i("min_order_lumi"), BaseMinutes: r.i("base_minutes"), IsSuspended: r.b("is_suspended"),
	}
}

func storeZoneIDs(t *tx, storeID int) map[int]bool {
	out := map[int]bool{}
	for _, r := range t.all("SELECT zone_id FROM store_zones WHERE store_id = $1", storeID) {
		out[r.i("zone_id")] = true
	}
	return out
}

func listZones(t *tx, storeID *int) []zoneOut {
	var rows []row
	if storeID == nil {
		rows = t.all("SELECT " + zoneColumns + " FROM delivery_zones ORDER BY area_code")
	} else {
		rows = t.all("SELECT "+zoneColumns+" FROM delivery_zones WHERE id IN (SELECT zone_id FROM store_zones WHERE store_id = $1) ORDER BY area_code", *storeID)
	}
	out := make([]zoneOut, 0, len(rows))
	for _, r := range rows {
		out = append(out, zonePublic(r))
	}
	return out
}

func loadZone(t *tx, zoneID int) row {
	return t.one("SELECT "+zoneColumns+" FROM delivery_zones WHERE id = $1", zoneID)
}

func zoneForArea(t *tx, areaCode int) row {
	return t.one("SELECT "+zoneColumns+" FROM delivery_zones WHERE area_code = $1", areaCode)
}

// storeHomeZoneID は店のエリアの区画（配達員が集荷に来る先）。
func storeHomeZoneID(t *tx, storeID int) *int {
	r := t.one("SELECT z.id FROM stores s JOIN delivery_zones z ON z.area_code = s.area_code WHERE s.id = $1", storeID)
	if r == nil {
		return nil
	}
	return r.iN("id")
}

// setSuspension は砂嵐の警報を立てる・解除する（店長だけ。呼ぶ側が確かめる）。すでに確保した枠の注文は、取り消さない。
func setSuspension(t *tx, zoneID int, suspended bool, now time.Time) zoneOut {
	var at any
	if suspended {
		at = now
	}
	r := t.one("UPDATE delivery_zones SET is_suspended = $1, suspended_at = $2 WHERE id = $3 RETURNING "+zoneColumns, suspended, at, zoneID)
	if r == nil {
		fail(404, "zone_not_found")
	}
	return zonePublic(r)
}

func loadTravelMatrix(t *tx) travelMatrix {
	m := travelMatrix{}
	for _, r := range t.all("SELECT from_zone_id, to_zone_id, minutes FROM zone_travel_minutes") {
		m[[2]int{r.i("from_zone_id"), r.i("to_zone_id")}] = r.i("minutes")
	}
	return m
}

// ---- 住所（🔒）----

const addressSelect = "SELECT a.id, a.user_id, a.label, a.area_code, ar.name AS area_name, z.id AS zone_id, a.line, a.note, a.created_at " +
	"FROM addresses a JOIN areas ar ON ar.code = a.area_code LEFT JOIN delivery_zones z ON z.area_code = a.area_code "

func addressPublic(r row) addressOut {
	return addressOut{
		ID: r.i("id"), Label: r.s("label"), AreaCode: r.i("area_code"), AreaName: r.s("area_name"), ZoneID: r.iN("zone_id"),
		Line: r.s("line"), Note: r.sN("note"), CreatedAt: isoTime(r.t("created_at")),
	}
}

// addressBriefOf はカート・注文の応答に出す住所（line・note は出さない）。
func addressBriefOf(r row) *addressBrief {
	return &addressBrief{ID: r.i("id"), Label: r.s("label"), AreaCode: r.i("area_code"), AreaName: r.s("area_name")}
}

func listAddresses(t *tx, userID int) []addressOut {
	rows := t.all(addressSelect+"WHERE a.user_id = $1 ORDER BY a.id", userID)
	out := make([]addressOut, 0, len(rows))
	for _, r := range rows {
		out = append(out, addressPublic(r))
	}
	return out
}

func createAddress(t *tx, userID int, label string, areaCode int, line string, note *string, now time.Time) addressOut {
	if zoneForArea(t, areaCode) == nil {
		fail(422, "invalid_area")
	}
	t.one("SELECT id FROM users WHERE id = $1 FOR UPDATE", userID) // 同じ利用者の並行した登録で、件数の上限を超えさせない
	if t.one("SELECT count(*) AS n FROM addresses WHERE user_id = $1", userID).i("n") >= addressLimit {
		fail(422, "too_many_addresses")
	}
	newID := t.one("INSERT INTO addresses (user_id, label, area_code, line, note, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
		userID, label, areaCode, line, note, now).i("id")
	return addressPublic(t.one(addressSelect+"WHERE a.id = $1", newID))
}

func deleteAddress(t *tx, userID, addressID int, now time.Time) {
	if t.one("SELECT id FROM addresses WHERE id = $1 AND user_id = $2 FOR UPDATE", addressID, userID) == nil {
		fail(404, "address_not_found")
	}
	// カートが選んでいたら外す（版も上げる。外部キーは RESTRICT）。過去の注文は、配達の行に写しがある
	t.exec("UPDATE carts SET address_id = NULL, version = version + 1, updated_at = $1 WHERE address_id = $2", now, addressID)
	t.exec("DELETE FROM addresses WHERE id = $1", addressID)
}

func loadAddress(t *tx, addressID int, shareLock bool) row {
	sql := addressSelect + "WHERE a.id = $1"
	if shareLock {
		sql += " FOR SHARE OF a"
	}
	return t.one(sql, addressID)
}

// ---- 時間枠 ----

func slotPublic(r row) slotRef {
	return slotRef{ID: r.i("id"), StartsAt: isoTime(r.t("starts_at")), EndsAt: isoTime(r.t("ends_at"))}
}

// ensureSlots はその日の枠を作る（足りないものだけ。INSERT ... ON CONFLICT DO NOTHING なので、同時に呼んでも重ならない）。定休日は作らない。
func ensureSlots(t *tx, store row, day dateOnly) {
	if cw := store.iN("closed_weekday"); cw != nil && *cw == day.isoWeekday() {
		return
	}
	grid := slotGrid(store.s("open_time"), store.s("close_time"), store.i("last_order_minutes"), day, localUTCOffsetHours())
	if len(grid) == 0 {
		return
	}
	starts := make([]time.Time, len(grid))
	for i, g := range grid {
		starts[i] = g.start
	}
	if t.one("SELECT count(*) AS n FROM delivery_slots WHERE store_id = $1 AND starts_at = ANY($2)", store.i("id"), starts).i("n") == len(grid) {
		return
	}
	for _, g := range grid {
		t.exec("INSERT INTO delivery_slots (store_id, starts_at, ends_at, capacity) VALUES ($1, $2, $3, $4) ON CONFLICT (store_id, starts_at) DO NOTHING",
			store.i("id"), g.start, g.end, slotCapacity)
	}
}

// ensureWindow は今日から slotDaysAhead 日先までの枠を作る（seed と再配達の前）。
func ensureWindow(t *tx, store row, today dateOnly) {
	for i := 0; i <= slotDaysAhead; i++ {
		ensureSlots(t, store, today.addDays(i))
	}
}

func dayBounds(day dateOnly) (time.Time, time.Time) {
	start := time.Date(day.y, time.Month(day.m), day.d, 0, 0, 0, 0, localZone(localUTCOffsetHours()))
	return start.UTC(), start.Add(24 * time.Hour).UTC()
}

func closureDates(t *tx, storeID int) map[dateOnly]bool {
	out := map[dateOnly]bool{}
	for _, r := range t.all("SELECT date FROM store_closures WHERE store_id = $1", storeID) {
		out[r.date("date")] = true
	}
	return out
}

// listSlots はその日の枠の一覧。休業・砂嵐・宅配をしない店は、reason を付けて枠を空にする。
func listSlots(t *tx, store row, day dateOnly, zoneID *int, now time.Time) slotListOut {
	today := dateOf(localNow())
	if day.before(today) || today.addDays(slotDaysAhead).before(day) {
		fail(422, "invalid_date")
	}
	zoneIDs := storeZoneIDs(t, store.i("id"))
	reason := slotListReason(t, store, day, zoneID, zoneIDs)
	slots := []slotOut{}
	if reason == nil {
		ensureSlots(t, store, day)
		lo, hi := dayBounds(day)
		rows := t.all("SELECT id, starts_at, ends_at, capacity, booked FROM delivery_slots WHERE store_id = $1 AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at",
			store.i("id"), lo, hi)
		for _, r := range rows {
			why := slotUnavailableReason(r.t("starts_at"), r.i("booked"), r.i("capacity"), now)
			remaining := r.i("capacity") - r.i("booked")
			if remaining < 0 {
				remaining = 0
			}
			sp := slotPublic(r)
			slots = append(slots, slotOut{
				ID: sp.ID, StartsAt: sp.StartsAt, EndsAt: sp.EndsAt, Capacity: r.i("capacity"), Booked: r.i("booked"), Remaining: remaining,
				Available: why == nil, UnavailableReason: why,
			})
		}
		if len(slots) == 0 {
			reason = ptr("closed_today") // 定休日（その日の枠が作られない）
		}
	}
	return slotListOut{StoreID: store.i("id"), Date: day.String(), ZoneID: zoneID, Reason: reason, Slots: slots}
}

func slotListReason(t *tx, store row, day dateOnly, zoneID *int, zoneIDs map[int]bool) *string {
	if len(zoneIDs) == 0 {
		return ptr("delivery_unavailable")
	}
	if !store.b("mobile_order") {
		return ptr("mobile_order_unavailable")
	}
	if closureDates(t, store.i("id"))[day] {
		return ptr("temporary_closure")
	}
	if zoneID != nil {
		if !zoneIDs[*zoneID] {
			return ptr("zone_unserved")
		}
		if zone := loadZone(t, *zoneID); zone != nil && zone.b("is_suspended") {
			return ptr("storm_warning")
		}
	}
	if cw := store.iN("closed_weekday"); cw != nil && *cw == day.isoWeekday() {
		return ptr("closed_today")
	}
	return nil
}

func loadSlot(t *tx, slotID int) row {
	return t.one("SELECT id, store_id, starts_at, ends_at, capacity, booked FROM delivery_slots WHERE id = $1", slotID)
}

// slotIssue は枠を選べない理由のコード（slot_closed / slot_cutoff / slot_full）。選べるなら nil。休業 → 締め → 満席の順。
func slotIssue(t *tx, slot row, now time.Time) *string {
	if closureDates(t, slot.i("store_id"))[localDateOf(slot.t("starts_at"), localUTCOffsetHours())] {
		return ptr("slot_closed")
	}
	why := slotUnavailableReason(slot.t("starts_at"), slot.i("booked"), slot.i("capacity"), now)
	if why == nil {
		return nil
	}
	switch *why {
	case "cutoff":
		return ptr("slot_cutoff")
	case "full":
		return ptr("slot_full")
	}
	return nil
}

// bookSlot は枠を 1 つ確保する。条件付き UPDATE（booked < capacity）なので、同時でも上限を超えない。0 行なら満席（409）。
func bookSlot(t *tx, slotID, storeID int) {
	if t.one("UPDATE delivery_slots SET booked = booked + 1 WHERE id = $1 AND store_id = $2 AND booked < capacity RETURNING id", slotID, storeID) == nil {
		fail(409, "slot_full")
	}
}

func releaseSlot(t *tx, slotID int) {
	t.exec("UPDATE delivery_slots SET booked = booked - 1 WHERE id = $1 AND booked > 0", slotID)
}

// earliestSlot は再配達で、選べる中で最も早い枠（締め前・満席でない・休業でない）。区画が砂嵐なら nil。
func earliestSlot(t *tx, store, zone row, now time.Time) row {
	if zone.b("is_suspended") {
		return nil
	}
	today := dateOf(localNow())
	ensureWindow(t, store, today)
	closures := closureDates(t, store.i("id"))
	offset := localUTCOffsetHours()
	rows := t.all("SELECT id, store_id, starts_at, ends_at, capacity, booked FROM delivery_slots WHERE store_id = $1 AND starts_at >= $2 AND booked < capacity "+
		"ORDER BY starts_at LIMIT 400", store.i("id"), now)
	for _, r := range rows {
		if closures[localDateOf(r.t("starts_at"), offset)] {
			continue
		}
		if slotUnavailableReason(r.t("starts_at"), r.i("booked"), r.i("capacity"), now) == nil {
			return r
		}
	}
	return nil
}

// ---- カート・確定の検査（見積り）----

// resolution はカートの宅配の選択を、今の状態で見たもの。issues は、確認・確定が 409 にするコード（空なら通る）。
type resolution struct {
	address, zone, slot row
	feeLumi             int
	issues              []string
}

func resolveDelivery(t *tx, cart row, subtotal int, now time.Time) *resolution {
	res := &resolution{}
	zoneIDs := map[int]bool{}
	if !cart.isNull("store_id") {
		zoneIDs = storeZoneIDs(t, cart.i("store_id"))
	}
	if len(zoneIDs) == 0 {
		res.issues = append(res.issues, "delivery_unavailable")
	}
	if !cart.isNull("address_id") {
		res.address = loadAddress(t, cart.i("address_id"), false)
	}
	if res.address == nil {
		res.issues = append(res.issues, "address_required")
	}
	if !cart.isNull("slot_id") {
		slot := loadSlot(t, cart.i("slot_id"))
		if slot != nil && !cart.isNull("store_id") && slot.i("store_id") == cart.i("store_id") {
			res.slot = slot
		}
	}
	if res.slot == nil {
		res.issues = append(res.issues, "slot_required")
	}
	if res.address != nil {
		res.zone = zoneForArea(t, res.address.i("area_code"))
	}
	if res.zone != nil {
		if subtotal > 0 {
			res.feeLumi = deliveryFee(res.zone.i("fee_lumi"), res.zone.iN("free_over_lumi"), subtotal)
		}
		if len(zoneIDs) > 0 && !zoneIDs[res.zone.i("id")] {
			res.issues = append(res.issues, "out_of_zone")
		}
		if res.zone.b("is_suspended") {
			res.issues = append(res.issues, "zone_suspended")
		}
		if subtotal > 0 && !meetsMinimum(subtotal, res.zone.i("min_order_lumi")) {
			res.issues = append(res.issues, "below_minimum")
		}
	}
	if res.slot != nil {
		if issue := slotIssue(t, res.slot, now); issue != nil {
			res.issues = append(res.issues, *issue)
		}
	}
	return res
}

// cartDeliveryView は Cart.delivery / CheckoutProposal.delivery（docs/api.md）。住所は line・note を出さない。
func cartDeliveryView(res *resolution) *cartDelivery {
	out := &cartDelivery{FeeLumi: res.feeLumi, Issues: emptyIfNil(append([]string(nil), res.issues...))}
	if res.address != nil {
		out.Address = addressBriefOf(res.address)
	}
	if res.zone != nil {
		z := zonePublic(res.zone)
		out.Zone = &z
		out.FreeOverLumi = z.FreeOverLumi
		m := z.MinOrderLumi
		out.MinOrderLumi = &m
	}
	if res.slot != nil {
		s := slotPublic(res.slot)
		out.Slot = &s
	}
	return out
}

// quoteForCart は確認・確定の検査。通らなければ、最初の 1 件を 409（code つき）で返す。
func quoteForCart(t *tx, cart row, subtotal int, now time.Time) *resolution {
	res := resolveDelivery(t, cart, subtotal, now)
	if len(res.issues) > 0 {
		var extra []kv
		if res.issues[0] == "below_minimum" && res.zone != nil {
			extra = []kv{{"min_order_lumi", res.zone.i("min_order_lumi")}}
		}
		fail(409, res.issues[0], extra...)
	}
	return res
}

// validateSelection は PUT /api/cart の検査: 住所は本人のもの（呼ぶ側が user_id で絞る）で店の区画の中、枠は店のもので選べるもの。
func validateSelection(t *tx, storeID int, addressID, slotID *int, now time.Time) {
	if addressID != nil {
		address := loadAddress(t, *addressID, true)
		zoneIDs := storeZoneIDs(t, storeID)
		var zone row
		if address != nil {
			zone = zoneForArea(t, address.i("area_code"))
		}
		if zone != nil && len(zoneIDs) > 0 && !zoneIDs[zone.i("id")] {
			fail(409, "out_of_zone")
		}
	}
	if slotID != nil {
		slot := loadSlot(t, *slotID)
		if slot == nil || slot.i("store_id") != storeID {
			fail(404, "slot_not_found")
		}
		if issue := slotIssue(t, slot, now); issue != nil {
			fail(409, *issue)
		}
	}
}

// ---- 注文の確定・取消し ----

// createDelivery は確定で、配達の行を作る（枠は、呼ぶ側が bookSlot で確保済み）。住所は注文時の写しを持つ。
func createDelivery(t *tx, orderID, storeID int, res *resolution, now time.Time) {
	t.exec("INSERT INTO deliveries (order_id, store_id, zone_id, slot_id, status, address_label, address_line, address_note, created_at) "+
		"VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)",
		orderID, storeID, res.zone.i("id"), res.slot.i("id"), res.address.s("label"), res.address.s("line"), res.address.sN("note"), now)
}

// cancelDelivery は注文の取消し・期限切れ・支払いの失敗で、枠を戻して配達を cancelled にする（注文の行は、呼ぶ側が FOR UPDATE 済み）。
func cancelDelivery(t *tx, orderID int) {
	d := t.one("SELECT id, slot_id, status FROM deliveries WHERE order_id = $1 FOR UPDATE", orderID)
	if d == nil || d.s("status") == "cancelled" {
		return
	}
	releaseSlot(t, d.i("slot_id"))
	t.exec("UPDATE deliveries SET status = 'cancelled' WHERE id = $1", d.i("id"))
}

// ---- 注文の応答に出す配達 ----

const deliveryViewSelect = "SELECT d.id, d.order_id, d.status, d.zone_id, z.name AS zone_name, z.base_minutes, d.slot_id, sl.starts_at, sl.ends_at, d.courier_id, " +
	"a.name AS courier_name, d.address_label, d.pin_nonce, d.pin_expires_at, d.attempt, d.failure_reason, d.departed_at " +
	"FROM deliveries d JOIN delivery_zones z ON z.id = d.zone_id JOIN delivery_slots sl ON sl.id = d.slot_id " +
	"LEFT JOIN staff_accounts a ON a.id = d.courier_id "

func deliveryViewRows(t *tx, orderIDs []int) []row {
	if len(orderIDs) == 0 {
		return nil
	}
	return t.all(deliveryViewSelect+"WHERE d.order_id = ANY($1)", orderIDs)
}

// customerDeliveryViews は注文 ID → delivery（顧客向け）。courier は名前だけ・暗証コードは集荷後だけ。
func customerDeliveryViews(t *tx, orderIDs []int, now time.Time) map[int]*orderDelivery {
	out := map[int]*orderDelivery{}
	rows := deliveryViewRows(t, orderIDs)
	if len(rows) == 0 {
		return out
	}
	secret := deliveryPinSecret()
	for _, r := range rows {
		v := &orderDelivery{
			Status: r.s("status"), Zone: zoneRef{ID: r.i("zone_id"), Name: r.s("zone_name")},
			Slot:    slotRef{ID: r.i("slot_id"), StartsAt: isoTime(r.t("starts_at")), EndsAt: isoTime(r.t("ends_at"))},
			Attempt: r.i("attempt"), FailureReason: r.sN("failure_reason"),
		}
		if !r.isNull("courier_id") {
			v.Courier = &courierName{Name: r.s("courier_name")}
		}
		status := r.s("status")
		showPin := (status == "picked_up" || status == "delivering") && !r.isNull("pin_nonce") && !r.isNull("pin_expires_at") && r.t("pin_expires_at").After(now)
		if showPin {
			v.Pin = ptr(derivePin(secret, r.i("id"), r.s("pin_nonce")))
		}
		v.EtaAt = isoTimePtr(etaAt(status, r.t("starts_at"), r.tN("departed_at"), r.i("base_minutes")))
		v.Address = addressLabel{Label: r.s("address_label")}
		out[r.i("order_id")] = v
	}
	return out
}

// staffDeliveryViews は注文 ID → delivery（スタッフ向け）。courier の ID と名前・暗証コードなし・住所なし。
func staffDeliveryViews(t *tx, orderIDs []int, now time.Time) map[int]*staffOrderDelivery {
	out := map[int]*staffOrderDelivery{}
	for _, r := range deliveryViewRows(t, orderIDs) {
		v := &staffOrderDelivery{
			Status: r.s("status"), Zone: zoneRef{ID: r.i("zone_id"), Name: r.s("zone_name")},
			Slot:    slotRef{ID: r.i("slot_id"), StartsAt: isoTime(r.t("starts_at")), EndsAt: isoTime(r.t("ends_at"))},
			Attempt: r.i("attempt"), FailureReason: r.sN("failure_reason"),
		}
		if !r.isNull("courier_id") {
			v.Courier = &courierRef{ID: r.i("courier_id"), Name: r.s("courier_name")}
		}
		out[r.i("order_id")] = v
	}
	return out
}

// ---- 配達員 ----

// listCouriers は配達員（担当中の件数・最後にいた区画つき）。有効なアカウントだけ。storeID が nil なら全店。
func listCouriers(t *tx, storeID *int) []row {
	var sid any
	if storeID != nil {
		sid = *storeID
	}
	return t.all("SELECT c.staff_id AS id, c.store_id, a.name, c.vehicle, c.is_on_duty, c.zone_id, z.name AS zone_name, "+
		"(SELECT count(*) FROM deliveries d WHERE d.courier_id = c.staff_id AND d.status = ANY($1)) AS active_count "+
		"FROM couriers c JOIN staff_accounts a ON a.id = c.staff_id AND a.is_active AND a.role = 'courier' "+
		"LEFT JOIN delivery_zones z ON z.id = c.zone_id WHERE ($2::integer IS NULL OR c.store_id = $2::integer) ORDER BY c.store_id, c.staff_id", activeStatuses, sid)
}

func courierPublic(r row) courierOut {
	out := courierOut{
		ID: r.i("id"), StoreID: r.i("store_id"), Name: r.s("name"), Vehicle: r.s("vehicle"), IsOnDuty: r.b("is_on_duty"), ActiveCount: r.i("active_count"),
	}
	if !r.isNull("zone_id") {
		out.Zone = &zoneRef{ID: r.i("zone_id"), Name: r.s("zone_name")}
	}
	return out
}

// suggestionForStore はその店の配達員（listCouriers の行）から、提案の先頭。提案できなければ nil。方針は ASSIGNMENT_POLICY。
func suggestionForStore(couriers []row, storeZoneID *int, matrix travelMatrix) *suggestionOut {
	if storeZoneID == nil {
		return nil
	}
	cands := make([]courierCandidate, len(couriers))
	for i, c := range couriers {
		cands[i] = courierCandidate{c.i("id"), c.s("name"), c.iN("zone_id"), c.i("active_count"), c.b("is_on_duty")}
	}
	ranked := getProposer(assignmentPolicy())(cands, *storeZoneID, matrix)
	if len(ranked) == 0 {
		return nil
	}
	top := ranked[0]
	return &suggestionOut{CourierID: top.courierID, CourierName: top.courierName, Minutes: top.minutes}
}
