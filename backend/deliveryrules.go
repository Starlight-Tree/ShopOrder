package main

// 宅配の、DB に触れない決まり（純粋な関数。backend/app/delivery_rules.py の移植）。値は docs/world.md「宅配」と docs/order-flow.md「宅配」。数字は「設計の既定」。
//   - 時間枠: 30 分。開店から 30 分ごと。最後の枠は、ラストオーダーの時刻に終わるもの。1 店 1 枠 4 件。受付の締めは、枠の開始の「準備 15 分 + リードタイム 30 分」前
//   - 送料: 区画ごとの基本料。品の小計が free_over 以上なら 0（ちょうどは無料）
//   - 暗証コード: 4 桁。集荷で作り、DB には nonce と HMAC のハッシュだけを持つ。5 回間違えたら凍結、有効は集荷から 24 時間
//   - 配達員の提案: proposers の関数（差し替えられる）。既定の nearest は、最後にいた区画から店の区画までの所要分が小さい順

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"time"
)

const (
	slotMinutes    = 30
	slotCapacity   = 4 // 1 店 1 枠 4 件（world.md）
	slotDaysAhead  = 7 // 枠を出す日数（今日を含めて 8 日分）
	prepMinutes    = 15
	leadMinutes    = 30
	pinDigits      = 4
	pinMaxAttempts = 5
	pinTTL         = 24 * time.Hour
	addressLimit   = 10 // 1 人が持てる住所の数
)

var activeStatuses = []string{"assigned", "picked_up", "delivering"} // 配達員の担当中（deliveries.status）

type slotTime struct{ start, end time.Time }

// slotGrid はその日（店のローカルの日付）の枠 [(開始, 終了)]（UTC）。開店から 30 分ごとで、終了がラストオーダーの時刻以内のもの。
func slotGrid(openTime, closeTime string, lastOrderMinutes int, day dateOnly, offsetHours int) []slotTime {
	tz := localZone(offsetHours)
	midnight := time.Date(day.y, time.Month(day.m), day.d, 0, 0, 0, 0, tz)
	step := time.Duration(slotMinutes) * time.Minute
	start := midnight.Add(time.Duration(todSeconds(openTime)) * time.Second)
	lastOrder := midnight.Add(time.Duration(todSeconds(closeTime))*time.Second - time.Duration(lastOrderMinutes)*time.Minute)
	var slots []slotTime
	for !start.Add(step).After(lastOrder) {
		slots = append(slots, slotTime{start.UTC(), start.Add(step).UTC()})
		start = start.Add(step)
	}
	return slots
}

// orderCutoff はこの時刻を過ぎたら、その枠は受け付けない（枠の開始の 45 分前）。
func orderCutoff(startsAt time.Time) time.Time {
	return startsAt.Add(-time.Duration(prepMinutes+leadMinutes) * time.Minute)
}

// slotUnavailableReason は枠を選べない理由。締めを過ぎていれば cutoff、満席なら full（締めを先に見る）。選べるなら nil。締めの時刻ちょうどは選べる。
func slotUnavailableReason(startsAt time.Time, booked, capacity int, now time.Time) *string {
	if now.After(orderCutoff(startsAt)) {
		return ptr("cutoff")
	}
	if booked >= capacity {
		return ptr("full")
	}
	return nil
}

func localDateOf(t time.Time, offsetHours int) dateOnly { return dateOf(t.In(localZone(offsetHours))) }

// deliveryFee は送料。品の小計が free_over 以上なら 0（2,000 ルミちょうどは無料）。
func deliveryFee(feeLumi int, freeOver *int, subtotal int) int {
	if freeOver != nil && subtotal >= *freeOver {
		return 0
	}
	return feeLumi
}

func meetsMinimum(subtotal, minOrder int) bool { return subtotal >= minOrder }

// etaAt は到着の目安。出発後（delivering）は「出発 + 基準の所要分」、それ以前は枠の開始。完了・不在・取消しは nil。
func etaAt(status string, slotStartsAt time.Time, departedAt *time.Time, baseMinutes int) *time.Time {
	switch status {
	case "delivered", "failed", "cancelled":
		return nil
	}
	if status == "delivering" && departedAt != nil {
		t := departedAt.Add(time.Duration(baseMinutes) * time.Minute)
		return &t
	}
	return &slotStartsAt
}

// ---- 暗証コード ----

func hmacSum(secret, message string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(message))
	return m.Sum(nil)
}

// derivePin は nonce から導く 4 桁（0 埋め）。同じ（秘密・配達・nonce）なら、いつも同じ。
func derivePin(secret string, deliveryID int, nonce string) string {
	n := binary.BigEndian.Uint32(hmacSum(secret, fmt.Sprintf("pin|%d|%s", deliveryID, nonce))[:4])
	return fmt.Sprintf("%04d", n%10000)
}

// pinHash は DB に置くハッシュ（HMAC）。
func pinHash(secret string, deliveryID int, pin string) string {
	return hex.EncodeToString(hmacSum(secret, fmt.Sprintf("check|%d|%s", deliveryID, pin)))
}

func pinMatches(secret string, deliveryID int, pin, stored string) bool {
	return hmac.Equal([]byte(pinHash(secret, deliveryID, pin)), []byte(stored))
}

// ---- 配達員の提案（差し替えられる）----

type courierCandidate struct {
	courierID   int
	name        string
	zoneID      *int // 最後にいた区画（nil は店にいる）
	activeCount int
	isOnDuty    bool
}

type proposal struct {
	courierID   int
	courierName string
	minutes     int // 最後にいた区画から店の区画までの所要分
}

type travelMatrix map[[2]int]int

type proposer func(candidates []courierCandidate, storeZoneID int, matrix travelMatrix) []proposal

// travelMinutes は区画 a から b までの分。同じ区画は 0。行が無い組み合わせは、逆向きの行を見る（それも無ければ大きな値で後ろへ回す）。
func travelMinutes(m travelMatrix, a, b int) int {
	if a == b {
		return 0
	}
	if v, ok := m[[2]int{a, b}]; ok {
		return v
	}
	if v, ok := m[[2]int{b, a}]; ok {
		return v
	}
	return 10_000
}

// nearest は勤務中の配達員を、(店の区画までの所要分, 担当中の件数, ID) の昇順に並べる。先頭が提案。
func nearest(candidates []courierCandidate, storeZoneID int, matrix travelMatrix) []proposal {
	type ranked struct {
		minutes, active, id int
		c                   courierCandidate
	}
	var rs []ranked
	for _, c := range candidates {
		if !c.isOnDuty {
			continue
		}
		minutes := 0
		if c.zoneID != nil {
			minutes = travelMinutes(matrix, *c.zoneID, storeZoneID)
		}
		rs = append(rs, ranked{minutes, c.activeCount, c.courierID, c})
	}
	sort.SliceStable(rs, func(i, j int) bool {
		a, b := rs[i], rs[j]
		if a.minutes != b.minutes {
			return a.minutes < b.minutes
		}
		if a.active != b.active {
			return a.active < b.active
		}
		return a.id < b.id
	})
	out := make([]proposal, 0, len(rs))
	for _, r := range rs {
		out = append(out, proposal{r.c.courierID, r.c.name, r.minutes})
	}
	return out
}

var proposers = map[string]proposer{"nearest": nearest}

func getProposer(name string) proposer {
	p, ok := proposers[name]
	if !ok {
		settingsFail("ASSIGNMENT_POLICY は nearest のどれかにしてください")
	}
	return p
}
