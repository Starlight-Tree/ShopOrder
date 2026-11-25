package main

// 純粋な関数の単体テスト。期待値は、旧 Python の実測（testdata/unit_fixtures.json。入力はチャットのテスト・評価・場面から集めた 650 の文字列と、規則の境目の値）。
// DB は使わない。

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/unicode/norm"
)

type fixtures map[string]json.RawMessage

func loadFixtures(t *testing.T) fixtures {
	t.Helper()
	raw, err := os.ReadFile("testdata/unit_fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f fixtures) into(t *testing.T, key string, v any) {
	t.Helper()
	if err := json.Unmarshal(f[key], v); err != nil {
		t.Fatalf("%s: %v", key, err)
	}
}

// same は actual を JSON に直して読み戻し、expected と構造で比べる（数値は float64 に揃う）。
func same(t *testing.T, label string, actual, expected any) {
	t.Helper()
	b, err := json.Marshal(actual)
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	var a any
	if err := json.Unmarshal(b, &a); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, expected) {
		eb, _ := json.Marshal(expected)
		t.Errorf("%s:\n  Go    : %s\n  Python: %s", label, trunc(string(b)), trunc(string(eb)))
	}
}

func trunc(s string) string {
	if r := []rune(s); len(r) > 300 {
		return string(r[:300]) + "…"
	}
	return s
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func TestGuardrailsMatchPython(t *testing.T) {
	f := loadFixtures(t)
	var checkIn map[string]any
	var scrub map[string][]any
	var checkOut map[string][]any
	var leaks map[string]bool
	var normalized map[string][]string
	f.into(t, "check_input", &checkIn)
	f.into(t, "scrub", &scrub)
	f.into(t, "check_output", &checkOut)
	f.into(t, "leaks", &leaks)
	f.into(t, "normalize", &normalized)
	allowed := map[int64]bool{380: true, 450: true, 760: true, 1200: true, 2000: true, 0: true, 1: true, 2: true, 3: true, 500: true, 300: true}
	for s, want := range checkIn {
		same(t, "check_input "+trunc(s), nilIfEmpty(checkInput(s)), want)
	}
	for s, want := range scrub {
		same(t, "scrub "+trunc(s), []any{scrubUntrusted(s, 0), scrubUntrusted(s, 20)}, any(want))
	}
	for s, want := range checkOut {
		v := checkOutput(s, allowed, systemPrompt)
		same(t, "check_output "+trunc(s), []any{v.text, nilIfEmpty(v.reason)}, any(want))
	}
	for s, want := range leaks {
		if got := leaksSecret(s, systemPrompt, 24); got != want {
			t.Errorf("leaks %q: Go %v Python %v", trunc(s), got, want)
		}
	}
	for s, want := range normalized {
		n := normalizeGuard(s)
		same(t, "normalize "+trunc(s), []any{n, squash(n)}, []any{want[0], want[1]})
	}
}

func TestMockChatModelMatchesPython(t *testing.T) {
	f := loadFixtures(t)
	var segs map[string][][]any
	var intents map[string]map[string]string
	var ids map[string]any
	f.into(t, "segments", &segs)
	f.into(t, "intents", &intents)
	f.into(t, "order_ids", &ids)
	for s, want := range segs {
		var got []any
		for _, sg := range segmentsOf(s) {
			var size, temp, qty any
			if sg.size != "" {
				size = sg.size
			}
			if sg.temp != "" {
				temp = sg.temp
			}
			if sg.hasQty {
				qty = sg.qty
			}
			got = append(got, []any{sg.core, size, temp, qty, sg.additive})
		}
		if got == nil {
			got = []any{}
		}
		w := make([]any, len(want))
		for i, x := range want {
			w[i] = any(x)
		}
		same(t, "segments "+trunc(s), got, w)
	}
	views := map[string]func(text string) *mockView{
		"empty": func(x string) *mockView {
			return &mockView{text: x, cart: map[string]any{"lines": []any{}, "total_lumi": 0, "version": 1}}
		},
		"cart": func(x string) *mockView {
			return &mockView{text: x, cart: map[string]any{"lines": []any{map[string]any{"variant_id": 1, "qty": 1}}, "total_lumi": 380, "version": 2}}
		},
		"confirm": func(x string) *mockView {
			return &mockView{text: x, cart: map[string]any{"lines": []any{map[string]any{"variant_id": 1, "qty": 1}}, "total_lumi": 380, "version": 2}, prevCards: []string{"confirm"}}
		},
		"repeat": func(x string) *mockView {
			return &mockView{text: x, cart: map[string]any{"lines": []any{}, "total_lumi": 0, "version": 1}, prevText: repeatMark + "。番号でお選びください。"}
		},
	}
	for s, byView := range intents {
		for name, want := range byView {
			if got := mockIntent(views[name](norm.NFKC.String(s))); got != want {
				t.Errorf("intent %q [%s]: Go %s Python %s", trunc(s), name, got, want)
			}
		}
	}
	for s, want := range ids {
		got, ok := findOrderID(strings.ToUpper(s))
		var g any
		if ok {
			g = got
		}
		same(t, "order id "+trunc(s), g, want)
	}
}

type pyPeriod struct {
	Start       string `json:"start"`
	End         string `json:"end"`
	OpenDays    int    `json:"open_days"`
	MissingDays int    `json:"missing_days"`
	SalesLumi   int    `json:"sales_lumi"`
}

func (p pyPeriod) toPeriod() period {
	s, _ := parseDate(p.Start)
	e, _ := parseDate(p.End)
	return period{start: s, end: e, openDays: p.OpenDays, missingDays: p.MissingDays, salesLumi: p.SalesLumi}
}

func TestAnalyticsRulesMatchPython(t *testing.T) {
	f := loadFixtures(t)
	var abc [][]json.RawMessage
	f.into(t, "abc", &abc)
	for _, c := range abc {
		var sales []int
		json.Unmarshal(c[0], &sales)
		var want []map[string]any
		json.Unmarshal(c[1], &want)
		var got []map[string]any
		for _, r := range abcTable(sales) {
			got = append(got, map[string]any{"share_pct": r.sharePct, "cum_share_pct": r.cumSharePct, "abc": r.klass})
		}
		if got == nil {
			got = []map[string]any{}
		}
		same(t, fmt.Sprintf("abc %v", sales), got, anySlice(want))
	}
	var sup [][]json.RawMessage
	f.into(t, "suppress", &sup)
	for _, c := range sup {
		var in map[string]int
		json.Unmarshal(c[0], &in)
		var want map[string]any
		json.Unmarshal(c[1], &want)
		var cells []cellKV
		for _, k := range sortedMapKeys(in) {
			cells = append(cells, cellKV{k, in[k]})
		}
		got := suppressCells(cells, minCell)
		gm := map[string]any{}
		for k, v := range got {
			if v == nil {
				gm[k] = nil
			} else {
				gm[k] = *v
			}
		}
		same(t, fmt.Sprintf("suppress %v", in), gm, want)
	}
	var ranges [][]any
	f.into(t, "ranges", &ranges)
	for _, r := range ranges {
		today, _ := parseDate(r[0].(string))
		grain, count := r[1].(string), int(r[2].(float64))
		s, e := lastCompleteRange(grain, count, today)
		ps, pe := previousRange(s, e, grain)
		same(t, fmt.Sprintf("range %v", r[:3]), []any{s.String(), e.String(), ps.String(), pe.String()}, r[3:])
	}
	var buckets [][]json.RawMessage
	f.into(t, "buckets", &buckets)
	for _, b := range buckets {
		var grain string
		json.Unmarshal(b[0], &grain)
		var pts []struct {
			Date       string `json:"date"`
			SalesLumi  *int   `json:"sales_lumi"`
			Orders     *int   `json:"orders"`
			OpenStores int    `json:"open_stores"`
			State      string `json:"state"`
		}
		json.Unmarshal(b[1], &pts)
		var points []dayPoint
		for _, p := range pts {
			d, _ := parseDate(p.Date)
			points = append(points, dayPoint{date: d, salesLumi: p.SalesLumi, orders: p.Orders, openStores: p.OpenStores, state: p.State})
		}
		var got []map[string]any
		for _, x := range bucketPoints(points, grain) {
			got = append(got, map[string]any{"start": x.start.String(), "sales_lumi": ptrVal(x.salesLumi), "orders": ptrVal(x.orders), "open_days": x.openDays, "state": x.state})
		}
		var want []map[string]any
		json.Unmarshal(b[2], &want)
		same(t, "buckets "+grain, got, anySlice(want))
	}
	var cmps [][]json.RawMessage
	f.into(t, "comparison", &cmps)
	for i, c := range cmps {
		var cur, prev pyPeriod
		json.Unmarshal(c[0], &cur)
		json.Unmarshal(c[1], &prev)
		var want map[string]any
		json.Unmarshal(c[2], &want)
		got := comparison(cur.toPeriod(), prev.toPeriod())
		gm := map[string]any{"state": got.State}
		if got.PreviousSalesLumi != nil {
			gm["previous_sales_lumi"] = *got.PreviousSalesLumi
		}
		if got.ChangePct != nil {
			gm["change_pct"] = float64(*got.ChangePct)
		}
		if got.Reason != nil {
			gm["reason"] = *got.Reason // message は、Python では呼ぶ側（sales_series）が足す。Go は comparison が付ける
		}
		same(t, fmt.Sprintf("comparison %d", i), gm, want)
	}
	var rfm [][]any
	f.into(t, "rfm", &rfm)
	for _, r := range rfm {
		in := func(i int) int { return int(r[i].(float64)) }
		rs, fs, ms := rScore(in(0)), fScore(in(1)), mScore(in(2))
		if rs != in(3) || fs != in(4) || ms != in(5) || segmentOf(rs, fs) != r[6].(string) {
			t.Errorf("rfm %v: Go %d %d %d %s", r, rs, fs, ms, segmentOf(rs, fs))
		}
	}
	var waste map[string]string
	f.into(t, "waste", &waste)
	for s, want := range waste {
		if got := wasteReasonCode(s); got != want {
			t.Errorf("waste %q: Go %s Python %s", s, got, want)
		}
	}
	var ps struct {
		Key         string
		Ids         [][]any
		Fingerprint string
	}
	f.into(t, "pseudonym", &ps)
	for _, id := range ps.Ids {
		if got := pseudonymID([]byte(ps.Key), int(id[0].(float64))); got != id[1].(string) {
			t.Errorf("pseudonym %v: Go %s", id[0], got)
		}
	}
	if got := keyFingerprint([]byte(ps.Key)); got != ps.Fingerprint {
		t.Errorf("fingerprint: Go %s Python %s", got, ps.Fingerprint)
	}
}

func ptrVal(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func anySlice(m []map[string]any) []any {
	out := make([]any, len(m))
	for i, x := range m {
		out[i] = x
	}
	return out
}

func sortedMapKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortStrings(keys)
	return keys
}

func parseClock(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, _ = time.Parse("2006-01-02T15:04:05-07:00", s)
	}
	return t
}

func TestDeliveryRulesMatchPython(t *testing.T) {
	f := loadFixtures(t)
	var grid [][]any
	f.into(t, "slot_grid", &grid)
	for _, g := range grid {
		open, close_ := g[0].(string)+"", g[1].(string)+""
		slots := slotGrid(open, close_, int(g[2].(float64)), dateOnly{2026, 11, 27}, int(g[3].(float64)))
		var got []any
		for _, s := range slots {
			got = append(got, []any{pyISOUTC(s.start), pyISOUTC(s.end)})
		}
		if got == nil {
			got = []any{}
		}
		same(t, fmt.Sprintf("slot_grid %v", g[:4]), got, g[4])
	}
	var reasons [][]any
	f.into(t, "slot_reason", &reasons)
	for _, r := range reasons {
		starts := parseClock(r[0].(string))
		now := parseClock(r[3].(string))
		got := slotUnavailableReason(starts, int(r[1].(float64)), int(r[2].(float64)), now)
		var g any
		if got != nil {
			g = *got
		}
		same(t, fmt.Sprintf("slot_reason %v", r[:4]), g, r[4])
	}
	var fees [][]any
	f.into(t, "fees", &fees)
	for _, r := range fees {
		var free *int
		if r[1] != nil {
			v := int(r[1].(float64))
			free = &v
		}
		if got := deliveryFee(int(r[0].(float64)), free, int(r[2].(float64))); got != int(r[3].(float64)) {
			t.Errorf("fee %v: Go %d", r, got)
		}
	}
	var etas [][]any
	f.into(t, "eta", &etas)
	for _, r := range etas {
		starts := parseClock(r[1].(string))
		var dep *time.Time
		if r[2].(bool) {
			d := time.Date(2026, 11, 27, 3, 20, 0, 0, time.UTC)
			dep = &d
		}
		got := etaAt(r[0].(string), starts, dep, int(r[3].(float64)))
		var g any
		if got != nil {
			g = pyISOUTC(*got)
		}
		same(t, fmt.Sprintf("eta %v", r), g, r[4])
	}
	var pins [][]any
	f.into(t, "pins", &pins)
	for _, r := range pins {
		secret, id, nonce := r[0].(string), int(r[1].(float64)), r[2].(string)
		pin := derivePin(secret, id, nonce)
		if pin != r[3].(string) || pinHash(secret, id, pin) != r[4].(string) {
			t.Errorf("pin %v: Go %s", r[:3], pin)
		}
		if !pinMatches(secret, id, pin, r[4].(string)) || pinMatches(secret, id, "x"+pin, r[4].(string)) {
			t.Errorf("pinMatches %v", r[:3])
		}
	}
	var near [][]any
	f.into(t, "nearest", &near)
	mat := travelMatrix{{1, 2}: 10, {2, 1}: 10, {2, 3}: 15, {3, 2}: 15, {1, 3}: 20, {3, 1}: 20}
	zone := func(v int) *int { return &v }
	cands := []courierCandidate{{1, "a", nil, 0, true}, {2, "b", zone(3), 1, true}, {3, "c", zone(1), 0, true}, {4, "d", zone(2), 2, false}, {5, "e", zone(2), 0, true}}
	for _, r := range near {
		var got []any
		for _, p := range nearest(cands, int(r[0].(float64)), mat) {
			got = append(got, []any{p.courierID, p.minutes})
		}
		same(t, fmt.Sprintf("nearest %v", r[0]), got, r[1])
	}
}

// pyISOUTC は Python の datetime.isoformat()（UTC。+00:00 つき）。
func pyISOUTC(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05") + "+00:00"
}

func TestStoreRulesMatchPython(t *testing.T) {
	f := loadFixtures(t)
	var closed [][]json.RawMessage
	f.into(t, "closed_reason", &closed)
	for _, c := range closed {
		var check string
		json.Unmarshal(c[0], &check)
		var st map[string]any
		json.Unmarshal(c[1], &st)
		var closure bool
		json.Unmarshal(c[2], &closure)
		var nowS string
		json.Unmarshal(c[3], &nowS)
		var want any
		json.Unmarshal(c[4], &want)
		t.Setenv("ORDER_HOURS_CHECK", check)
		store := row{"mobile_order": st["mobile_order"], "open_time": st["open_time"], "close_time": st["close_time"], "last_order_minutes": int64(st["last_order_minutes"].(float64))}
		if cw, ok := st["closed_weekday"].(float64); ok {
			store["closed_weekday"] = int16(cw)
		}
		now := parseClock(nowS)
		got := closedReason(store, closure, now.In(localZone(9)))
		var g any
		if got != nil {
			g = *got
		}
		same(t, fmt.Sprintf("closed_reason %s %v %s", check, st, nowS), g, want)
	}
	var seasons [][]any
	f.into(t, "in_season", &seasons)
	for _, r := range seasons {
		var from, to *string
		if r[1] != nil {
			v := r[1].(string)
			from = &v
		}
		if r[2] != nil {
			v := r[2].(string)
			to = &v
		}
		if got := inSeason(r[0].(string), from, to); got != r[3].(bool) {
			t.Errorf("in_season %v: Go %v", r, got)
		}
	}
	var items [][]any
	f.into(t, "item_reason", &items)
	for _, r := range items {
		t.Setenv("ORDER_HOURS_CHECK", r[0].(string))
		item := row{"is_active": r[1].(bool)}
		if r[2] != nil {
			item["season_from"] = r[2].(string)
			item["season_to"] = r[3].(string)
		}
		if r[4] != nil {
			item["sold_from"] = r[4].(string)
		}
		if r[5] != nil {
			item["sold_until"] = r[5].(string)
		}
		got := itemUnavailableReason(item, parseClock(r[6].(string)).In(localZone(9)))
		var g any
		if got != nil {
			g = *got
		}
		same(t, fmt.Sprintf("item_reason %v", r[:7]), g, r[7])
	}
}

func TestPyRoundMatchesPython(t *testing.T) {
	f := loadFixtures(t)
	var r1, r0 [][]float64
	f.into(t, "round1", &r1)
	f.into(t, "round0", &r0)
	for _, r := range r1 {
		if got := pyRound(r[0], 1); got != r[1] {
			t.Errorf("round(%v, 1): Go %v Python %v", r[0], got, r[1])
		}
	}
	for _, r := range r0 {
		if got := pyRoundInt(r[0]); float64(got) != r[1] {
			t.Errorf("round(%v): Go %v Python %v", r[0], got, r[1])
		}
	}
}

func TestPyFloatJSON(t *testing.T) {
	for in, want := range map[float64]string{12: "12.0", 0: "0.0", 12.5: "12.5", 100: "100.0", 0.1: "0.1", -3: "-3.0"} {
		b, _ := json.Marshal(pyFloat(in))
		if string(b) != want {
			t.Errorf("pyFloat(%v) = %s want %s", in, b, want)
		}
	}
}

func TestDisposableTargetGuard(t *testing.T) {
	good := "postgresql://postgres:pw@test-db:5432/postgres"
	if err := assertDisposableTarget(good, "shop_order_test"); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ url, name string }{
		{"", "shop_order_test"},
		{"postgresql://u@db:5432/x", "shop_order_test"},           // 開発用のホスト
		{"postgresql://u@evil.example:5432/x", "shop_order_test"}, // 許可リストにないホスト
		{good, "shoporder"},                                       // 開発用の DB 名
		{good, "postgres"},                                        // 管理用の DB 名
		{good, "shop_order_Test"},                                 // 大文字
		{good, "shop_order_test; DROP"},                           // 注入
		{good + "?host=db", "shop_order_test"},                    // 接続先を上書きする項目
		{"mysql://u@test-db/x", "shop_order_test"},                // 別のスキーム
		{"postgresql://u@test-db:5432/x?dbname=shoporder", "shop_order_x"},
	} {
		if err := assertDisposableTarget(c.url, c.name); err == nil {
			t.Errorf("通ってはいけない: %q %q", c.url, c.name)
		}
	}
	if u, err := urlWithDatabase(good+"?sslmode=disable", "shop_order_e2e"); err != nil || !strings.HasSuffix(u, "/shop_order_e2e?sslmode=disable") {
		t.Errorf("urlWithDatabase: %q %v", u, err)
	}
}
