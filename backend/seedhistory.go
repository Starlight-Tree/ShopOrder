package main

// ダミーの履歴（過去 90 日の注文・在庫の台帳）。**すべてダミー。実在の店・人・企業・売上とは関係がない。**（backend/app/seed_history.py の移植）
//
//	DEMO_DATA=allow api seed --reset --history
//
//   - 注文の API は通さず、orders・order_items・order_events・payments・stock_reservations・loyalty_ledger・stock_movements へ直接入れる
//     （placed_at・business_date を過去にする）。status は completed が中心で、少数の cancelled。宅配の分析は P2 の後（今は店頭のみ）
//   - 固定の乱数の種（historySeed）から作る。顧客・日・店ごとに別の乱数を使い、順序に依らない。乱数は Python の random.Random と同じ（pyrandom.go）なので、
//     Python が作ったダミーと同じ中身になる（ID を除く。三角関数の最後の 1 ビットで、まれに違いうる）
//   - 顧客 120 人（users。auth_user_id は `dev:hist-NNN`、名前は「ダミー顧客 NNN」）。種類（常連・通い・たまに・離れた人・試しただけの人）と、入会の日で、RFM・コホートが偏らないようにする
//   - 在庫: 台帳（reserve・consume・release・receive・waste・adjust）と残高を同じ操作で作る（残高 = 台帳の合計。reconcileStock が空）
//   - 休業: 定休日と、臨時休業（store_closures。ダミーの数日）。MO 不可の店（居住区信号塔店）は、注文が入らない（営業日で売上 0）

import (
	"container/heap"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	historySeed      = 20261121
	historyDays      = 90
	nCustomers       = 120
	cancelRate       = 0.04
	festivalFactor   = 1.5 // 帰還祭（12/1〜12/25）
	dryReorderFactor = 3
)

var temporaryClosures = []struct {
	daysAgo int
	code    string
	reason  string
}{
	{45, "rock-lookout", "砂嵐の警報（ダミー）"},
	{31, "ruins-terrace", "設備点検（ダミー）"},
	{12, "terminal-central", "砂嵐の警報（ダミー）"},
}

// itemWeights は品目ごとの人気（重み）。看板（OB）が最も多い。
var itemWeights = map[string]int{
	"oasis-blend": 28, "seasonal-blend": 8, "kikan-limited": 16, "cafe-latte": 12, "americano": 9, "cappuccino": 7, "matcha-latte": 6,
	"black-tea": 5, "hot-sandwich": 6, "meat-pie": 4, "cheesecake": 4, "gateau-chocolat": 3, "morning-set": 5, "beans-oasis": 3, "beans-seasonal": 1,
}

var visitRate = map[string]float64{"loyal": 0.70, "regular": 0.32, "occasional": 0.11, "lapsed": 0.26} // trial は、決まった 1〜2 日だけ来る
var dowFactorCommuter = [7]float64{1.0, 1.0, 1.0, 1.0, 1.0, 0.45, 0.30}                                // 月〜日
var dowFactorOther = [7]float64{0.90, 0.90, 0.95, 1.0, 1.15, 1.15, 0.85}

// 在庫の補充（新設のダミー）。生鮮は月・木に目標まで。そのほかは金・土に、発注点の 3 倍を切っていれば目標まで。
var freshItems = map[string]bool{"milk": true, "bread": true, "hot-sandwich": true, "meat-pie": true, "cheesecake": true, "gateau-chocolat": true}
var freshDeliveryWeekdays = []int{1, 4}
var dryDeliveryWeekdays = []int{5, 6}

type perishable struct {
	prob   float64
	lo, hi int
}

var perishableWaste = map[string]perishable{
	"milk": {0.12, 300, 800}, "bread": {0.12, 1, 3}, "hot-sandwich": {0.10, 1, 2}, "meat-pie": {0.10, 1, 2},
	"cheesecake": {0.10, 1, 2}, "gateau-chocolat": {0.10, 1, 2},
}

var wasteReasonsHistory = []struct {
	reason string
	weight int
}{{"賞味期限切れ", 5}, {"落として破損", 2}, {"品質確認で廃棄", 2}, {"作り過ぎ", 1}}

type stressedKey struct{ store, code string }
type stressedVal struct {
	par      float64
	stopDays *int // 補充が止まる日（今日からの日数）。nil は止まらない
}

// stressedStock は在庫を少なめに持つ店・品目の再現（ダミー）。期間の初めに、棚卸しの差異（adjust）で、その上限まで減らす。
var stressedStock = map[stressedKey]stressedVal{
	{"rock-lookout", "milk"}:                {0.15, nil},
	{"ruins-terrace", "cup-m"}:              {0.12, nil},
	{"terminal-central", "coffee-beans"}:    {0.35, ptr(20)}, // 20 日前から補充が止まる（仕入れ先の遅れ。ダミー）
	{"residential-dome", "gateau-chocolat"}: {0.30, nil},
}

var historyPublicIDAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // orders.public_id の CHECK と同じ

type hVariant struct {
	id                          int
	itemCode, size, temperature string
	price                       int
}

type hStore struct {
	id                              int
	code                            string
	area, seats                     int
	openMin, closeMin, lastOrderMin int
	closedWeekday                   *int
	mobileOrder                     bool
}

type hCustomer struct {
	idx       int
	kind      string
	joinDay   dateOnly
	lapseDay  *dateOnly
	home      []int
	fav       map[string]bool
	sizePref  string
	icePref   float64
	trialDays map[dateOnly]bool
}

type hPlan struct {
	customer int
	storeID  int
	placed   time.Time // 店のローカル時刻（UTC として持つ。意味はローカル）
	lines    []lineQty // 変種 ID → 数量（挿入順）
	outcome  string
	keyDay   dateOnly
	keyIdx   int
	keyVisit int
}

type lineQty struct{ variantID, qty int }

func (p hPlan) keyString() string {
	return fmt.Sprintf("(datetime.date(%d, %d, %d), %d, %d)", p.keyDay.y, p.keyDay.m, p.keyDay.d, p.keyIdx, p.keyVisit)
}

func historyRng(parts ...any) *pyRandom {
	strs := make([]string, len(parts))
	for i, p := range parts {
		strs[i] = fmt.Sprint(p)
	}
	return newPyRandom(strconv.Itoa(historySeed) + ":" + strings.Join(strs, ":"))
}

type hItem struct {
	seasonFrom, seasonTo *string
	soldFrom, soldUntil  *int // 分
}

func minutesOf(s *string) *int {
	if s == nil {
		return nil
	}
	m := todSeconds(*s) / 60
	return &m
}

func loadHistoryStores(t *tx) []hStore {
	var out []hStore
	for _, r := range t.all("SELECT id, code, area_code, seats, open_time::text AS open_time, close_time::text AS close_time, last_order_minutes, closed_weekday, mobile_order FROM stores ORDER BY id") {
		out = append(out, hStore{
			id: r.i("id"), code: r.s("code"), area: r.i("area_code"), seats: r.i("seats"),
			openMin: todSeconds(r.s("open_time")) / 60, closeMin: todSeconds(r.s("close_time")) / 60, lastOrderMin: r.i("last_order_minutes"),
			closedWeekday: r.iN("closed_weekday"), mobileOrder: r.b("mobile_order"),
		})
	}
	return out
}

func loadHistoryMenu(t *tx) (map[string]hItem, map[string][]hVariant) {
	items := map[string]hItem{}
	for _, r := range t.all("SELECT code, season_from, season_to, sold_from::text AS sold_from, sold_until::text AS sold_until FROM menu_items WHERE is_active ORDER BY id") {
		items[r.s("code")] = hItem{r.sN("season_from"), r.sN("season_to"), minutesOf(r.sN("sold_from")), minutesOf(r.sN("sold_until"))}
	}
	variants := map[string][]hVariant{}
	for _, r := range t.all("SELECT v.id, i.code, v.size, v.temperature, v.price_lumi FROM menu_variants v JOIN menu_items i ON i.id = v.item_id WHERE i.is_active ORDER BY v.id") {
		variants[r.s("code")] = append(variants[r.s("code")], hVariant{r.i("id"), r.s("code"), r.s("size"), r.s("temperature"), r.i("price_lumi")})
	}
	return items, variants
}

func sortedItemCodes() []string {
	codes := make([]string, 0, len(itemWeights))
	for c := range itemWeights {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	return codes
}

// ---- 顧客 ----

func makeCustomers(stores []hStore, windowStart, today dateOnly) []hCustomer {
	var mo []hStore
	for _, s := range stores {
		if s.mobileOrder {
			mo = append(mo, s)
		}
	}
	var customers []hCustomer
	codes := sortedItemCodes()
	for i := 1; i <= nCustomers; i++ {
		rng := historyRng("customer", i)
		roll := rng.random()
		kind := "trial"
		switch {
		case roll < 0.13:
			kind = "loyal"
		case roll < 0.40:
			kind = "regular"
		case roll < 0.66:
			kind = "occasional"
		case roll < 0.80:
			kind = "lapsed"
		}
		var lapse *dateOnly
		var join dateOnly
		switch kind {
		case "lapsed":
			var l dateOnly
			if rng.random() < 0.5 {
				l = today.addDays(-rng.randint(15, 28)) // 最近まで来ていた（離れかけ）
			} else {
				l = windowStart.addDays(rng.randint(30, 55)) // だいぶ前に来なくなった（休眠）
			}
			lapse = &l
			if rng.random() < 0.6 {
				join = windowStart.addDays(-rng.randint(3, 100))
			} else {
				join = windowStart.addDays(rng.randint(0, 25))
			}
		case "trial": // 試しに使っただけの人（1〜2 回）。期間の中で入会する
			join = windowStart.addDays(rng.randint(0, 80))
		default:
			if rng.random() < 0.45 {
				join = windowStart.addDays(-rng.randint(3, 300))
			} else {
				join = windowStart.addDays(rng.randint(0, 80))
			}
		}
		weights := make([]int, len(mo))
		for k, s := range mo {
			weights[k] = s.seats
		}
		primary := mo[rng.choicesIndex(weights)] // 規模（席数）に比例して選ばれる
		home := []int{primary.id}
		if rng.random() < 0.5 {
			var near []hStore
			for _, s := range mo {
				if s.area == primary.area && s.id != primary.id {
					near = append(near, s)
				}
			}
			if len(near) == 0 {
				for _, s := range mo {
					if s.id != primary.id {
						near = append(near, s)
					}
				}
			}
			home = append(home, near[rng.choiceIndex(len(near))].id)
		}
		fav := map[string]bool{}
		for _, k := range rng.sample(len(codes), 2) {
			fav[codes[k]] = true
		}
		trialDays := map[dateOnly]bool{}
		if kind == "trial" {
			span := join.daysSince(join)
			span = today.daysSince(join)
			if span < 1 {
				span = 1
			}
			n := 2
			if rng.random() < 0.6 {
				n = 1
			}
			if span < n {
				n = span
			}
			for _, d := range rng.sample(span, n) {
				trialDays[join.addDays(d)] = true
			}
		}
		sizePref := []string{"S", "M", "M", "L"}[rng.choiceIndex(4)]
		icePref := []float64{0.2, 0.4, 0.6}[rng.choiceIndex(3)]
		customers = append(customers, hCustomer{i, kind, join, lapse, home, fav, sizePref, icePref, trialDays})
	}
	return customers
}

// ---- 注文の予定（顧客ごと・日ごと）----

// sampleMinute は朝（8:20 前後）と夕方（17:20 前後）に山がある時刻。店の受付の時間に入るまで引き直す。
func sampleMinute(rng *pyRandom, lo, hi int) int {
	for i := 0; i < 30; i++ {
		r := rng.random()
		var g float64
		switch {
		case r < 0.40:
			g = rng.gauss(8*60+20, 50)
		case r < 0.55:
			g = rng.gauss(12*60+20, 55)
		default:
			g = rng.gauss(17*60+20, 60)
		}
		m := int(math.Trunc(g))
		if lo <= m && m <= hi {
			return m
		}
	}
	return rng.randint(lo, hi)
}

func itemOK(item hItem, day dateOnly, minute int) bool {
	if !inSeason(fmt.Sprintf("%02d-%02d", day.m, day.d), item.seasonFrom, item.seasonTo) {
		return false
	}
	if item.soldFrom != nil && minute < *item.soldFrom {
		return false
	}
	return !(item.soldUntil != nil && minute > *item.soldUntil)
}

func pickVariant(rng *pyRandom, options []hVariant, c hCustomer) hVariant {
	sizes := map[string]bool{}
	for _, v := range options {
		sizes[v.size] = true
	}
	size := c.sizePref
	if !sizes[size] {
		if sizes["M"] {
			size = "M"
		} else {
			var ss []string
			for s := range sizes {
				ss = append(ss, s)
			}
			sort.Strings(ss)
			size = ss[0]
		}
	}
	var sized []hVariant
	temps := map[string]bool{}
	for _, v := range options {
		if v.size == size {
			sized = append(sized, v)
			temps[v.temperature] = true
		}
	}
	var temp string
	if len(temps) == 1 && temps["-"] {
		temp = "-"
	} else if rng.random() < c.icePref && temps["ice"] {
		temp = "ice"
	} else if temps["hot"] {
		temp = "hot"
	} else {
		var ts []string
		for tt := range temps {
			ts = append(ts, tt)
		}
		sort.Strings(ts)
		temp = ts[0]
	}
	for _, v := range sized {
		if v.temperature == temp {
			return v
		}
	}
	panic("変種が見つかりません")
}

func chooseStore(rng *pyRandom, c hCustomer, stores map[int]hStore, closures map[[2]any]bool, day dateOnly) *hStore {
	order := append([]int(nil), c.home...)
	if !(rng.random() < 0.85) {
		for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
			order[i], order[j] = order[j], order[i]
		}
	}
	for _, sid := range order {
		s := stores[sid]
		closedToday := s.closedWeekday != nil && *s.closedWeekday == day.isoWeekday()
		if s.mobileOrder && !closedToday && !closures[[2]any{sid, day}] {
			return &s
		}
	}
	return nil
}

func chooseLines(rng *pyRandom, c hCustomer, items map[string]hItem, variants map[string][]hVariant, day dateOnly, minute int) []lineQty {
	var codes []string
	for _, code := range sortedItemCodes() {
		if it, ok := items[code]; ok && len(variants[code]) > 0 && itemOK(it, day, minute) {
			codes = append(codes, code)
		}
	}
	weights := make([]int, len(codes))
	for i, code := range codes {
		weights[i] = itemWeights[code]
		if c.fav[code] {
			weights[i] *= 3
		}
	}
	nLines := []int{1, 2, 3}[rng.choicesIndex([]int{60, 30, 10})]
	var lines []lineQty
	for k := 0; k < nLines; k++ {
		code := codes[rng.choicesIndex(weights)]
		variant := pickVariant(rng, variants[code], c)
		add := []int{1, 2, 3}[rng.choicesIndex([]int{85, 13, 2})]
		found := false
		for i := range lines {
			if lines[i].variantID == variant.id {
				lines[i].qty += add
				found = true
				break
			}
		}
		if !found {
			lines = append(lines, lineQty{variant.id, add})
		}
	}
	return lines
}

func planVisits(customers []hCustomer, stores map[int]hStore, closures map[[2]any]bool, items map[string]hItem, variants map[string][]hVariant, windowStart, today dateOnly) []hPlan {
	var plans []hPlan
	for day := windowStart; !today.before(day); day = day.addDays(1) {
		inFestival := inSeason(fmt.Sprintf("%02d-%02d", day.m, day.d), ptr("12-01"), ptr("12-25"))
		for _, c := range customers {
			if day.before(c.joinDay) || (c.lapseDay != nil && !day.before(*c.lapseDay)) {
				continue
			}
			dow := dowFactorOther
			if c.kind == "loyal" {
				dow = dowFactorCommuter
			}
			factor := dow[day.isoWeekday()-1]
			if inFestival {
				factor *= festivalFactor
			} else {
				factor *= 1.0
			}
			for visit := 0; visit < 2; visit++ { // 通勤の人は、朝と夕方の 2 回が、たまにある
				rng := historyRng("visit", c.idx, day.String(), visit)
				if c.kind == "trial" {
					if visit == 1 || !c.trialDays[day] {
						continue
					}
				} else {
					mult := 1.0
					if visit != 0 {
						mult = 0.15
					}
					if rng.random() >= visitRate[c.kind]*factor*mult {
						continue
					}
				}
				store := chooseStore(rng, c, stores, closures, day)
				if store == nil {
					continue
				}
				lo, hi := store.openMin, store.closeMin-store.lastOrderMin
				minute := sampleMinute(rng, lo, hi)
				lines := chooseLines(rng, c, items, variants, day, minute)
				roll := rng.random()
				outcome := "completed"
				if roll < cancelRate {
					outcome = []string{"cancel_customer", "cancel_declined", "cancel_timeout", "cancel_staff"}[rng.choicesIndex([]int{40, 20, 25, 15})]
				}
				secs := 0
				if minute < hi {
					secs = rng.randint(0, 59) // ラストオーダーの時刻ちょうどまで
				}
				placed := time.Date(day.y, time.Month(day.m), day.d, 0, 0, 0, 0, time.UTC).Add(time.Duration(minute)*time.Minute + time.Duration(secs)*time.Second)
				plans = append(plans, hPlan{c.idx, store.id, placed, lines, outcome, day, c.idx, visit})
			}
		}
	}
	return plans
}

// ---- 在庫の補充・廃棄の予定（店ごと）----

type hEvent struct {
	when time.Time
	prio int
	seq  int
	kind string
	data any
}

type hWaste struct {
	itemID, qty int
	reason      string
}

type hStockItem struct {
	code            string
	safety, reorder int
}

// stockEvents は (ローカル時刻, 優先, 通し番号, 種類, 内容)。receive と waste は、条件を見るのは処理するとき（その時点の残高で）。
func stockEvents(store hStore, stock map[int]hStockItem, itemIDs []int, windowStart, today dateOnly) []hEvent {
	var events []hEvent
	seq := 0
	for day := windowStart; !today.before(day); day = day.addDays(1) {
		for _, itemID := range itemIDs {
			item := stock[itemID]
			code := item.code
			stopped := false
			if sv, ok := stressedStock[stressedKey{store.code, code}]; ok && sv.stopDays != nil {
				stopped = !day.before(today.addDays(-*sv.stopDays))
			}
			weekdays := dryDeliveryWeekdays
			if freshItems[code] {
				weekdays = freshDeliveryWeekdays
			}
			isDelivery := false
			for _, w := range weekdays {
				if w == day.isoWeekday() {
					isDelivery = true
				}
			}
			if isDelivery && !stopped {
				seq++
				events = append(events, hEvent{time.Date(day.y, time.Month(day.m), day.d, 6, 0, 0, 0, time.UTC), 0, seq, "receive", itemID})
			}
			if w, ok := perishableWaste[code]; ok && !(store.closedWeekday != nil && *store.closedWeekday == day.isoWeekday()) {
				rng := historyRng("waste", store.id, code, day.String())
				if rng.random() < w.prob {
					weights := make([]int, len(wasteReasonsHistory))
					for i, r := range wasteReasonsHistory {
						weights[i] = r.weight
					}
					reason := wasteReasonsHistory[rng.choicesIndex(weights)].reason
					seq++
					qty := rng.randint(w.lo, w.hi)
					events = append(events, hEvent{time.Date(day.y, time.Month(day.m), day.d, 0, 0, 0, 0, time.UTC).Add(time.Duration(store.closeMin-20) * time.Minute), 3, seq, "waste", hWaste{itemID, qty, reason}})
				}
			}
		}
	}
	return events
}

type eventHeap []hEvent

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if !h[i].when.Equal(h[j].when) {
		return h[i].when.Before(h[j].when)
	}
	if h[i].prio != h[j].prio {
		return h[i].prio < h[j].prio
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(hEvent)) }
func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

type hOrder struct {
	plan     hPlan
	need     map[int]int
	publicID string
	oidx     int
	times    map[string]time.Time
	pickupNo int
}

type hMovement struct {
	storeID, itemID int
	kind            string
	qty             int
	refType         string
	refID           *string
	reason          *string
	actor           string
	at              time.Time
}

func hashFreeSeq(p hPlan) int {
	ordinal := int(p.keyDay.time().Unix()/86400) + 719163 // date.toordinal()
	return ordinal*100_000 + p.keyIdx*10 + p.keyVisit
}

func historyPublicIDs(count int) []string {
	rng := historyRng("public-ids")
	seen := map[string]bool{}
	var out []string
	for len(out) < count {
		b := make([]byte, 8)
		for i := range b {
			b[i] = historyPublicIDAlphabet[rng.choiceIndex(len(historyPublicIDAlphabet))]
		}
		if id := string(b); !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// seedHistory は履歴を入れる。t は、seed が作った直後（--reset で空にした）の接続。戻り値は件数（順序つき）。asOf は、今日の注文をどこまで入れるかの時刻（UTC）。
func seedHistory(t *tx, today dateOnly, asOf time.Time) []countKV {
	offset := localUTCOffsetHours()
	toUTC := func(local time.Time) time.Time { return local.Add(-time.Duration(offset) * time.Hour) }
	asOfLocal := asOf.UTC().Add(time.Duration(offset) * time.Hour)
	windowStart := today.addDays(-historyDays)

	stores := loadHistoryStores(t)
	byID := map[int]hStore{}
	byCode := map[string]hStore{}
	for _, s := range stores {
		byID[s.id] = s
		byCode[s.code] = s
	}
	items, variants := loadHistoryMenu(t)
	stock := map[int]hStockItem{}
	var itemIDs []int
	stockByCode := map[string]int{}
	for _, r := range t.all("SELECT id, code, safety_stock, reorder_point FROM stock_items ORDER BY id") {
		stock[r.i("id")] = hStockItem{r.s("code"), r.i("safety_stock"), r.i("reorder_point")}
		itemIDs = append(itemIDs, r.i("id"))
		stockByCode[r.s("code")] = r.i("id")
	}
	staffByStore := map[int]int{}
	for _, r := range t.all("SELECT store_id, min(id) AS id FROM staff_accounts WHERE store_id IS NOT NULL GROUP BY store_id") {
		staffByStore[r.i("store_id")] = r.i("id")
	}
	recipeMap := map[int][]recipeLine{}
	for _, r := range t.all("SELECT variant_id, stock_item_id, qty FROM recipe_lines ORDER BY variant_id, stock_item_id") {
		recipeMap[r.i("variant_id")] = append(recipeMap[r.i("variant_id")], recipeLine{r.i("stock_item_id"), r.i("qty")})
	}

	// 臨時休業（ダミー）
	closures := map[[2]any]bool{}
	for _, c := range temporaryClosures {
		sid := byCode[c.code].id
		d := today.addDays(-c.daysAgo)
		closures[[2]any{sid, d}] = true
		t.exec("INSERT INTO store_closures (store_id, date, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", sid, d.String(), c.reason)
	}

	customers := makeCustomers(stores, windowStart, today)
	allPlans := planVisits(customers, byID, closures, items, variants, windowStart, today)
	var plans []hPlan
	for _, p := range allPlans {
		if !p.placed.After(asOfLocal.Add(-25 * time.Minute)) { // 今日の分は、確定したものだけ（進行中の注文は作らない）
			plans = append(plans, p)
		}
	}

	// ---- 顧客（users）----
	for _, c := range customers {
		created := toUTC(time.Date(c.joinDay.y, time.Month(c.joinDay.m), c.joinDay.d, 9, 0, 0, 0, time.UTC))
		t.exec("INSERT INTO users (auth_user_id, display_name, loyalty_points, created_at) VALUES ($1, $2, 0, $3)",
			fmt.Sprintf("dev:hist-%03d", c.idx), fmt.Sprintf("ダミー顧客 %03d", c.idx), created)
	}
	userIDs := map[string]int{}
	for _, r := range t.all("SELECT auth_user_id, id FROM users WHERE auth_user_id LIKE 'dev:hist-%'") {
		userIDs[r.s("auth_user_id")] = r.i("id")
	}
	userOf := func(p hPlan) int { return userIDs[fmt.Sprintf("dev:hist-%03d", p.customer)] }

	// ---- 店ごとに、在庫を時間順に動かしながら、受け付けた注文を決める ----
	var accepted []*hOrder
	var movements []hMovement
	finalStock := map[[2]int]int{}
	publicIDs := historyPublicIDs(len(plans) + 10)
	byStore := map[int][]hPlan{}
	for _, p := range plans {
		byStore[p.storeID] = append(byStore[p.storeID], p)
	}
	opening := map[[2]int]int{}
	for _, r := range t.all("SELECT store_id, item_id, on_hand FROM stock_balances") {
		opening[[2]int{r.i("store_id"), r.i("item_id")}] = r.i("on_hand")
	}

	for _, store := range stores {
		state := map[int]int{}
		reserved := map[int]int{}
		target := map[int]int{} // 補充の上限は、初期在庫（席数に比例）
		for _, i := range itemIDs {
			state[i] = opening[[2]int{store.id, i}]
			target[i] = state[i]
		}
		for _, key := range sortedStressedKeys() {
			if key.store != store.code {
				continue
			}
			sv := stressedStock[key]
			itemID := stockByCode[key.code]
			target[itemID] = int(math.Max(1, math.Trunc(float64(target[itemID])*sv.par)))
			if state[itemID] > target[itemID] {
				delta := target[itemID] - state[itemID]
				movements = append(movements, hMovement{store.id, itemID, "adjust", delta, "seed", nil, ptr("棚卸しの差異（ダミー）"), "seed",
					toUTC(time.Date(windowStart.y, time.Month(windowStart.m), windowStart.d, 6, 30, 0, 0, time.UTC))})
				state[itemID] += delta
			}
		}
		var h eventHeap
		for _, e := range stockEvents(store, stock, itemIDs, windowStart, today) {
			if !e.when.After(asOfLocal) {
				h = append(h, e)
			}
		}
		storePlans := append([]hPlan(nil), byStore[store.id]...)
		sort.SliceStable(storePlans, func(i, j int) bool {
			if !storePlans[i].placed.Equal(storePlans[j].placed) {
				return storePlans[i].placed.Before(storePlans[j].placed)
			}
			return hashFreeSeq(storePlans[i]) < hashFreeSeq(storePlans[j])
		})
		for _, p := range storePlans {
			h = append(h, hEvent{p.placed, 2, hashFreeSeq(p), "order", p})
		}
		heap.Init(&h)
		followup := 0
		for h.Len() > 0 {
			e := heap.Pop(&h).(hEvent)
			switch e.kind {
			case "receive":
				itemID := e.data.(int)
				code := stock[itemID].code
				var qty int
				if freshItems[code] {
					qty = target[itemID] - state[itemID]
				} else if state[itemID]-stock[itemID].safety < stock[itemID].reorder*dryReorderFactor {
					qty = target[itemID] - state[itemID]
				}
				if qty > 0 {
					movements = append(movements, hMovement{store.id, itemID, "receive", qty, "delivery", nil, ptr("定期の納品（ダミー）"), "system", toUTC(e.when)})
					state[itemID] += qty
				}
			case "waste":
				w := e.data.(hWaste)
				qty := w.qty
				if avail := state[w.itemID] - reserved[w.itemID]; avail < qty {
					qty = avail
				}
				if qty > 0 {
					movements = append(movements, hMovement{store.id, w.itemID, "waste", -qty, "manual", nil, ptr(w.reason), fmt.Sprintf("staff:%d", staffByStore[store.id]), toUTC(e.when)})
					state[w.itemID] -= qty
				}
			case "order":
				p := e.data.(hPlan)
				ol := make([]orderLine, len(p.lines))
				for k, l := range p.lines {
					ol[k] = orderLine{l.variantID, l.qty}
				}
				need := requirements(ol, recipeMap)
				short := false
				for i, n := range need {
					if state[i]-reserved[i]-stock[i].safety < n {
						short = true
						break
					}
				}
				if short {
					continue // 売り切れ（この注文は入らなかった）
				}
				oidx := len(accepted)
				order := &hOrder{plan: p, need: need, publicID: publicIDs[oidx], oidx: oidx}
				accepted = append(accepted, order)
				for i, n := range need {
					reserved[i] += n
				}
				rng := historyRng("flow", p.keyString(), p.storeID)
				tPaid := p.placed.Add(time.Duration(rng.randint(30, 120)) * time.Second)
				order.times = map[string]time.Time{"placed": p.placed}
				if p.outcome == "completed" || p.outcome == "cancel_staff" {
					order.times["paid"] = tPaid
					order.times["accepted"] = tPaid.Add(time.Duration(rng.randint(20, 120)) * time.Second)
				}
				var tFollow time.Time
				var fKind string
				if p.outcome == "completed" {
					order.times["preparing"] = order.times["accepted"].Add(time.Duration(rng.randint(30, 120)) * time.Second)
					order.times["ready"] = order.times["preparing"].Add(time.Duration(rng.randint(3, 8)) * time.Minute)
					order.times["completed"] = order.times["ready"].Add(time.Duration(rng.randint(1, 5)) * time.Minute)
					tFollow, fKind = order.times["preparing"], "consume"
				} else if p.outcome == "cancel_staff" {
					order.times["cancelled"] = order.times["accepted"].Add(time.Duration(rng.randint(30, 180)) * time.Second)
					tFollow, fKind = order.times["cancelled"], "release"
				} else {
					// Python は辞書の値を全部先に作る（乱数を 2 回引く）。その後で、結果の種類の値を取る
					custWait := rng.randint(60, 360)
					declWait := rng.randint(20, 90)
					timeoutWait := int(reservationTTL.Seconds())
					wait := map[string]int{"cancel_customer": custWait, "cancel_declined": declWait, "cancel_timeout": timeoutWait}[p.outcome]
					order.times["cancelled"] = p.placed.Add(time.Duration(wait) * time.Second)
					tFollow, fKind = order.times["cancelled"], "release"
				}
				actor := fmt.Sprintf("customer:%d", userOf(p))
				for _, i := range sortedKeys(need) {
					movements = append(movements, hMovement{store.id, i, "reserve", need[i], "order", ptr(order.publicID), nil, actor, toUTC(p.placed)})
				}
				followup++
				heap.Push(&h, hEvent{tFollow, 1, -followup, fKind, order})
			default: // consume / release（注文の続き）
				order := e.data.(*hOrder)
				p := order.plan
				staff := fmt.Sprintf("staff:%d", staffByStore[store.id])
				for _, i := range sortedKeys(order.need) {
					n := order.need[i]
					reserved[i] -= n
					if e.kind == "consume" {
						state[i] -= n
						movements = append(movements, hMovement{store.id, i, "consume", -n, "order", ptr(order.publicID), nil, staff, toUTC(e.when)})
					} else {
						actor := "system"
						switch p.outcome {
						case "cancel_customer":
							actor = fmt.Sprintf("customer:%d", userOf(p))
						case "cancel_staff":
							actor = staff
						}
						reason := map[string]string{"cancel_customer": "customer_request", "cancel_declined": "payment_declined", "cancel_timeout": "payment_timeout", "cancel_staff": "材料切れ"}[p.outcome]
						movements = append(movements, hMovement{store.id, i, "release", -n, "order", ptr(order.publicID), &reason, actor, toUTC(e.when)})
					}
				}
			}
		}
		for _, i := range itemIDs {
			finalStock[[2]int{store.id, i}] = state[i]
			if reserved[i] != 0 {
				panic("確保が残っています")
			}
		}
	}

	// ---- 受け取り番号（店 × 営業日の連番。受け付けた順）----
	type counterKey struct {
		store int
		day   dateOnly
	}
	counters := map[counterKey]int{}
	sortedOrders := append([]*hOrder(nil), accepted...)
	sort.SliceStable(sortedOrders, func(i, j int) bool {
		a, b := sortedOrders[i], sortedOrders[j]
		if !a.plan.placed.Equal(b.plan.placed) {
			return a.plan.placed.Before(b.plan.placed)
		}
		return a.oidx < b.oidx
	})
	for _, o := range sortedOrders {
		k := counterKey{o.plan.storeID, dateOf(o.plan.placed)}
		counters[k]++
		o.pickupNo = counters[k]
	}

	n := writeHistory(t, accepted, func() []counterRow {
		var rows []counterRow
		for k, v := range counters {
			rows = append(rows, counterRow{k.store, k.day, v})
		}
		sort.Slice(rows, func(i, j int) bool {
			if rows[i].store != rows[j].store {
				return rows[i].store < rows[j].store
			}
			return rows[i].day.before(rows[j].day)
		})
		return rows
	}(), movements, finalStock, userIDs, staffByStore, variants, toUTC)
	n = append(n, countKV{"store_closures", len(temporaryClosures)})
	key := analyticsPseudonymKey(true) // 開発用の固定の鍵を許すのは、seed のときだけ
	start := windowStart
	res := analyticsBuild(t, today, key, offset, asOf, &start, nil, false)
	_ = res // 件数は、要約に出さない（"analytics" の項目）
	n = append(n, countKV{"analytics", len(res.counts)})
	return n
}

func sortedStressedKeys() []stressedKey {
	keys := make([]stressedKey, 0, len(stressedStock))
	for k := range stressedStock {
		keys = append(keys, k)
	}
	return keys
}

type counterRow struct {
	store int
	day   dateOnly
	last  int
}

func dateTime(d dateOnly) time.Time { return d.time() }

func writeHistory(t *tx, accepted []*hOrder, counters []counterRow, movements []hMovement, finalStock map[[2]int]int, userIDs map[string]int,
	staffByStore map[int]int, variants map[string][]hVariant, toUTC func(time.Time) time.Time) []countKV {
	variantByID := map[int]hVariant{}
	for _, vs := range variants {
		for _, v := range vs {
			variantByID[v.id] = v
		}
	}
	names := map[string]string{}
	for _, r := range t.all("SELECT code, name FROM menu_items") {
		names[r.s("code")] = r.s("name")
	}
	var orderRows, itemRows, eventRows, paymentRows, loyaltyRows, reservationRows [][]any
	type resRow struct {
		publicID string
		status   string
		created  time.Time
		updated  time.Time
		need     map[int]int
	}
	var reservations []resRow
	cancelReasons := map[string]string{"cancel_customer": "customer_request", "cancel_declined": "payment_declined", "cancel_timeout": "payment_timeout", "cancel_staff": "材料切れ"}
	for _, o := range accepted { // oidx の順
		p := o.plan
		tt := o.times
		subtotal := 0
		for _, l := range p.lines {
			subtotal += variantByID[l.variantID].price * l.qty
		}
		status := "cancelled"
		if p.outcome == "completed" {
			status = "completed"
		}
		staffID := strconv.Itoa(staffByStore[p.storeID])
		var cancelReason any
		if status != "completed" {
			cancelReason = cancelReasons[p.outcome]
		}
		uid := userIDs[fmt.Sprintf("dev:hist-%03d", p.customer)]
		opt := func(key string) any {
			if v, ok := tt[key]; ok {
				return toUTC(v)
			}
			return nil
		}
		orderRows = append(orderRows, []any{
			o.publicID, int32(uid), int32(p.storeID), status, "pickup", int32(o.pickupNo), dateTime(dateOf(p.placed)), int32(subtotal), int32(0), int32(subtotal), "screen", "seed-" + o.publicID,
			toUTC(tt["placed"]), opt("paid"), opt("accepted"), opt("ready"), opt("completed"), opt("cancelled"), cancelReason,
		})
		for _, l := range sortedLines(p.lines) {
			v := variantByID[l.variantID]
			itemRows = append(itemRows, []any{o.publicID, int32(l.variantID), names[v.itemCode], v.size, v.temperature, int32(v.price), int32(l.qty), int32(v.price * l.qty)})
		}
		// 履歴（order_events）。支払いは、いつも system
		type step struct {
			from, to, actorType string
			actorID, reason     any
			at                  time.Time
		}
		steps := []step{{"", "placed", "customer", strconv.Itoa(uid), nil, tt["placed"]}}
		var payStatus string
		switch p.outcome {
		case "completed":
			steps = append(steps,
				step{"placed", "paid", "system", nil, nil, tt["paid"]}, step{"paid", "accepted", "staff", staffID, nil, tt["accepted"]},
				step{"accepted", "preparing", "staff", staffID, nil, tt["preparing"]}, step{"preparing", "ready", "staff", staffID, nil, tt["ready"]},
				step{"ready", "completed", "staff", staffID, nil, tt["completed"]})
			payStatus = "paid"
		case "cancel_staff":
			steps = append(steps,
				step{"placed", "paid", "system", nil, nil, tt["paid"]}, step{"paid", "accepted", "staff", staffID, nil, tt["accepted"]},
				step{"accepted", "cancelled", "staff", staffID, cancelReason, tt["cancelled"]})
			payStatus = "refunded"
		default:
			var actorType string
			var actorID any
			if p.outcome == "cancel_customer" {
				actorType, actorID = "customer", strconv.Itoa(uid)
			} else {
				actorType = "system"
			}
			steps = append(steps, step{"placed", "cancelled", actorType, actorID, cancelReason, tt["cancelled"]})
			payStatus = "failed"
		}
		for _, s := range steps {
			var from any
			if s.from != "" {
				from = s.from
			}
			eventRows = append(eventRows, []any{o.publicID, from, s.to, s.actorType, s.actorID, s.reason, toUTC(s.at)})
		}
		upd := tt["placed"]
		if v, ok := tt["paid"]; ok {
			upd = v
		} else if v, ok := tt["cancelled"]; ok {
			upd = v
		}
		paymentRows = append(paymentRows, []any{o.publicID, "mock", payStatus, int32(subtotal), toUTC(tt["placed"]), toUTC(upd)})
		resStatus := "released"
		if p.outcome == "completed" {
			resStatus = "consumed"
		} else if p.outcome == "cancel_timeout" {
			resStatus = "expired"
		}
		end, ok := tt["completed"]
		if !ok {
			end = tt["cancelled"]
		}
		reservations = append(reservations, resRow{o.publicID, resStatus, toUTC(tt["placed"]), toUTC(end), o.need})
		if status == "completed" && subtotal/loyaltyLumiPerPoint > 0 {
			loyaltyRows = append(loyaltyRows, []any{o.publicID, int32(uid), int32(subtotal / loyaltyLumiPerPoint), "earn", toUTC(tt["completed"])})
		}
	}
	_ = reservationRows

	copyRows := func(table string, cols []string, rows [][]any) {
		if len(rows) == 0 {
			return
		}
		if _, err := t.t.CopyFrom(t.ctx, pgx.Identifier{table}, cols, pgx.CopyFromRows(rows)); err != nil {
			panic(dbError{err})
		}
	}
	copyRows("orders", strings.Split("public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, delivery_fee_lumi, total_lumi, source, idempotency_key, placed_at, paid_at, accepted_at, ready_at, completed_at, cancelled_at, cancel_reason", ", "), orderRows)
	ids := map[string]int32{}
	for _, r := range t.all("SELECT public_id, id FROM orders WHERE idempotency_key LIKE 'seed-%'") {
		ids[r.s("public_id")] = int32(r.i("id"))
	}
	withID := func(rows [][]any) [][]any {
		out := make([][]any, len(rows))
		for i, r := range rows {
			out[i] = append([]any{ids[r[0].(string)]}, r[1:]...)
		}
		return out
	}
	copyRows("order_items", []string{"order_id", "variant_id", "name", "size", "temperature", "unit_price_lumi", "qty", "line_total_lumi"}, withID(itemRows))
	copyRows("order_events", []string{"order_id", "from_status", "to_status", "actor_type", "actor_id", "reason", "at"}, withID(eventRows))
	copyRows("payments", []string{"order_id", "provider", "status", "amount_lumi", "created_at", "updated_at"}, withID(paymentRows))
	var resRows [][]any
	for _, r := range reservations {
		resRows = append(resRows, []any{ids[r.publicID], r.status, nil, r.created, r.updated})
	}
	copyRows("stock_reservations", []string{"order_id", "status", "expires_at", "created_at", "updated_at"}, resRows)
	resIDs := map[int32]int32{}
	for _, r := range t.all("SELECT order_id, id FROM stock_reservations") {
		resIDs[int32(r.i("order_id"))] = int32(r.i("id"))
	}
	var lineRows [][]any
	for _, r := range reservations {
		for _, itemID := range sortedKeys(r.need) {
			lineRows = append(lineRows, []any{resIDs[ids[r.publicID]], int32(itemID), int32(r.need[itemID])})
		}
	}
	copyRows("stock_reservation_lines", []string{"reservation_id", "item_id", "qty"}, lineRows)
	copyRows("loyalty_ledger", []string{"order_id", "user_id", "points", "kind", "at"}, withID(loyaltyRows))
	var counterRows [][]any
	for _, c := range counters {
		counterRows = append(counterRows, []any{int32(c.store), dateTime(c.day), int32(c.last)})
	}
	copyRows("store_order_counters", []string{"store_id", "business_date", "last_no"}, counterRows)
	sort.SliceStable(movements, func(i, j int) bool {
		a, b := movements[i], movements[j]
		if !a.at.Equal(b.at) {
			return a.at.Before(b.at)
		}
		if a.storeID != b.storeID {
			return a.storeID < b.storeID
		}
		if a.itemID != b.itemID {
			return a.itemID < b.itemID
		}
		return a.kind < b.kind
	})
	var moveRows [][]any
	for _, m := range movements {
		var refID, reason any
		if m.refID != nil {
			refID = *m.refID
		}
		if m.reason != nil {
			reason = *m.reason
		}
		moveRows = append(moveRows, []any{int32(m.storeID), int32(m.itemID), m.kind, int32(m.qty), m.refType, refID, reason, m.actor, m.at})
	}
	copyRows("stock_movements", []string{"store_id", "item_id", "kind", "qty", "ref_type", "ref_id", "reason", "actor", "occurred_at"}, moveRows)
	t.exec("UPDATE users u SET loyalty_points = s.points FROM (SELECT user_id, sum(points)::int AS points FROM loyalty_ledger GROUP BY user_id) s WHERE s.user_id = u.id")
	keys := make([][2]int, 0, len(finalStock))
	for k := range finalStock {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i][0] != keys[j][0] {
			return keys[i][0] < keys[j][0]
		}
		return keys[i][1] < keys[j][1]
	})
	for _, k := range keys {
		t.exec("UPDATE stock_balances SET on_hand = $1, reserved = 0 WHERE store_id = $2 AND item_id = $3", finalStock[k], k[0], k[1])
	}
	return []countKV{{"orders", len(orderRows)}, {"order_items", len(itemRows)}, {"order_events", len(eventRows)}, {"stock_movements", len(moveRows)}, {"users", len(userIDs)}}
}

func sortedLines(lines []lineQty) []lineQty {
	out := append([]lineQty(nil), lines...)
	sort.Slice(out, func(i, j int) bool { return out[i].variantID < out[j].variantID })
	return out
}

// resetAnalytics は seed --reset が、元の表を空にする前に呼ぶ。analytics の表も空にする（無ければ何もしない。DROP はしない）。
func resetAnalytics(t *tx) {
	if t.one("SELECT to_regclass('analytics.build_state')::text AS r").isNull("r") {
		return
	}
	for _, table := range []string{"daily_store_summary", "daily_store_item_sales", "daily_store_hourly", "daily_stock_levels", "daily_stock_waste",
		"customer_rfm", "customer_monthly", "customer_pseudonyms", "build_state"} {
		t.exec("DELETE FROM analytics." + table) // 固定の表名
	}
}
