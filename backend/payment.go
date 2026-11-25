package main

// 決済の差し替え口（docs/decisions/0005）。既定は模擬（mockPayment）。provider("PAYMENT_PROVIDER") で選び、許さない値は設定ミスとして失敗する。
// 模擬は即時なので、DB のトランザクションの中で呼んでよい。本物の決済を足すときは、ここに実装を足す（承認が先。P6）。

import (
	"crypto/rand"
	"encoding/hex"
)

type chargeResult struct {
	ok          bool
	providerRef *string
}

type paymentProvider interface {
	name() string
	charge(orderRef string, amountLumi int, simulate string) chargeResult
	refund(providerRef *string, amountLumi int) bool
}

type mockPayment struct{}

func (mockPayment) name() string { return "mock" }

// charge は simulate='ok' は成功、'decline' は失敗。カード番号などは扱わない。
func (mockPayment) charge(orderRef string, amountLumi int, simulate string) chargeResult {
	if simulate == "decline" {
		return chargeResult{ok: false}
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("乱数を読めません")
	}
	return chargeResult{ok: true, providerRef: ptr("mock-" + hex.EncodeToString(b))}
}

func (mockPayment) refund(providerRef *string, amountLumi int) bool { return true }

func getPaymentProvider() paymentProvider {
	switch provider("PAYMENT_PROVIDER") {
	default:
		return mockPayment{}
	}
}
