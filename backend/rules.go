package main

// 店が今、注文を受けられるか。品が今、出せるか（backend/app/rules.py の移植）。時刻は、呼ぶ側が localNow() で渡す（ここでは時計を読まない）。
//   - 店: MO 不可店・臨時休業は常に見る。定休日・営業時間・ラストオーダーは ORDER_HOURS_CHECK=off のとき見ない（開発の便宜）
//   - 品: 季節の期間（'MM-DD'。年またぎも扱う）は常に見る。販売の時間帯は ORDER_HOURS_CHECK=off のとき見ない
//   - 境目: ラストオーダーの時刻ちょうど・sold_until ちょうどは「出せる」（秒まで比べ、それを過ぎたら出せない）。閉店の時刻ちょうどは「時間外」

import (
	"strconv"
	"strings"
	"time"
)

// todSeconds は time 型（::text で受けた "HH:MM:SS" か "HH:MM:SS.ffffff"）の 0 時からの秒数。
func todSeconds(s string) int {
	parts := strings.SplitN(s, ":", 3)
	h, _ := strconv.Atoi(parts[0])
	m, _ := strconv.Atoi(parts[1])
	sec := 0
	if len(parts) > 2 {
		sec, _ = strconv.Atoi(strings.SplitN(parts[2], ".", 2)[0])
	}
	return h*3600 + m*60 + sec
}

func hhmm(s string) string { return s[:5] }

func hhmmPtr(s *string) *string {
	if s == nil {
		return nil
	}
	v := hhmm(*s)
	return &v
}

func secondsOfDay(t time.Time) int { return t.Hour()*3600 + t.Minute()*60 + t.Second() }

// closedReason は店が今、注文を受けられない理由。受けられるなら nil。store は stores の行（open_time・close_time は ::text）。
func closedReason(store row, hasClosureToday bool, nowLocal time.Time) *string {
	if !store.b("mobile_order") {
		return ptr("mobile_order_unavailable")
	}
	if hasClosureToday {
		return ptr("temporary_closure")
	}
	if !orderHoursCheck() {
		return nil
	}
	if cw := store.iN("closed_weekday"); cw != nil && *cw == isoWeekday(nowLocal) {
		return ptr("closed_today")
	}
	now := secondsOfDay(nowLocal)
	open, closeS := todSeconds(store.s("open_time")), todSeconds(store.s("close_time"))
	if now < open || now >= closeS {
		return ptr("outside_hours")
	}
	if now > closeS-store.i("last_order_minutes")*60 {
		return ptr("past_last_order")
	}
	return nil
}

func isoWeekday(t time.Time) int {
	w := int(t.Weekday())
	if w == 0 {
		return 7
	}
	return w
}

// inSeason は month_day・from・to が 'MM-DD'。from > to は年またぎ。両端を含む。
func inSeason(monthDay string, from, to *string) bool {
	if from == nil || to == nil {
		return true
	}
	if *from <= *to {
		return *from <= monthDay && monthDay <= *to
	}
	return monthDay >= *from || monthDay <= *to
}

// itemUnavailableReason は季節・時間帯で出せない理由（在庫は見ない）。item は menu_items の行（sold_from・sold_until は ::text）。
func itemUnavailableReason(item row, nowLocal time.Time) *string {
	if !item.b("is_active") {
		return ptr("out_of_season") // 契約の理由は 3 つだけ。取り下げた品は、期間外と同じ扱いにする
	}
	if !inSeason(nowLocal.Format("01-02"), item.sN("season_from"), item.sN("season_to")) {
		return ptr("out_of_season")
	}
	if orderHoursCheck() {
		now := secondsOfDay(nowLocal)
		if sf := item.sN("sold_from"); sf != nil && now < todSeconds(*sf) {
			return ptr("out_of_hours")
		}
		if su := item.sN("sold_until"); su != nil && now > todSeconds(*su) {
			return ptr("out_of_hours")
		}
	}
	return nil
}
