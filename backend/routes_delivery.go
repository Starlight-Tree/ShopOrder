package main

// 宅配のルート（住所・区画・時間枠・配車・配達員。backend/app/routes/delivery.py の移植）。契約は docs/api.md「宅配（P2）」。
// 住所（line・note）は個人情報。ログに出さない（このファイルは、本文を一切ログに出さない）。

import (
	"net/http"
	"regexp"
	"strconv"
)

var defaultDispatchStatuses = []string{"ready", "assigned", "picked_up", "delivering", "delivery_failed"}

func (s *server) routesDelivery() {
	s.route("/api/addresses", on("GET", s.listAddressesH), on("POST", s.createAddressH))
	s.route("/api/addresses/{address_id}", on("DELETE", s.deleteAddressH))
	s.route("/api/delivery/zones", on("GET", s.zonesH))
	s.route("/api/stores/{store_id}/slots", on("GET", s.slotsH))
	s.route("/api/staff/couriers", on("GET", s.couriersH))
	s.route("/api/staff/deliveries", on("GET", s.deliveriesH))
	s.route("/api/staff/orders/{public_id}/assign", on("POST", s.assignH))
	s.route("/api/staff/orders/{public_id}/redeliver", on("POST", s.redeliverH))
	s.route("/api/staff/orders/{public_id}/mock-advance", on("POST", s.mockAdvanceH))
	s.route("/api/staff/zones/{zone_id}/suspension", on("PUT", s.suspensionH))
	s.route("/api/courier/deliveries", on("GET", s.myDeliveriesH))
	s.route("/api/courier/deliveries/{public_id}/pickup", on("POST", s.courierPostH("pickup")))
	s.route("/api/courier/deliveries/{public_id}/depart", on("POST", s.courierPostH("depart")))
	s.route("/api/courier/deliveries/{public_id}/deliver", on("POST", s.courierPostH("deliver")))
	s.route("/api/courier/deliveries/{public_id}/fail", on("POST", s.courierPostH("fail")))
}

func (s *server) listAddressesH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	writeJSON(w, http.StatusOK, inTx(func(t *tx) []addressOut { return listAddresses(t, c.id) }), nil)
}

func (s *server) createAddressH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	c := currentCustomer(r)
	var v validation
	br := v.object(b)
	var label, line string
	var areaCode int64
	var note *string
	if br != nil {
		label, _ = br.strField("label", strOpts{required: true, strip: true, min: 1, max: 20, safe: true})
		areaCode, _ = br.intField("area_code", intOpts{required: true, ge: i64(1), le: i64(99)})
		line, _ = br.strField("line", strOpts{required: true, strip: true, min: 1, max: 100, safe: true})
		if n, isNull := br.strField("note", strOpts{nullable: true, strip: true, max: 100, safe: true}); !isNull && n != "" {
			note = &n // body.note or None
		}
	}
	v.finish(br)
	out := inTx(func(t *tx) addressOut { return createAddress(t, c.id, label, int(areaCode), line, note, utcNow()) })
	writeJSON(w, http.StatusCreated, out, nil)
}

func (s *server) deleteAddressH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	var v validation
	id, _ := v.pathInt(r, "address_id", 1)
	v.finish(nil)
	withTx(func(t *tx) { deleteAddress(t, c.id, int(id), utcNow()) })
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) zonesH(w http.ResponseWriter, r *http.Request) {
	var v validation
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	out := inTx(func(t *tx) []zoneOut {
		if storeID != nil && loadStore(t, *storeID) == nil {
			fail(404, "store_not_found")
		}
		return listZones(t, storeID)
	})
	writeJSON(w, http.StatusOK, out, nil)
}

var isoDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (s *server) slotsH(w http.ResponseWriter, r *http.Request) {
	var v validation
	storeID, _ := v.pathInt(r, "store_id", 1)
	var day dateOnly
	if vals, ok := r.URL.Query()["date"]; !ok {
		v.addQuery("missing", "date", "Field required", nil)
	} else if d, ok := parseDate(vals[0]); !ok || !isoDateRe.MatchString(vals[0]) {
		v.addQuery("date_from_datetime_parsing", "date", "Input should be a valid date or datetime, "+dateParseReason(vals[0]), vals[0])
	} else {
		day = d
	}
	zoneID := intPtr(v.queryInt(r, "zone_id", i64(1), nil))
	v.finish(nil)
	now := utcNow()
	out := inTx(func(t *tx) slotListOut {
		store := loadStore(t, int(storeID))
		if store == nil {
			fail(404, "store_not_found")
		}
		return listSlots(t, store, day, zoneID, now)
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) couriersH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	writeJSON(w, http.StatusOK, listCourierOuts(resolveStore(staff, storeID, false)), nil)
}

func (s *server) deliveriesH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	status := v.queryStringMax(r, "status", 200)
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	statuses := defaultDispatchStatuses
	if status != nil && *status != "" {
		statuses = nil
		for _, p := range splitComma(*status) {
			statuses = append(statuses, p)
		}
	}
	if len(statuses) == 0 {
		fail(422, "invalid_status")
	}
	for _, st := range statuses {
		if !contains(allStatuses, st) {
			fail(422, "invalid_status")
		}
	}
	writeJSON(w, http.StatusOK, dispatchBoard(resolveStore(staff, storeID, false), statuses), nil)
}

func splitComma(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			if p := pyStrip(s[start:i]); p != "" {
				out = append(out, p)
			}
			start = i + 1
		}
	}
	return out
}

func (s *server) assignH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	staff := orderStaff(r)
	var v validation
	id, _ := v.pathString(r, "public_id", 16)
	br := v.object(b)
	courierID := int64(0)
	if br != nil {
		courierID, _ = br.intField("courier_id", intOpts{required: true, ge: i64(1)})
	}
	v.finish(br)
	writeJSON(w, http.StatusOK, assignOrder(staff, id, int(courierID)), nil)
}

func (s *server) redeliverH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	staff := orderStaff(r)
	var v validation
	id, _ := v.pathString(r, "public_id", 16)
	br := v.optionalObject(b)
	var slotID *int
	if br != nil {
		if n, isNull := br.intField("slot_id", intOpts{nullable: true, ge: i64(1)}); !isNull {
			x := int(n)
			slotID = &x
		}
	}
	v.finish(br)
	writeJSON(w, http.StatusOK, redeliverOrder(staff, id, slotID), nil)
}

func (s *server) mockAdvanceH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	id, _ := v.pathString(r, "public_id", 16)
	v.finish(nil)
	writeJSON(w, http.StatusOK, mockAdvance(staff, id), nil)
}

// suspensionH は砂嵐の警報を立てる・解除する（店長だけ）。
func (s *server) suspensionH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	managerStaff(r)
	var v validation
	zoneID, _ := v.pathInt(r, "zone_id", 1)
	br := v.object(b)
	suspended := false
	if br != nil {
		suspended = br.boolField("suspended", true, false)
	}
	v.finish(br)
	out := inTx(func(t *tx) zoneOut { return setSuspension(t, int(zoneID), suspended, utcNow()) })
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) myDeliveriesH(w http.ResponseWriter, r *http.Request) {
	courier := courierStaff(r)
	writeJSON(w, http.StatusOK, courierDeliveries(courier), nil)
}

var pinRe = regexp.MustCompile(`^[0-9]{4}$`)

func (s *server) courierPostH(action string) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b jsonBody
		if action == "deliver" || action == "fail" {
			b = readBody(r)
		}
		courier := courierStaff(r)
		var v validation
		id, _ := v.pathString(r, "public_id", 16)
		pin, reason := "", ""
		var br *bodyReader
		if action == "deliver" || action == "fail" {
			br = v.object(b)
			if br != nil {
				if action == "deliver" {
					pin, _ = br.strField("pin", strOpts{required: true, pattern: pinRe})
				} else {
					reason = br.literalField("reason", []string{"absent", "cannot_receive", "other"}, true, "")
				}
			}
		}
		v.finish(br)
		writeJSON(w, http.StatusOK, courierAction(courier, id, action, pin, reason), nil)
	}
}

// dateParseReason は pydantic（speedate）の、日付の読み取りの誤りの説明（よくある場合だけ）。
func dateParseReason(s string) string {
	r := []rune(s)
	if len(r) < 10 {
		return "input is too short"
	}
	digits := func(from, to int) bool {
		for _, c := range r[from:to] {
			if c < '0' || c > '9' {
				return false
			}
		}
		return true
	}
	switch {
	case !digits(0, 4):
		return "invalid character in year"
	case r[4] != '-':
		return "invalid date separator, expected `-`"
	case !digits(5, 7):
		return "invalid character in month"
	case r[7] != '-':
		return "invalid date separator, expected `-`"
	case !digits(8, 10):
		return "invalid character in day"
	}
	m, _ := strconv.Atoi(string(r[5:7]))
	if m < 1 || m > 12 {
		return "month value is outside expected range of 1-12"
	}
	if len(r) > 10 {
		return "unexpected extra characters at the end of the input"
	}
	return "day value is outside expected range"
}
