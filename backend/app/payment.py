"""決済の差し替え口（docs/decisions/0005）。既定は模擬（MockPayment）。settings.provider('PAYMENT_PROVIDER') で選び、許さない値は起動の設定ミスとして失敗する。

本物の決済を足すときは、ここに実装を足して settings.PROVIDERS に名前を足す（承認が先。P6）。本物は外部への通信を伴うので、
いまのように DB のトランザクションの中で呼ぶ形は作り直す（模擬は即時なので、トランザクション内で呼んでよい）。
"""

import secrets
from dataclasses import dataclass
from typing import Protocol

from app.settings import provider


@dataclass(frozen=True)
class ChargeResult:
    ok: bool
    provider_ref: str | None = None


@dataclass(frozen=True)
class RefundResult:
    ok: bool


class PaymentProvider(Protocol):
    name: str

    def charge(self, *, order_ref: str, amount_lumi: int, simulate: str) -> ChargeResult: ...

    def refund(self, *, provider_ref: str | None, amount_lumi: int) -> RefundResult: ...


class MockPayment:
    """模擬。simulate='ok' は成功、'decline' は失敗。カード番号などは扱わない。"""

    name = "mock"

    def charge(self, *, order_ref: str, amount_lumi: int, simulate: str) -> ChargeResult:
        if simulate == "decline":
            return ChargeResult(ok=False)
        return ChargeResult(ok=True, provider_ref=f"mock-{secrets.token_hex(8)}")

    def refund(self, *, provider_ref: str | None, amount_lumi: int) -> RefundResult:
        return RefundResult(ok=True)


_PROVIDERS: dict[str, type] = {"mock": MockPayment}


def get_provider() -> PaymentProvider:
    return _PROVIDERS[provider("PAYMENT_PROVIDER")]()
