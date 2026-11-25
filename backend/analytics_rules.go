package main

// 分析の決まり（DB に触れない純粋な関数と定数）。定義の正本は docs/metrics.md。閾値は設計の既定で、実測ではない（backend/app/analytics_rules.py の移植）。

import (
	"regexp"
	"sort"
	"strconv"
)

const (
	minCell = 5 // 人数のセルが、これ未満なら出さない（docs/analytics.md「最小の集計単位」）

	abcAUpto = 80.0
	abcBUpto = 95.0

	rRecentDays = 14
	rLapseDays  = 30
	fHigh       = 30
	fMid        = 10
	mHigh       = 20000
	mMid        = 8000

	stockUseDays = 14
	wasteDays    = 30
)

var (
	segments      = []string{"loyal", "regular", "light", "at_risk", "dormant"}
	segmentLabels = map[string]string{"loyal": "常連", "regular": "通い", "light": "ときどき", "at_risk": "離れかけ", "dormant": "休眠"}
	wasteReasons  = []string{"expired", "damaged", "quality", "other"}
)

type wastePattern struct {
	code    string
	pattern string
	re      *regexp.Regexp
}

// wastePatterns は廃棄の理由（台帳の自由記述を、固定の区分に写す。PostgreSQL の ~* と同じ文字列を使う）。
var wastePatterns = []wastePattern{
	{code: "expired", pattern: "期限|賞味|消費|expire"},
	{code: "damaged", pattern: "破損|落と|こぼ|割れ|damage"},
	{code: "quality", pattern: "品質|鮮度|味|劣化|quality"},
}

func init() {
	for i := range wastePatterns {
		wastePatterns[i].re = regexp.MustCompile("(?i)" + wastePatterns[i].pattern)
	}
}

func wasteReasonCode(reason string) string {
	for _, p := range wastePatterns {
		if p.re.MatchString(reason) {
			return p.code
		}
	}
	return "other"
}

type abcRow struct {
	sharePct, cumSharePct float64
	klass                 string
}

// abcTable は売上の大きい順に並んだ金額 → 構成比・累積・クラス。構成比は 0〜100（小数 1 位）。合計が 0 なら、すべて C・構成比 0。
// クラスは、その品の手前までの累積で決める（80% をまたぐ品は A に入る。A が空にならない）。
func abcTable(sales []int) []abcRow {
	total := 0
	for _, s := range sales {
		total += s
	}
	rows := make([]abcRow, 0, len(sales))
	before := 0
	for _, amount := range sales {
		beforePct := 100.0
		if total != 0 {
			beforePct = float64(before) / float64(total) * 100
		}
		after := before + amount
		klass := "C"
		if beforePct < abcAUpto {
			klass = "A"
		} else if beforePct < abcBUpto {
			klass = "B"
		}
		r := abcRow{klass: klass}
		if total != 0 {
			r.sharePct = pyRound(float64(amount)/float64(total)*100, 1)
			r.cumSharePct = pyRound(float64(after)/float64(total)*100, 1)
		}
		rows = append(rows, r)
		before = after
	}
	return rows
}

func rScore(recencyDays int) int {
	switch {
	case recencyDays <= rRecentDays:
		return 3
	case recencyDays <= rLapseDays:
		return 2
	}
	return 1
}

func fScore(orders int) int {
	switch {
	case orders >= fHigh:
		return 3
	case orders >= fMid:
		return 2
	}
	return 1
}

func mScore(spend int) int {
	switch {
	case spend >= mHigh:
		return 3
	case spend >= mMid:
		return 2
	}
	return 1
}

// segmentOf は R と F から区分を決める。R=3: F=3 常連 / F=2 通い / F=1 ときどき、R=2 離れかけ（離脱の兆候）、R=1 休眠。
func segmentOf(r, f int) string {
	if r == 3 {
		switch f {
		case 3:
			return "loyal"
		case 2:
			return "regular"
		}
		return "light"
	}
	if r == 2 {
		return "at_risk"
	}
	return "dormant"
}

// cellKV は人数のセル（キーは、並べ替えの同点の決め手になる文字列）。
type cellKV struct {
	key string
	n   int
}

// suppressCells は人数のセルのうち k 未満のものを隠す（nil にする）。0 のセルは、人がいないので、そのまま 0。
// k 未満のセルが 1 つだけ隠れると、合計から引き算で戻せてしまうので、残りで最小のセルも隠す（補完の秘匿）。
func suppressCells(counts []cellKV, k int) map[string]*int {
	result := map[string]*int{}
	hidden := map[string]bool{}
	for _, c := range counts {
		n := c.n
		result[c.key] = &n
		if 0 < n && n < k {
			hidden[c.key] = true
		}
	}
	for key := range hidden {
		result[key] = nil
	}
	if len(hidden) == 1 {
		var rest []cellKV
		for _, c := range counts {
			if !hidden[c.key] && c.n >= k {
				rest = append(rest, c)
			}
		}
		if len(rest) > 0 {
			sort.SliceStable(rest, func(i, j int) bool {
				if rest[i].n != rest[j].n {
					return rest[i].n < rest[j].n
				}
				return rest[i].key < rest[j].key
			})
			result[rest[0].key] = nil
		}
	}
	return result
}

// ---- 期間 ----

// lastCompleteRange は最後に確定した期間から count 個ぶんの (開始日, 終了日)。日: 昨日まで count 日。週: 昨日までに終わった週（月〜日）count 週。月: 昨日までに終わった月 count か月。
func lastCompleteRange(grain string, count int, today dateOnly) (dateOnly, dateOnly) {
	yesterday := today.addDays(-1)
	switch grain {
	case "day":
		return yesterday.addDays(-(count - 1)), yesterday
	case "week":
		end := yesterday.addDays(-(yesterday.isoWeekday() % 7)) // 直近の日曜（昨日が日曜なら昨日）
		return end.addDays(-(7*count - 1)), end
	case "month":
		var monthEnd dateOnly
		if yesterday.addDays(1).d == 1 {
			monthEnd = yesterday
		} else {
			monthEnd = dateOnly{yesterday.y, yesterday.m, 1}.addDays(-1)
		}
		start := dateOnly{monthEnd.y, monthEnd.m, 1}
		for i := 0; i < count-1; i++ {
			prev := start.addDays(-1)
			start = dateOnly{prev.y, prev.m, 1}
		}
		return start, monthEnd
	}
	panic("grain: " + grain)
}

// previousRange は直前の、同じ長さの期間。月は、同じ月数ぶんだけ前（日数は違うことがある）。
func previousRange(start, end dateOnly, grain string) (dateOnly, dateOnly) {
	if grain != "month" {
		length := end.daysSince(start) + 1
		return start.addDays(-length), start.addDays(-1)
	}
	months := (end.y-start.y)*12 + end.m - start.m + 1
	newEnd := start.addDays(-1)
	newStart := dateOnly{newEnd.y, newEnd.m, 1}
	for i := 0; i < months-1; i++ {
		prev := newStart.addDays(-1)
		newStart = dateOnly{prev.y, prev.m, 1}
	}
	return newStart, newEnd
}

func bucketStart(day dateOnly, grain string) dateOnly {
	switch grain {
	case "week":
		return day.addDays(-(day.isoWeekday() - 1))
	case "month":
		return dateOnly{day.y, day.m, 1}
	}
	return day
}

func weekdayCounts(start, end dateOnly) map[int]int {
	c := map[int]int{}
	for i := 0; i <= end.daysSince(start); i++ {
		c[start.addDays(i).isoWeekday()]++
	}
	return c
}

func sameCounts(a, b map[int]int) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

type period struct {
	start, end            dateOnly
	openDays, missingDays int
	salesLumi, orders     int
	points                []dayPoint
}

type comparisonOut struct {
	State             string   `json:"state"`
	PreviousSalesLumi *int     `json:"previous_sales_lumi"`
	ChangePct         *pyFloat `json:"change_pct"`
	Reason            *string  `json:"reason"`
	Message           *string  `json:"message"`
}

var comparisonMessages = map[string]string{
	"previous_missing":   "前の期間の集計が足りないため、比べられません。",
	"weekday_mismatch":   "曜日の構成が前の期間と違うため、比べられません。",
	"open_days_mismatch": "営業日の数が前の期間と違う（休業があった）ため、比べられません。",
	"previous_zero":      "前の期間の売上が 0 のため、比べられません。",
}

func notComparable(reason string) comparisonOut {
	msg := comparisonMessages[reason]
	return comparisonOut{State: "not_comparable", Reason: &reason, Message: &msg}
}

// comparison は前期比。期間の長さと曜日の構成が同じで、営業日の数も同じで、前の期間が全部集計済みのときだけ比べる。足りなければ「比較不可」（理由つき）。
func comparison(cur, prev period) comparisonOut {
	if prev.missingDays > 0 || prev.openDays == 0 {
		return notComparable("previous_missing")
	}
	if cur.end.daysSince(cur.start) != prev.end.daysSince(prev.start) || !sameCounts(weekdayCounts(cur.start, cur.end), weekdayCounts(prev.start, prev.end)) {
		return notComparable("weekday_mismatch")
	}
	if cur.openDays != prev.openDays {
		return notComparable("open_days_mismatch")
	}
	if prev.salesLumi == 0 {
		return notComparable("previous_zero")
	}
	change := float64(cur.salesLumi-prev.salesLumi) / float64(prev.salesLumi) * 100
	prevSales := prev.salesLumi
	pct := pyFloat(pyRound(change, 1))
	return comparisonOut{State: "ok", PreviousSalesLumi: &prevSales, ChangePct: &pct}
}

type dayPoint struct {
	date       dateOnly
	openStores int
	state      string
	salesLumi  *int
	orders     *int
	missing    int
}

type bucketPoint struct {
	start     dateOnly
	salesLumi *int
	orders    *int
	openDays  int
	state     string
}

// bucketPoints は日ごとの点を、日・週・月の点に束ねる。休業・未集計の日は、合計にも営業日の数にも入れない。
// 束ねた点は、未集計の日が 1 日でもあれば値を持たない（not_built）。全部が休業なら closed。それ以外は open（値は営業日の合計）。
func bucketPoints(points []dayPoint, grain string) []bucketPoint {
	if grain == "day" {
		out := make([]bucketPoint, 0, len(points))
		for _, p := range points {
			out = append(out, bucketPoint{p.date, p.salesLumi, p.orders, p.openStores, p.state})
		}
		return out
	}
	type acc struct{ sales, orders, openDays, notBuilt, days, closed int }
	buckets := map[dateOnly]*acc{}
	var order []dateOnly
	for _, p := range points {
		k := bucketStart(p.date, grain)
		b, ok := buckets[k]
		if !ok {
			b = &acc{}
			buckets[k] = b
			order = append(order, k)
		}
		b.days++
		switch p.state {
		case "closed":
			b.closed++
		case "not_built", "partial":
			b.notBuilt++
		default:
			if p.salesLumi != nil {
				b.sales += *p.salesLumi
			}
			if p.orders != nil {
				b.orders += *p.orders
			}
			b.openDays += p.openStores
		}
	}
	sort.Slice(order, func(i, j int) bool { return order[i].before(order[j]) })
	out := make([]bucketPoint, 0, len(order))
	for _, k := range order {
		b := buckets[k]
		bp := bucketPoint{start: k, openDays: b.openDays}
		switch {
		case b.notBuilt > 0:
			bp.state = "not_built"
		case b.closed == b.days:
			bp.state = "closed"
		default:
			bp.state = "open"
			s, o := b.sales, b.orders
			bp.salesLumi, bp.orders = &s, &o
		}
		out = append(out, bp)
	}
	return out
}

func itoaInt(n int) string { return strconv.Itoa(n) }
