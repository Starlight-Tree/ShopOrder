package main

// 時刻の入口（backend/app/clock.py の移植）。時刻を使う所は、すべてここ（utcNow / localNow）を呼ぶ。テストは freezeClock で差し替える。
//   - 保存・期限の比較は UTC（utcNow）。営業時間・定休日・期間・営業日は、店のあるローカル時刻（localNow）
//   - ローカル時刻は、環境変数 LOCAL_UTC_OFFSET_HOURS（既定 9。整数）で決める

import (
	"fmt"
	"sync"
	"time"
)

var (
	clockMu sync.RWMutex
	frozen  *time.Time
)

func utcNow() time.Time {
	clockMu.RLock()
	defer clockMu.RUnlock()
	if frozen != nil {
		return *frozen
	}
	return time.Now().UTC().Truncate(time.Microsecond)
}

func localZone(offsetHours int) *time.Location {
	return time.FixedZone("", offsetHours*3600)
}

// localNow は店のローカル時刻（タイムゾーンつき）。
func localNow() time.Time { return utcNow().In(localZone(localUTCOffsetHours())) }

// freezeClock はテスト用: 時刻を固定する。nil で戻す。
func freezeClock(t *time.Time) {
	clockMu.Lock()
	defer clockMu.Unlock()
	if t == nil {
		frozen = nil
		return
	}
	u := t.UTC()
	frozen = &u
}

// isoTime は API の日時（ISO 8601。UTC・`Z` つき。マイクロ秒が 0 のときは小数部なし）。Python の isoformat と同じ。
func isoTime(t time.Time) string {
	u := t.UTC()
	if us := u.Nanosecond() / 1000; us != 0 {
		return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d.%06dZ", u.Year(), int(u.Month()), u.Day(), u.Hour(), u.Minute(), u.Second(), us)
	}
	return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02dZ", u.Year(), int(u.Month()), u.Day(), u.Hour(), u.Minute(), u.Second())
}

func isoTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := isoTime(*t)
	return &s
}

// dateOnly は日付だけ（Y-M-D）の値。DB へは文字列（"2026-11-21"）で渡す（time.Time だと timestamptz になって、日付の比較がずれうる）。
type dateOnly struct{ y, m, d int }

func dateOf(t time.Time) dateOnly { return dateOnly{t.Year(), int(t.Month()), t.Day()} }

func (d dateOnly) String() string { return fmt.Sprintf("%04d-%02d-%02d", d.y, d.m, d.d) }

func (d dateOnly) time() time.Time { return time.Date(d.y, time.Month(d.m), d.d, 0, 0, 0, 0, time.UTC) }

func (d dateOnly) addDays(n int) dateOnly { return dateOf(d.time().AddDate(0, 0, n)) }

// isoWeekday は 1 = 月 … 7 = 日（Python の isoweekday）。
func (d dateOnly) isoWeekday() int {
	w := int(d.time().Weekday())
	if w == 0 {
		return 7
	}
	return w
}

func (d dateOnly) before(o dateOnly) bool { return d.time().Before(o.time()) }

func (d dateOnly) daysSince(o dateOnly) int {
	return int(d.time().Sub(o.time()).Hours() / 24)
}

func parseDate(s string) (dateOnly, bool) {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return dateOnly{}, false
	}
	return dateOf(t), true
}
