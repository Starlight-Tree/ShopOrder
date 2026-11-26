package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// argon2 の同時実行が argonMaxConcurrent を超えないこと、待たされた分も全部実行されること。
func TestWithArgonSlotLimitsConcurrency(t *testing.T) {
	const callers = 32
	var inFlight, peak, done atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			withArgonSlot(func() {
				n := inFlight.Add(1)
				for {
					p := peak.Load()
					if n <= p || peak.CompareAndSwap(p, n) {
						break
					}
				}
				time.Sleep(5 * time.Millisecond)
				inFlight.Add(-1)
				done.Add(1)
			})
		}()
	}
	wg.Wait()
	if got := peak.Load(); got > argonMaxConcurrent {
		t.Fatalf("同時実行の最大 = %d、上限は %d", got, argonMaxConcurrent)
	}
	if got := peak.Load(); got < 2 {
		t.Fatalf("並列に走っていない（最大 %d）。上限の実装が直列すぎる", got)
	}
	if done.Load() != callers {
		t.Fatalf("実行された件数 = %d、期待 %d", done.Load(), callers)
	}
}

// 上限を入れても、ハッシュの作成と検証は従来どおり合う。
func TestHashVerifyStillWorksThroughSlot(t *testing.T) {
	h := hashPassword("pw-1")
	if !verifyPassword(h, "pw-1") || verifyPassword(h, "pw-2") {
		t.Fatal("ハッシュの検証が合わない")
	}
}
