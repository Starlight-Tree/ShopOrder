package main

// 分析の読み取り（API が呼ぶ薄い層。backend/app/analytics_queries.py と analytics_schemas.py の移植）。確定した日は analytics の日次集計表を読むだけ。
// 当日だけ、元データ（analytics のビュー）から都度。指標の定義は docs/metrics.md。店の範囲（store_id）の権限の確認は、呼ぶ側（routes_analytics.go）。
// 顧客の人数のセルは、5 人未満を出さない（suppressCells）。顧客は仮名 ID だけを読む（仮名 ID と users の対応の表は読まない）。

import "sort"

var inProgressStatuses = []string{"paid", "accepted", "preparing", "ready", "assigned", "picked_up", "delivering"}

type scopeOut struct {
	AllStores bool    `json:"all_stores"`
	StoreID   *int    `json:"store_id"`
	StoreName *string `json:"store_name"`
}

func scopeInfo(t *tx, storeID *int) scopeOut {
	if storeID == nil {
		return scopeOut{AllStores: true}
	}
	r := t.one("SELECT name FROM stores WHERE id = $1", *storeID)
	var name *string
	if r != nil {
		name = r.sN("name")
	}
	return scopeOut{AllStores: false, StoreID: storeID, StoreName: name}
}

func optInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func avgTicket(sales, orders int) *int {
	if orders == 0 {
		return nil
	}
	v := pyRoundInt(float64(sales) / float64(orders))
	return &v
}

// ---- 今日の概況（当日は元データから）----

type yesterdayOut struct {
	BusinessDate  string `json:"business_date"`
	State         string `json:"state"`
	SalesLumi     *int   `json:"sales_lumi"`
	Orders        *int   `json:"orders"`
	AvgTicketLumi *int   `json:"avg_ticket_lumi"`
}

type overviewOut struct {
	Scope         scopeOut     `json:"scope"`
	BusinessDate  string       `json:"business_date"`
	SalesLumi     int          `json:"sales_lumi"`
	Orders        int          `json:"orders"`
	AvgTicketLumi *int         `json:"avg_ticket_lumi"`
	InProgress    int          `json:"in_progress"`
	OpenStores    int          `json:"open_stores"`
	StoreCount    int          `json:"store_count"`
	ClosedReason  *string      `json:"closed_reason"`
	Yesterday     yesterdayOut `json:"yesterday"`
}

func analyticsOverview(t *tx, storeID *int, today dateOnly) overviewOut {
	live := t.one("SELECT count(*) FILTER (WHERE status = 'completed') AS orders, COALESCE(sum(total_lumi) FILTER (WHERE status = 'completed'), 0) AS sales, "+
		"count(*) FILTER (WHERE status = ANY($1)) AS in_progress "+
		"FROM analytics.order_facts WHERE business_date = $2 AND ($3::int IS NULL OR store_id = $3::int)", inProgressStatuses, today.String(), optInt(storeID))
	yesterday := today.addDays(-1)
	y := dailyPoints(t, storeID, yesterday, yesterday)[0]
	calendar := t.one("SELECT count(*) FILTER (WHERE is_open) AS open_stores, count(*) AS stores, min(closed_reason) AS closed_reason "+
		"FROM analytics.store_days($1, $1) WHERE ($2::int IS NULL OR store_id = $2::int)", today.String(), optInt(storeID))
	sales, orders := live.i("sales"), live.i("orders")
	out := overviewOut{
		BusinessDate: today.String(), SalesLumi: sales, Orders: orders, AvgTicketLumi: avgTicket(sales, orders),
		InProgress: live.i("in_progress"), OpenStores: calendar.i("open_stores"), StoreCount: calendar.i("stores"),
		Yesterday: yesterdayOut{BusinessDate: yesterday.String(), State: y.state, SalesLumi: y.salesLumi, Orders: y.orders},
	}
	if storeID != nil && calendar.i("open_stores") == 0 {
		out.ClosedReason = calendar.sN("closed_reason")
	}
	if y.salesLumi != nil && y.orders != nil {
		out.Yesterday.AvgTicketLumi = avgTicket(*y.salesLumi, *y.orders)
	}
	return out
}

// ---- 売上の推移 ----

// dailyPoints は営業日カレンダーと日次集計から、日ごとの点。state: open（営業日で集計済み。売上 0 を含む）/ closed（休業。値は nil）/
// not_built（営業日だが未集計。値は nil）/ partial（一部の店が未集計。値は nil）。
func dailyPoints(t *tx, storeID *int, start, end dateOnly) []dayPoint {
	rows := t.all("SELECT c.business_date AS d, count(*) FILTER (WHERE c.is_open) AS open_stores, count(s.store_id) AS built_stores, "+
		"COALESCE(sum(s.sales_lumi), 0) AS sales, COALESCE(sum(s.orders), 0) AS orders "+
		"FROM analytics.store_days($1, $2) c "+
		"LEFT JOIN analytics.daily_store_summary s ON s.store_id = c.store_id AND s.business_date = c.business_date "+
		"WHERE ($3::int IS NULL OR c.store_id = $3::int) GROUP BY c.business_date ORDER BY c.business_date", start.String(), end.String(), optInt(storeID))
	points := make([]dayPoint, 0, len(rows))
	for _, r := range rows {
		open, built := r.i("open_stores"), r.i("built_stores")
		var state string
		switch {
		case open == 0:
			state = "closed"
		case built == 0:
			state = "not_built"
		case built < open:
			state = "partial"
		default:
			state = "open"
		}
		p := dayPoint{date: r.date("d"), openStores: open, state: state}
		if state == "open" {
			s, o := r.i("sales"), r.i("orders")
			p.salesLumi, p.orders = &s, &o
		}
		if state == "not_built" || state == "partial" {
			p.missing = open - built
		}
		points = append(points, p)
	}
	return points
}

func periodOf(t *tx, storeID *int, start, end dateOnly) period {
	points := dailyPoints(t, storeID, start, end)
	p := period{start: start, end: end, points: points}
	for _, pt := range points {
		p.openDays += pt.openStores
		p.missingDays += pt.missing
		if pt.salesLumi != nil {
			p.salesLumi += *pt.salesLumi
		}
		if pt.orders != nil {
			p.orders += *pt.orders
		}
	}
	return p
}

type salesPointOut struct {
	Start     string `json:"start"`
	SalesLumi *int   `json:"sales_lumi"`
	Orders    *int   `json:"orders"`
	OpenDays  int    `json:"open_days"`
	State     string `json:"state"`
}

type salesTotalOut struct {
	SalesLumi   int `json:"sales_lumi"`
	Orders      int `json:"orders"`
	OpenDays    int `json:"open_days"`
	MissingDays int `json:"missing_days"`
}

type periodOut struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type salesSeriesOut struct {
	Scope      scopeOut        `json:"scope"`
	Grain      string          `json:"grain"`
	From       string          `json:"from"`
	To         string          `json:"to"`
	Points     []salesPointOut `json:"points"`
	Total      salesTotalOut   `json:"total"`
	Previous   periodOut       `json:"previous"`
	Comparison comparisonOut   `json:"comparison"`
}

func analyticsSales(t *tx, storeID *int, today dateOnly, grain string, count int) salesSeriesOut {
	start, end := lastCompleteRange(grain, count, today)
	current := periodOf(t, storeID, start, end)
	prevStart, prevEnd := previousRange(start, end, grain)
	previous := periodOf(t, storeID, prevStart, prevEnd)
	points := []salesPointOut{}
	for _, b := range bucketPoints(current.points, grain) {
		points = append(points, salesPointOut{Start: b.start.String(), SalesLumi: b.salesLumi, Orders: b.orders, OpenDays: b.openDays, State: b.state})
	}
	return salesSeriesOut{
		Grain: grain, From: start.String(), To: end.String(), Points: points,
		Total:      salesTotalOut{current.salesLumi, current.orders, current.openDays, current.missingDays},
		Previous:   periodOut{prevStart.String(), prevEnd.String()},
		Comparison: comparison(current, previous),
	}
}

// ---- 商品別（ABC）----

type productItemOut struct {
	ItemID      int     `json:"item_id"`
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	Qty         int     `json:"qty"`
	SalesLumi   int     `json:"sales_lumi"`
	SharePct    pyFloat `json:"share_pct"`
	CumSharePct pyFloat `json:"cum_share_pct"`
	ABC         string  `json:"abc"`
}

type productTotalsOut struct {
	SalesLumi int `json:"sales_lumi"`
	Qty       int `json:"qty"`
	Cups      int `json:"cups"`
}

type productsOut struct {
	Scope  scopeOut         `json:"scope"`
	From   string           `json:"from"`
	To     string           `json:"to"`
	Days   int              `json:"days"`
	Totals productTotalsOut `json:"totals"`
	Items  []productItemOut `json:"items"`
}

func analyticsProducts(t *tx, storeID *int, today dateOnly, days int) productsOut {
	start, end := lastCompleteRange("day", days, today)
	rows := t.all("SELECT item_id, max(item_code) AS code, max(item_name) AS name, max(category) AS category, sum(qty)::int AS qty, sum(sales_lumi)::int AS sales "+
		"FROM analytics.daily_store_item_sales WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR store_id = $3::int) "+
		"GROUP BY item_id ORDER BY sum(sales_lumi) DESC, item_id", start.String(), end.String(), optInt(storeID))
	sales := make([]int, len(rows))
	for i, r := range rows {
		sales[i] = r.i("sales")
	}
	abc := abcTable(sales)
	out := productsOut{From: start.String(), To: end.String(), Days: days, Items: []productItemOut{}}
	for i, r := range rows {
		it := productItemOut{
			ItemID: r.i("item_id"), Code: r.s("code"), Name: r.s("name"), Category: r.s("category"), Qty: r.i("qty"), SalesLumi: r.i("sales"),
			SharePct: pyFloat(abc[i].sharePct), CumSharePct: pyFloat(abc[i].cumSharePct), ABC: abc[i].klass,
		}
		out.Items = append(out.Items, it)
		out.Totals.SalesLumi += it.SalesLumi
		out.Totals.Qty += it.Qty
		if it.Category == "drink" {
			out.Totals.Cups += it.Qty
		}
	}
	return out
}

// ---- 曜日 × 時間帯 ----

type hourCellOut struct {
	Weekday   int `json:"weekday"`
	Hour      int `json:"hour"`
	Orders    int `json:"orders"`
	SalesLumi int `json:"sales_lumi"`
}

type weekdayDaysOut struct {
	Weekday   int `json:"weekday"`
	StoreDays int `json:"store_days"`
}

type hourlyOut struct {
	Scope     scopeOut         `json:"scope"`
	From      string           `json:"from"`
	To        string           `json:"to"`
	Days      int              `json:"days"`
	Hours     []int            `json:"hours"`
	Cells     []hourCellOut    `json:"cells"`
	StoreDays []weekdayDaysOut `json:"store_days"`
	MaxOrders int              `json:"max_orders"`
}

func analyticsHourly(t *tx, storeID *int, today dateOnly, days int) hourlyOut {
	start, end := lastCompleteRange("day", days, today)
	cells := t.all("SELECT EXTRACT(ISODOW FROM business_date)::int AS weekday, hour::int AS hour, sum(orders)::int AS orders, sum(sales_lumi)::int AS sales "+
		"FROM analytics.daily_store_hourly WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR store_id = $3::int) "+
		"GROUP BY 1, 2 ORDER BY 1, 2", start.String(), end.String(), optInt(storeID))
	storeDays := map[int]int{}
	for _, r := range t.all("SELECT EXTRACT(ISODOW FROM business_date)::int AS weekday, count(*)::int AS n FROM analytics.daily_store_summary "+
		"WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR store_id = $3::int) GROUP BY 1", start.String(), end.String(), optInt(storeID)) {
		storeDays[r.i("weekday")] = r.i("n")
	}
	hourSet := map[int]bool{}
	out := hourlyOut{From: start.String(), To: end.String(), Days: days, Hours: []int{}, Cells: []hourCellOut{}, StoreDays: []weekdayDaysOut{}}
	for _, c := range cells {
		hourSet[c.i("hour")] = true
		out.Cells = append(out.Cells, hourCellOut{c.i("weekday"), c.i("hour"), c.i("orders"), c.i("sales")})
		if c.i("orders") > out.MaxOrders {
			out.MaxOrders = c.i("orders")
		}
	}
	if len(hourSet) > 0 {
		hs := make([]int, 0, len(hourSet))
		for h := range hourSet {
			hs = append(hs, h)
		}
		sort.Ints(hs)
		for h := hs[0]; h <= hs[len(hs)-1]; h++ {
			out.Hours = append(out.Hours, h)
		}
	}
	for w := 1; w <= 7; w++ {
		out.StoreDays = append(out.StoreDays, weekdayDaysOut{w, storeDays[w]})
	}
	return out
}

// ---- 在庫 ----

type stockItemOut struct {
	ItemID       int      `json:"item_id"`
	Code         string   `json:"code"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Unit         string   `json:"unit"`
	OnHand       int      `json:"on_hand"`
	Reserved     int      `json:"reserved"`
	AvgDailyUse  pyFloat  `json:"avg_daily_use"`
	DaysOfCover  *pyFloat `json:"days_of_cover"`
	GapToReorder *int     `json:"gap_to_reorder"`
	ReorderPoint int      `json:"reorder_point"`
	LowStores    int      `json:"low_stores"`
	StoreCount   int      `json:"store_count"`
	Low          bool     `json:"low"`
}

type wasteReasonsOut struct {
	Expired int `json:"expired"`
	Damaged int `json:"damaged"`
	Quality int `json:"quality"`
	Other   int `json:"other"`
}

type wasteItemOut struct {
	ItemID       int             `json:"item_id"`
	Code         string          `json:"code"`
	Name         string          `json:"name"`
	Unit         string          `json:"unit"`
	Total        int             `json:"total"`
	ByReason     wasteReasonsOut `json:"by_reason"`
	WasteRatePct pyFloat         `json:"waste_rate_pct"`
}

type analyticsStockOut struct {
	Scope     scopeOut       `json:"scope"`
	UseFrom   string         `json:"use_from"`
	UseTo     string         `json:"use_to"`
	WasteFrom string         `json:"waste_from"`
	WasteTo   string         `json:"waste_to"`
	Items     []stockItemOut `json:"items"`
	Waste     []wasteItemOut `json:"waste"`
}

// analyticsStock は在庫の今の位置（残高。当日を含む）と、直近の消費（日次集計）から、残日数・発注点との差。全店のときは品目ごとに店をまとめる
// （残量・消費は合計、残日数・発注点との差は、最も厳しい店の値、low_stores は発注点を下回る店の数）。
func analyticsStock(t *tx, storeID *int, today dateOnly) analyticsStockOut {
	useStart, useEnd := lastCompleteRange("day", stockUseDays, today)
	wasteStart, wasteEnd := lastCompleteRange("day", wasteDays, today)
	positions := t.all("SELECT store_id, item_id, item_code, item_name, kind, unit, on_hand, reserved, safety_stock, reorder_point FROM analytics.stock_position "+
		"WHERE ($1::int IS NULL OR store_id = $1::int) ORDER BY item_id, store_id", optInt(storeID))
	type usage struct{ used, days int }
	use := map[[2]int]usage{}
	for _, r := range t.all("SELECT store_id, item_id, sum(consumed)::int AS used, count(*)::int AS days FROM analytics.daily_stock_levels "+
		"WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR store_id = $3::int) GROUP BY store_id, item_id", useStart.String(), useEnd.String(), optInt(storeID)) {
		use[[2]int{r.i("store_id"), r.i("item_id")}] = usage{r.i("used"), r.i("days")}
	}
	type itemAgg struct {
		out    stockItemOut
		avgUse float64
		cover  *float64
		gap    *int
	}
	byItem := map[int]*itemAgg{}
	var order []int
	for _, p := range positions {
		u := use[[2]int{p.i("store_id"), p.i("item_id")}]
		avgUse := 0.0
		if u.days > 0 {
			avgUse = float64(u.used) / float64(u.days)
		}
		available := p.i("on_hand") - p.i("reserved") - p.i("safety_stock")
		var cover *float64
		if avgUse > 0 {
			held := p.i("on_hand") - p.i("reserved")
			if held < 0 {
				held = 0
			}
			c := pyRound(float64(held)/avgUse, 1)
			cover = &c
		}
		gap := available - p.i("reorder_point")
		a, ok := byItem[p.i("item_id")]
		if !ok {
			a = &itemAgg{out: stockItemOut{
				ItemID: p.i("item_id"), Code: p.s("item_code"), Name: p.s("item_name"), Kind: p.s("kind"), Unit: p.s("unit"), ReorderPoint: p.i("reorder_point"),
			}}
			byItem[p.i("item_id")] = a
			order = append(order, p.i("item_id"))
		}
		a.out.OnHand += p.i("on_hand")
		a.out.Reserved += p.i("reserved")
		a.avgUse += avgUse
		a.out.StoreCount++
		if gap < 0 {
			a.out.LowStores++
		}
		if a.gap == nil || gap < *a.gap {
			g := gap
			a.gap = &g
		}
		if cover != nil && (a.cover == nil || *cover < *a.cover) {
			c := *cover
			a.cover = &c
		}
	}
	out := analyticsStockOut{
		UseFrom: useStart.String(), UseTo: useEnd.String(), WasteFrom: wasteStart.String(), WasteTo: wasteEnd.String(),
		Items: []stockItemOut{}, Waste: []wasteItemOut{},
	}
	names := map[int]stockItemOut{}
	for _, id := range order {
		a := byItem[id]
		a.out.AvgDailyUse = pyFloat(pyRound(a.avgUse, 1))
		a.out.DaysOfCover = pyFloatPtr(a.cover)
		a.out.GapToReorder = a.gap
		a.out.Low = a.out.LowStores > 0
		out.Items = append(out.Items, a.out)
		names[id] = a.out
	}

	type wasteAgg struct {
		total    int
		byReason map[string]int
	}
	wasteRows := t.all("SELECT w.item_id, w.reason_code, sum(w.qty)::int AS qty FROM analytics.daily_stock_waste w "+
		"WHERE w.business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR w.store_id = $3::int) GROUP BY w.item_id, w.reason_code", wasteStart.String(), wasteEnd.String(), optInt(storeID))
	consumed := map[int]int{}
	for _, r := range t.all("SELECT item_id, sum(consumed)::int AS consumed FROM analytics.daily_stock_levels WHERE business_date BETWEEN $1 AND $2 "+
		"AND ($3::int IS NULL OR store_id = $3::int) GROUP BY item_id", wasteStart.String(), wasteEnd.String(), optInt(storeID)) {
		consumed[r.i("item_id")] = r.i("consumed")
	}
	waste := map[int]*wasteAgg{}
	var wasteOrder []int
	for _, w := range wasteRows {
		a, ok := waste[w.i("item_id")]
		if !ok {
			a = &wasteAgg{byReason: map[string]int{}}
			waste[w.i("item_id")] = a
			wasteOrder = append(wasteOrder, w.i("item_id"))
		}
		a.total += w.i("qty")
		a.byReason[w.s("reason_code")] += w.i("qty")
	}
	for _, id := range wasteOrder {
		base, ok := names[id]
		if !ok {
			continue
		}
		w := waste[id]
		used := consumed[id]
		rate := 0.0
		if used+w.total != 0 {
			rate = pyRound(float64(w.total)/float64(used+w.total)*100, 1)
		}
		out.Waste = append(out.Waste, wasteItemOut{
			ItemID: id, Code: base.Code, Name: base.Name, Unit: base.Unit, Total: w.total,
			ByReason:     wasteReasonsOut{w.byReason["expired"], w.byReason["damaged"], w.byReason["quality"], w.byReason["other"]},
			WasteRatePct: pyFloat(rate),
		})
	}
	sort.SliceStable(out.Waste, func(i, j int) bool {
		if out.Waste[i].WasteRatePct != out.Waste[j].WasteRatePct {
			return out.Waste[i].WasteRatePct > out.Waste[j].WasteRatePct
		}
		return out.Waste[i].ItemID < out.Waste[j].ItemID
	})
	return out
}

// ---- 顧客（仮名 ID の集計だけ。人数のセルは 5 人未満を出さない）----

type segmentCellOut struct {
	Segment    string `json:"segment"`
	Label      string `json:"label"`
	Customers  *int   `json:"customers"`
	Suppressed bool   `json:"suppressed"`
}

type gridCellOut struct {
	R          int  `json:"r"`
	F          int  `json:"f"`
	Customers  *int `json:"customers"`
	Suppressed bool `json:"suppressed"`
}

type cohortCellOut struct {
	Offset     int      `json:"offset"`
	Customers  *int     `json:"customers"`
	RatePct    *pyFloat `json:"rate_pct"`
	Suppressed bool     `json:"suppressed"`
	InProgress bool     `json:"in_progress"`
}

type cohortRowOut struct {
	Cohort           string          `json:"cohort"`
	Size             *int            `json:"size"`
	Suppressed       bool            `json:"suppressed"`
	IncludesExisting bool            `json:"includes_existing"`
	Cells            []cohortCellOut `json:"cells"`
}

type cohortsOut struct {
	Rows      []cohortRowOut `json:"rows"`
	MaxOffset int            `json:"max_offset"`
}

type customersOut struct {
	AsOf              *string          `json:"as_of"`
	MinCell           int              `json:"min_cell"`
	TotalCustomers    *int             `json:"total_customers"`
	Segments          []segmentCellOut `json:"segments"`
	Grid              []gridCellOut    `json:"grid"`
	RepurchaseRatePct *pyFloat         `json:"repurchase_rate_pct"`
	AvgOrders         *pyFloat         `json:"avg_orders"`
	AvgSpendLumi      *int             `json:"avg_spend_lumi"`
	AtRiskCustomers   *int             `json:"at_risk_customers"`
	Cohorts           cohortsOut       `json:"cohorts"`
}

func analyticsCustomers(t *tx, today dateOnly) customersOut {
	segCounts := map[string]int{}
	for _, r := range t.all("SELECT segment, count(*)::int AS n FROM analytics.customer_rfm GROUP BY segment") {
		segCounts[r.s("segment")] = r.i("n")
	}
	var counts []cellKV
	total := 0
	for _, s := range segments {
		counts = append(counts, cellKV{s, segCounts[s]})
		total += segCounts[s]
	}
	shown := suppressCells(counts, minCell)
	gridCounts := map[[2]int]int{}
	for _, r := range t.all("SELECT r_score, f_score, count(*)::int AS n FROM analytics.customer_rfm GROUP BY r_score, f_score") {
		gridCounts[[2]int{r.i("r_score"), r.i("f_score")}] = r.i("n")
	}
	var gridCells []cellKV
	gridKey := func(r, f int) string { return "(" + itoaInt(r) + ", " + itoaInt(f) + ")" }
	for _, r := range []int{3, 2, 1} {
		for _, f := range []int{1, 2, 3} {
			gridCells = append(gridCells, cellKV{gridKey(r, f), gridCounts[[2]int{r, f}]})
		}
	}
	gridShown := suppressCells(gridCells, minCell)
	stats := t.one("SELECT count(*)::int AS n, count(*) FILTER (WHERE orders >= 2)::int AS repeat, COALESCE(sum(spend_lumi), 0)::bigint AS spend, " +
		"COALESCE(sum(orders), 0)::bigint AS orders, max(as_of) AS as_of FROM analytics.customer_rfm")
	var shownTotal *int
	allShown := true
	for _, v := range shown {
		if v == nil {
			allShown = false
		}
	}
	if allShown { // 隠したセルがあれば、合計は出さない（引き算で戻せるため）
		tt := total
		shownTotal = &tt
	}
	n := stats.i("n")
	repeat := stats.i("repeat")
	once := n - repeat
	rateOK := n >= minCell && repeat >= minCell && once >= minCell
	metricsOK := n >= minCell
	out := customersOut{MinCell: minCell, TotalCustomers: shownTotal, Segments: []segmentCellOut{}, Grid: []gridCellOut{}, AtRiskCustomers: shown["at_risk"]}
	if !stats.isNull("as_of") {
		s := stats.date("as_of").String()
		out.AsOf = &s
	}
	for _, s := range segments {
		out.Segments = append(out.Segments, segmentCellOut{Segment: s, Label: segmentLabels[s], Customers: shown[s], Suppressed: shown[s] == nil})
	}
	for _, r := range []int{3, 2, 1} {
		for _, f := range []int{1, 2, 3} {
			v := gridShown[gridKey(r, f)]
			out.Grid = append(out.Grid, gridCellOut{R: r, F: f, Customers: v, Suppressed: v == nil})
		}
	}
	if rateOK {
		p := pyFloat(pyRound(float64(repeat)/float64(n)*100, 1))
		out.RepurchaseRatePct = &p
	}
	if metricsOK {
		a := pyFloat(pyRound(float64(stats.i64("orders"))/float64(n), 1))
		out.AvgOrders = &a
		s := pyRoundInt(float64(stats.i64("spend")) / float64(n)) // LTV の目安（期間内の 1 人あたり利用額）
		out.AvgSpendLumi = &s
	}
	out.Cohorts = analyticsCohorts(t, today)
	return out
}

// analyticsCohorts は初回月（顧客ごとの最初の注文の月）× 経過月。active = その月に注文した人。5 人未満のセルと、5 人未満のコホートは出さない。
func analyticsCohorts(t *tx, today dateOnly) cohortsOut {
	currentMonth := dateOnly{today.y, today.m, 1}
	var dataStart *dateOnly
	if r := t.one("SELECT min(business_date) AS d FROM analytics.daily_store_summary"); r != nil && !r.isNull("d") {
		d := r.date("d")
		dataStart = &d
	}
	rows := t.all("WITH first AS (SELECT pseudonym_id, min(month) AS cohort FROM analytics.customer_monthly GROUP BY pseudonym_id) " +
		"SELECT f.cohort, ((EXTRACT(YEAR FROM m.month) - EXTRACT(YEAR FROM f.cohort)) * 12 + EXTRACT(MONTH FROM m.month) - EXTRACT(MONTH FROM f.cohort))::int AS \"offset\", " +
		"count(*)::int AS active FROM first f JOIN analytics.customer_monthly m ON m.pseudonym_id = f.pseudonym_id " +
		"GROUP BY f.cohort, 2 ORDER BY f.cohort, 2")
	byCohort := map[dateOnly]map[int]int{}
	var cohorts []dateOnly
	for _, r := range rows {
		c := r.date("cohort")
		if byCohort[c] == nil {
			byCohort[c] = map[int]int{}
			cohorts = append(cohorts, c)
		}
		byCohort[c][r.i("offset")] = r.i("active")
	}
	sort.Slice(cohorts, func(i, j int) bool { return cohorts[i].before(cohorts[j]) })
	out := cohortsOut{Rows: []cohortRowOut{}}
	for _, cohort := range cohorts {
		cells := byCohort[cohort]
		size := cells[0]
		lastOffset := (currentMonth.y-cohort.y)*12 + currentMonth.m - cohort.m
		row := cohortRowOut{Cohort: cohort.String(), Suppressed: size < minCell, Cells: []cohortCellOut{}}
		if size >= minCell {
			s := size
			row.Size = &s
		}
		row.IncludesExisting = dataStart != nil && cohort == (dateOnly{dataStart.y, dataStart.m, 1})
		for off := 0; off <= lastOffset; off++ {
			active := cells[off]
			hidden := size < minCell || (0 < active && active < minCell)
			cell := cohortCellOut{Offset: off, Suppressed: hidden, InProgress: off == lastOffset}
			if !hidden {
				a := active
				cell.Customers = &a
				p := pyFloat(pyRound(float64(active)/float64(size)*100, 1))
				cell.RatePct = &p
			}
			row.Cells = append(row.Cells, cell)
		}
		if len(row.Cells)-1 > out.MaxOffset {
			out.MaxOffset = len(row.Cells) - 1
		}
		out.Rows = append(out.Rows, row)
	}
	return out
}
