package main

// 分析（P4）の API（backend/app/routes/analytics.py の移植）。店長は全店（?store_id= で 1 店に絞れる）、店舗スタッフは自店の売上・在庫だけ。
// 顧客・配達員は使えない（顧客は 401、配達員は 403）。顧客の分析（RFM・コホート）は、全店の店長だけ（店舗スタッフと、店に属する店長は 403）。

import (
	"net/http"
)

var (
	countDefault = map[string]int{"day": 28, "week": 12, "month": 3}
	countMax     = map[string]int{"day": 90, "week": 26, "month": 12}
)

// analyticsScope は見られる店を決める。店つきのアカウントは自店だけ（他店は 404）。店の無い店長は、store_id で絞れる（無ければ全店）。
func analyticsScope(t *tx, staff staffUser, storeID *int) *int {
	sid := resolveStore(staff, storeID, false)
	if sid != nil && loadStore(t, *sid) == nil {
		fail(404, "store_not_found")
	}
	return sid
}

func analyticsToday() dateOnly { return dateOf(localNow()) }

func (s *server) routesAnalytics() {
	s.route("/api/analytics/overview", on("GET", s.overviewH))
	s.route("/api/analytics/sales", on("GET", s.salesH))
	s.route("/api/analytics/products", on("GET", s.productsH))
	s.route("/api/analytics/hourly", on("GET", s.hourlyH))
	s.route("/api/analytics/stock", on("GET", s.analyticsStockH))
	s.route("/api/analytics/customers", on("GET", s.customersH))
}

func (s *server) overviewH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	out := inTx(func(t *tx) overviewOut {
		sid := analyticsScope(t, staff, storeID)
		o := analyticsOverview(t, sid, analyticsToday())
		o.Scope = scopeInfo(t, sid)
		return o
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) salesH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	grain := "day"
	if vals, ok := r.URL.Query()["grain"]; ok {
		if !contains([]string{"day", "week", "month"}, vals[0]) {
			v.addQuery("literal_error", "grain", "Input should be 'day', 'week' or 'month'", vals[0])
		} else {
			grain = vals[0]
		}
	}
	countP := intPtr(v.queryInt(r, "count", i64(1), i64(90)))
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	n := countDefault[grain]
	if countP != nil && *countP != 0 {
		n = *countP
	}
	if n > countMax[grain] {
		n = countMax[grain]
	}
	out := inTx(func(t *tx) salesSeriesOut {
		sid := analyticsScope(t, staff, storeID)
		o := analyticsSales(t, sid, analyticsToday(), grain, n)
		o.Scope = scopeInfo(t, sid)
		return o
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) productsH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	days := 28
	if p := intPtr(v.queryInt(r, "days", i64(7), i64(90))); p != nil {
		days = *p
	}
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	out := inTx(func(t *tx) productsOut {
		sid := analyticsScope(t, staff, storeID)
		o := analyticsProducts(t, sid, analyticsToday(), days)
		o.Scope = scopeInfo(t, sid)
		return o
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) hourlyH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	days := 28
	if p := intPtr(v.queryInt(r, "days", i64(7), i64(90))); p != nil {
		days = *p
	}
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	out := inTx(func(t *tx) hourlyOut {
		sid := analyticsScope(t, staff, storeID)
		o := analyticsHourly(t, sid, analyticsToday(), days)
		o.Scope = scopeInfo(t, sid)
		return o
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) analyticsStockH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	out := inTx(func(t *tx) analyticsStockOut {
		sid := analyticsScope(t, staff, storeID)
		o := analyticsStock(t, sid, analyticsToday())
		o.Scope = scopeInfo(t, sid)
		return o
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) customersH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	if staff.role != "manager" || staff.storeID != nil {
		fail(403, "forbidden") // 顧客の分析は、全店の店長だけ（顧客全体の集計で、店に分けられない）
	}
	writeJSON(w, http.StatusOK, inTx(func(t *tx) customersOut { return analyticsCustomers(t, analyticsToday()) }), nil)
}
