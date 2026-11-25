package main

// 経路（backend/app/routes/*.py と main.py の移植）。FastAPI の評価の順に合わせる: 本文の JSON の構文 → 依存（認証）→ パス・クエリ・ヘッダー・本文の検査（まとめて 422）→ 処理。
// 登録の順も Python と同じにする（405 の Allow は、同じパスで最初に登録した方法）。

import (
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

// routes は全経路。登録の順は、Python の app.include_router の順（cart・orders・staff・analytics・宅配・chat）のあとに /health・/api/stores・/api/menu。
func (s *server) routes() {
	s.routesCart()
	s.routesOrders()
	s.routesStaff()
	s.routesAnalytics()
	s.routesDelivery()
	s.routesChat()
	s.route("/api/stores", on("GET", s.listStores))
	s.route("/api/menu", on("GET", s.menu))
}

var idempotencyKeyRe = regexp.MustCompile(`^[\x21-\x7e]+$`)

// idempotencyKey は Idempotency-Key ヘッダー（8〜64 文字の、空白を含まない ASCII）。
func (v *validation) idempotencyKey(r *http.Request) string {
	vals := r.Header.Values("Idempotency-Key")
	loc := []any{"header", "idempotency-key"}
	if len(vals) == 0 {
		v.issues = append(v.issues, issue{Type: "missing", Loc: loc, Msg: "Field required"})
		return ""
	}
	k := vals[0]
	n := utf8.RuneCountInString(k)
	switch {
	case n < idempotencyKeyMin:
		v.issues = append(v.issues, issue{Type: "string_too_short", Loc: loc, Msg: "String should have at least 8 characters", Input: k})
	case n > idempotencyKeyMax:
		v.issues = append(v.issues, issue{Type: "string_too_long", Loc: loc, Msg: "String should have at most 64 characters", Input: k})
	case !idempotencyKeyRe.MatchString(k):
		v.issues = append(v.issues, issue{Type: "string_pattern_mismatch", Loc: loc, Msg: "String should match pattern '^[\\x21-\\x7e]+$'", Input: k})
	default:
		return k
	}
	return ""
}

// ---- カート ----

func (s *server) routesCart() {
	s.route("/api/cart", on("GET", s.getCartH), on("PUT", s.putCartH), on("DELETE", s.deleteCartH))
	s.route("/api/cart/items/{variant_id}", on("PUT", s.putCartItemH))
	s.route("/api/cart/checkout-proposal", on("POST", s.checkoutProposalH))
}

func (s *server) getCartH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	out := inTx(func(t *tx) cartOut { return readCart(t, c.id, utcNow(), localNow()) })
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) putCartH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	c := currentCustomer(r)
	var v validation
	br := v.object(b)
	var storeID, addressID, slotID *int
	fulfillment := "pickup"
	if br != nil {
		if n, isNull := br.intField("store_id", intOpts{required: true, nullable: true, ge: i64(1)}); !isNull {
			x := int(n)
			storeID = &x
		}
		fulfillment = br.literalField("fulfillment", []string{"pickup", "delivery"}, false, "pickup")
		if n, isNull := br.intField("address_id", intOpts{nullable: true, ge: i64(1)}); !isNull {
			x := int(n)
			addressID = &x
		}
		if n, isNull := br.intField("slot_id", intOpts{nullable: true, ge: i64(1)}); !isNull {
			x := int(n)
			slotID = &x
		}
	}
	v.finish(br)
	out := inTx(func(t *tx) cartOut {
		return setCartStore(t, c.id, storeID, fulfillment, utcNow(), localNow(), addressID, slotID)
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) putCartItemH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	c := currentCustomer(r)
	var v validation
	variantID, _ := v.pathInt(r, "variant_id", 1)
	br := v.object(b)
	qty := int64(0)
	if br != nil {
		qty, _ = br.intField("qty", intOpts{required: true, ge: i64(0), le: i64(maxQty)})
	}
	v.finish(br)
	out := inTx(func(t *tx) cartOut { return setCartItem(t, c.id, int(variantID), int(qty), utcNow(), localNow()) })
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) deleteCartH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	out := inTx(func(t *tx) cartOut { return clearCart(t, c.id, utcNow(), localNow()) })
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) checkoutProposalH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	out := inTx(func(t *tx) proposalOut { return createProposal(t, c.id, utcNow(), localNow()) })
	writeJSON(w, http.StatusOK, out, nil)
}

// ---- 注文（顧客）----

func (s *server) routesOrders() {
	s.route("/api/orders", on("POST", s.createOrderH), on("GET", s.listOrdersH))
	s.route("/api/orders/{public_id}", on("GET", s.getOrderH))
	s.route("/api/orders/{public_id}/pay", on("POST", s.payOrderH))
	s.route("/api/orders/{public_id}/cancel", on("POST", s.cancelOrderH))
}

// createOrderH は確定。確定の API を呼べるのは画面の確定ボタンだけ（チャットには渡さない。docs/decisions/0003）。同じキー・同じ本文の再送は 200 で同じ注文。
func (s *server) createOrderH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	c := currentCustomer(r)
	var v validation
	key := v.idempotencyKey(r)
	br := v.object(b)
	proposalID := ""
	if br != nil {
		proposalID = br.uuidField("proposal_id")
	}
	v.finish(br)
	order, created := placeOrder(c.id, key, proposalID)
	status := http.StatusCreated
	if !created {
		status = http.StatusOK
	}
	writeJSON(w, status, order, nil)
}

func (s *server) listOrdersH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	writeJSON(w, http.StatusOK, listOrdersForCustomer(c.id), nil)
}

func (s *server) getOrderH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	var v validation
	id, _ := v.pathString(r, "public_id", 16)
	v.finish(nil)
	writeJSON(w, http.StatusOK, getOrderForCustomer(c.id, id), nil)
}

func (s *server) payOrderH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	c := currentCustomer(r)
	var v validation
	id, _ := v.pathString(r, "public_id", 16)
	br := v.optionalObject(b)
	simulate := "ok"
	if br != nil {
		simulate = br.literalField("simulate", []string{"ok", "decline"}, false, "ok")
	}
	v.finish(br)
	writeJSON(w, http.StatusOK, payOrder(c.id, id, simulate), nil)
}

func (s *server) cancelOrderH(w http.ResponseWriter, r *http.Request) {
	c := currentCustomer(r)
	var v validation
	id, _ := v.pathString(r, "public_id", 16)
	v.finish(nil)
	writeJSON(w, http.StatusOK, cancelByCustomer(c.id, id), nil)
}

// ---- スタッフ ----

func (s *server) routesStaff() {
	s.route("/api/staff/login", on("POST", s.staffLoginH))
	s.route("/api/staff/logout", on("POST", s.staffLogoutH))
	s.route("/api/staff/me", on("GET", s.staffMeH))
	s.route("/api/staff/orders", on("GET", s.staffOrdersH))
	s.route("/api/staff/orders/{public_id}/transition", on("POST", s.transitionH))
	s.route("/api/staff/stock", on("GET", s.stockH))
	s.route("/api/staff/stock/{item_id}/receive", on("POST", s.receiveH))
	s.route("/api/staff/stock/{item_id}/waste", on("POST", s.wasteH))
	s.route("/api/staff/stock/{item_id}/adjust", on("POST", s.adjustH))
}

var defaultStatuses = []string{"paid", "accepted", "preparing", "ready"}

// resolveStore はスタッフの見られる店を決める。店つきのスタッフ（店長も）は自店だけ（他店を指すと 404）。店が決まっていない店長は、store_id で選ぶ。
func resolveStore(staff staffUser, storeID *int, required bool) *int {
	if staff.storeID != nil {
		if storeID != nil && *storeID != *staff.storeID {
			fail(404, "not_found")
		}
		return staff.storeID
	}
	if storeID == nil && required {
		fail(422, "store_required")
	}
	return storeID
}

func requireStore(t *tx, storeID int) {
	if loadStore(t, storeID) == nil {
		fail(404, "store_not_found")
	}
}

func intPtr(p *int64) *int {
	if p == nil {
		return nil
	}
	x := int(*p)
	return &x
}

func (s *server) staffLoginH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	var v validation
	br := v.object(b)
	email, password := "", ""
	if br != nil {
		email, _ = br.strField("email", strOpts{required: true, min: 3, max: 254, safe: true})
		password, _ = br.strField("password", strOpts{required: true, min: 1, max: 200, safe: true})
	}
	v.finish(br)
	res := staffLogin(email, password)
	writeJSON(w, http.StatusOK, loginOut{Token: res.token, ExpiresAt: isoTime(res.expiresAt), Staff: res.staff.public()}, nil)
}

func (s *server) staffLogoutH(w http.ResponseWriter, r *http.Request) {
	currentStaff(r)
	a, ok := authorizationHeader(r)
	if token := bearer(a, ok); token != nil {
		staffLogout(*token)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) staffMeH(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, currentStaff(r).public(), nil)
}

func (s *server) staffOrdersH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	status := v.queryStringMax(r, "status", 200)
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	statuses := defaultStatuses
	if status != nil && *status != "" {
		statuses = nil
		for _, p := range strings.Split(*status, ",") {
			if p = pyStrip(p); p != "" {
				statuses = append(statuses, p)
			}
		}
	}
	if len(statuses) == 0 {
		fail(422, "invalid_status")
	}
	for _, st := range statuses {
		if !contains(staffVisibleStatuses, st) {
			fail(422, "invalid_status")
		}
	}
	writeJSON(w, http.StatusOK, listOrdersForStaff(resolveStore(staff, storeID, false), statuses), nil)
}

func (s *server) transitionH(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	staff := orderStaff(r)
	var v validation
	id, _ := v.pathString(r, "public_id", 16)
	br := v.object(b)
	action := ""
	var reason *string
	if br != nil {
		action = br.literalField("action", []string{"accept", "start", "ready", "complete", "cancel"}, true, "")
		if rs, isNull := br.strField("reason", strOpts{nullable: true, max: reasonMax, safe: true}); !isNull {
			reason = &rs
		}
	}
	v.finish(br)
	writeJSON(w, http.StatusOK, staffTransition(staff.id, staff.storeID, id, action, reason), nil)
}

func (s *server) stockH(w http.ResponseWriter, r *http.Request) {
	staff := orderStaff(r)
	var v validation
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	v.finish(nil)
	sid := *resolveStore(staff, storeID, true)
	expireStale()
	out := inTx(func(t *tx) []stockRowOut {
		requireStore(t, sid)
		return listStock(t, sid, nil)
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) stockChangeH(w http.ResponseWriter, r *http.Request, kind string) {
	b := readBody(r)
	staff := orderStaff(r)
	var v validation
	itemID, _ := v.pathInt(r, "item_id", 1)
	storeID := intPtr(v.queryInt(r, "store_id", i64(1), nil))
	br := v.object(b)
	var qty, delta int64
	var reason *string
	if br != nil {
		switch kind {
		case "receive":
			qty, _ = br.intField("qty", intOpts{required: true, ge: i64(1), le: i64(1_000_000)})
			if rs, isNull := br.strField("reason", strOpts{nullable: true, max: reasonMax, safe: true}); !isNull {
				reason = &rs
			}
		case "waste":
			qty, _ = br.intField("qty", intOpts{required: true, ge: i64(1), le: i64(1_000_000)})
			rs, _ := br.strField("reason", strOpts{required: true, min: 1, max: reasonMax, safe: true})
			reason = &rs
		case "adjust":
			delta, _ = br.intField("delta", intOpts{required: true, ge: i64(-1_000_000), le: i64(1_000_000)})
			rs, _ := br.strField("reason", strOpts{required: true, min: 1, max: reasonMax, safe: true})
			reason = &rs
		}
	}
	v.finish(br)
	// Python の順: adjust は delta == 0（台帳に残さない）→ 理由の空白 → 店の決定。waste は理由の空白 → 店の決定
	if kind == "adjust" && delta == 0 {
		fail(422, "invalid_delta")
	}
	var cleaned string
	if kind != "receive" {
		cleaned = pyStrip(*reason)
		if cleaned == "" {
			fail(422, "reason_required")
		}
	}
	sid := *resolveStore(staff, storeID, true)
	now := utcNow()
	actor := "staff:" + itoa(staff.id)
	out := inTx(func(t *tx) stockRowOut {
		requireStore(t, sid)
		if !stockItemExists(t, int(itemID)) {
			fail(404, "not_found")
		}
		var short *insufficientStock
		switch kind {
		case "receive":
			receiveStock(t, sid, int(itemID), int(qty), reason, actor, now)
		case "waste":
			short = wasteStock(t, sid, int(itemID), int(qty), cleaned, actor, now)
		case "adjust":
			short = adjustStock(t, sid, int(itemID), int(delta), cleaned, actor, now)
		}
		if short != nil {
			fail(409, "insufficient_stock")
		}
		return *stockRowFor(t, sid, int(itemID))
	})
	writeJSON(w, http.StatusOK, out, nil)
}

func (s *server) receiveH(w http.ResponseWriter, r *http.Request) { s.stockChangeH(w, r, "receive") }
func (s *server) wasteH(w http.ResponseWriter, r *http.Request)   { s.stockChangeH(w, r, "waste") }
func (s *server) adjustH(w http.ResponseWriter, r *http.Request)  { s.stockChangeH(w, r, "adjust") }
