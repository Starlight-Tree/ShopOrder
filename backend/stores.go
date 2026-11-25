package main

// 店の読み取りと、「今、注文を受けられるか」の判定（backend/app/stores.py と main.py の /api/stores・/api/menu の移植）。

import (
	"net/http"
	"time"
)

const storeColumns = "id, code, name, area_code, address, open_time::text AS open_time, close_time::text AS close_time, closed_weekday, last_order_minutes, mobile_order, seats"

func loadStore(t *tx, storeID int) row {
	return t.one("SELECT "+storeColumns+" FROM stores WHERE id = $1", storeID)
}

// closedStoreIDs は今日（ローカルの日付）に臨時休業の店。
func closedStoreIDs(t *tx, nowLocal time.Time) map[int]bool {
	out := map[int]bool{}
	for _, r := range t.all("SELECT store_id FROM store_closures WHERE date = $1", dateOf(nowLocal).String()) {
		out[r.i("store_id")] = true
	}
	return out
}

func storeClosedReason(t *tx, store row, nowLocal time.Time) *string {
	return closedReason(store, closedStoreIDs(t, nowLocal)[store.i("id")], nowLocal)
}

const menuItemSQL = "SELECT id, code, name, category, description, allergens, season_from, season_to, sold_from::text AS sold_from, sold_until::text AS sold_until, is_active " +
	"FROM menu_items WHERE is_active ORDER BY sort, id"

const menuVariantSQL = "SELECT v.id, v.item_id, v.size, v.temperature, v.price_lumi FROM menu_variants v " +
	"JOIN menu_items i ON i.id = v.item_id WHERE i.is_active ORDER BY v.item_id, v.price_lumi, v.id"

func (s *server) listStores(w http.ResponseWriter, r *http.Request) {
	nowLocal := localNow()
	var out []storeOut
	withTx(func(t *tx) {
		rows := t.all("SELECT s.id, s.code, s.name, a.name AS area, s.address, s.open_time::text AS open_time, s.close_time::text AS close_time, s.closed_weekday, " +
			"s.last_order_minutes, s.mobile_order, s.seats FROM stores s JOIN areas a ON a.code = s.area_code ORDER BY a.sort, s.id")
		closures := closedStoreIDs(t, nowLocal)
		for _, rw := range rows {
			reason := closedReason(rw, closures[rw.i("id")], nowLocal)
			out = append(out, storeOut{
				ID: rw.i("id"), Code: rw.s("code"), Name: rw.s("name"), Area: rw.s("area"), Address: rw.s("address"),
				OpenTime: hhmm(rw.s("open_time")), CloseTime: hhmm(rw.s("close_time")), ClosedWeekday: rw.iN("closed_weekday"),
				LastOrderMinutes: rw.i("last_order_minutes"), MobileOrder: rw.b("mobile_order"), Seats: rw.i("seats"),
				AcceptingOrders: reason == nil, ClosedReason: reason,
			})
		}
	})
	writeJSON(w, http.StatusOK, emptyIfNil(out), nil)
}

// menu は有効な品を、並び順に。各変種に「今出せるか」を付ける（store_id があれば、その店の在庫も。無ければ在庫は見ない）。
func (s *server) menu(w http.ResponseWriter, r *http.Request) {
	var v validation
	storeID := v.queryInt(r, "store_id", i64(1), nil)
	if e := v.err(); e != nil {
		panic(e)
	}
	nowLocal := localNow()
	var out []menuItemOut
	withTx(func(t *tx) {
		items := t.all(menuItemSQL)
		variants := t.all(menuVariantSQL)
		var stock map[int][]stockPair
		if storeID != nil {
			if loadStore(t, int(*storeID)) == nil {
				fail(404, "store_not_found")
			}
			ids := make([]int, len(variants))
			for i, vr := range variants {
				ids[i] = vr.i("id")
			}
			stock = variantStock(t, int(*storeID), ids)
		}
		reasons := map[int]*string{}
		for _, it := range items {
			reasons[it.i("id")] = itemUnavailableReason(it, nowLocal)
		}
		byItem := map[int][]variantOut{}
		for _, vr := range variants {
			reason := reasons[vr.i("item_id")]
			if reason == nil && stock != nil && isSoldOut(stock[vr.i("id")], 1) {
				reason = ptr("sold_out")
			}
			byItem[vr.i("item_id")] = append(byItem[vr.i("item_id")], variantOut{
				ID: vr.i("id"), Size: vr.s("size"), Temperature: vr.s("temperature"), PriceLumi: vr.i("price_lumi"),
				Available: reason == nil, UnavailableReason: reason,
			})
		}
		for _, it := range items {
			out = append(out, menuItemOut{
				ID: it.i("id"), Code: it.s("code"), Name: it.s("name"), Category: it.s("category"), Description: it.s("description"),
				Allergens: emptyIfNil(it.strs("allergens")), SeasonFrom: it.sN("season_from"), SeasonTo: it.sN("season_to"),
				SoldFrom: hhmmPtr(it.sN("sold_from")), SoldUntil: hhmmPtr(it.sN("sold_until")), Variants: emptyIfNil(byItem[it.i("id")]),
			})
		}
	})
	writeJSON(w, http.StatusOK, emptyIfNil(out), nil)
}
