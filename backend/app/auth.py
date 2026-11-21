"""認証。顧客とスタッフは、アカウント・セッションが別（docs/api.md「認証」）。権限は API が毎回確認し、利用者・店・ロールはセッションから取る。

- 顧客: 開発の既定（AUTH_MODE=dev）はヘッダー X-Dev-User（[a-z0-9-]{1,40}。無ければ demo-customer）。APP_ENV=production で AUTH_MODE=dev なら起動を拒否する。
- スタッフ: POST /api/staff/login が返す不透明トークンを Authorization: Bearer で送る。保存するのは SHA-256 のハッシュだけ（有効 12 時間）。
  パスワードは argon2。失敗が続いたら 429（email ごと・15 分で 5 回まで。設計の既定は app/limits.py）。理由（email が無い・パスワードが違う）は分けない。
"""

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, Header

from app import clock, limits, settings
from app.db import connection
from app.errors import ApiError

_DEV_USER = re.compile(r"^[a-z0-9-]{1,40}$")
DEFAULT_DEV_USER = "demo-customer"
_hasher = PasswordHasher()
# 存在しない email のときも argon2 の検証を 1 回行い、応答の時間で email の有無が分からないようにする
_DUMMY_HASH = _hasher.hash("dummy-password-for-timing")


def check_startup() -> None:
    """起動時の検査。本番相当の環境で、開発専用の設定が残っていたら起動を拒否する（RuntimeError。別の値へ黙って落とさない）。"""
    settings.auth_mode()  # 許さない値は、ここで例外
    settings.order_hours_check()
    if settings.app_env() == "production":
        if settings.auth_mode() == "dev":
            raise RuntimeError("APP_ENV=production では AUTH_MODE=dev で起動できません")
        if not settings.order_hours_check():
            raise RuntimeError("APP_ENV=production では ORDER_HOURS_CHECK=off で起動できません")


# ---- ハッシュ ----

def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


# ---- 顧客 ----

@dataclass(frozen=True)
class Customer:
    id: int
    name: str


def current_customer(x_dev_user: Annotated[str | None, Header()] = None) -> Customer:
    if settings.auth_mode() != "dev":
        raise ApiError(401, "unauthorized")
    name = x_dev_user if x_dev_user is not None else DEFAULT_DEV_USER
    if not _DEV_USER.match(name):
        raise ApiError(401, "unauthorized")
    auth_user_id = f"dev:{name}"
    with connection() as conn:
        row = conn.execute("SELECT id, display_name FROM users WHERE auth_user_id = %s", (auth_user_id,)).fetchone()
        if row is None:
            row = conn.execute(
                "INSERT INTO users (auth_user_id, display_name) VALUES (%s, %s) "
                "ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id RETURNING id, display_name",
                (auth_user_id, name),
            ).fetchone()
    return Customer(id=row["id"], name=row["display_name"])


CustomerDep = Annotated[Customer, Depends(current_customer)]


# ---- スタッフ ----

@dataclass(frozen=True)
class StaffUser:
    id: int
    name: str
    role: str  # staff / courier / manager
    store_id: int | None  # manager は None なら全店

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "role": self.role, "store_id": self.store_id}

    @property
    def sees_all_stores(self) -> bool:
        return self.store_id is None


def _bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def current_staff(authorization: Annotated[str | None, Header()] = None) -> StaffUser:
    token = _bearer(authorization)
    if token is None:
        raise ApiError(401, "unauthorized")
    with connection() as conn:
        row = conn.execute(
            "SELECT a.id, a.name, a.role, a.store_id FROM staff_sessions s JOIN staff_accounts a ON a.id = s.staff_id "
            "WHERE s.token_hash = %s AND s.expires_at > %s AND a.is_active",
            (token_hash(token), clock.utc_now()),
        ).fetchone()
    if row is None:
        raise ApiError(401, "unauthorized")
    return StaffUser(id=row["id"], name=row["name"], role=row["role"], store_id=row["store_id"])


def staff_for_orders(staff: Annotated[StaffUser, Depends(current_staff)]) -> StaffUser:
    """注文・在庫を扱えるロール（staff・manager）。配達員（courier）は P2 で別に扱う。"""
    if staff.role not in ("staff", "manager"):
        raise ApiError(403, "forbidden")
    return staff


StaffDep = Annotated[StaffUser, Depends(current_staff)]
OrderStaffDep = Annotated[StaffUser, Depends(staff_for_orders)]


def login(email: str, password: str) -> dict:
    """成功なら {token, expires_at, staff}。失敗は ApiError（401 / 429）。失敗の記録は、応答の前に commit する。"""
    now = clock.utc_now()
    eh = email_hash(email)
    outcome: dict | None = None
    locked = False
    with connection() as conn:
        conn.execute("DELETE FROM staff_login_attempts WHERE at < %s", (now - timedelta(days=1),))
        conn.execute("DELETE FROM staff_sessions WHERE expires_at < %s", (now,))
        failures = conn.execute(
            "SELECT count(*) AS n FROM staff_login_attempts WHERE email_hash = %s AND at > %s", (eh, now - limits.LOGIN_WINDOW)
        ).fetchone()["n"]
        if failures >= limits.LOGIN_MAX_FAILURES:
            locked = True
        else:
            row = conn.execute(
                "SELECT id, name, role, store_id, password_hash, is_active FROM staff_accounts WHERE email = %s", (email.strip().lower(),)
            ).fetchone()
            ok = verify_password(row["password_hash"] if row else _DUMMY_HASH, password) and row is not None and row["is_active"]
            if not ok:
                conn.execute("INSERT INTO staff_login_attempts (email_hash, at) VALUES (%s, %s)", (eh, now))
            else:
                conn.execute("DELETE FROM staff_login_attempts WHERE email_hash = %s", (eh,))
                token = secrets.token_urlsafe(32)
                expires_at = now + limits.STAFF_SESSION_TTL
                conn.execute(
                    "INSERT INTO staff_sessions (token_hash, staff_id, expires_at, created_at) VALUES (%s, %s, %s, %s)",
                    (token_hash(token), row["id"], expires_at, now),
                )
                staff = StaffUser(id=row["id"], name=row["name"], role=row["role"], store_id=row["store_id"])
                outcome = {"token": token, "expires_at": expires_at, "staff": staff}
    if locked:
        raise ApiError(429, "too_many_attempts")
    if outcome is None:
        raise ApiError(401, "invalid_credentials")
    return outcome


def logout(token: str) -> None:
    with connection() as conn:
        conn.execute("DELETE FROM staff_sessions WHERE token_hash = %s", (token_hash(token),))


def bearer_token(authorization: str | None) -> str | None:
    return _bearer(authorization)
