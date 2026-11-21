"""テストの道具。API は TestClient 経由で呼び、台帳・残高の確認だけ、別の接続で DB を直接読む。"""

import uuid

import psycopg
from psycopg.rows import dict_row


def code_of(response) -> str | None:
    """エラー応答の detail.code（形の誤りの 422 は配列なので None）。"""
    detail = response.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else None


class Shop:
    def __init__(self, client, db_url: str):
        self.client = client
        self.db_url = db_url
        self._stores = {s["code"]: s for s in client.get("/api/stores").json()}
        self._variants: dict[tuple[str, str, str], int] = {}
        for item in client.get("/api/menu").json():
            for v in item["variants"]:
                self._variants[(item["code"], v["size"], v["temperature"])] = v["id"]
        self._staff_tokens: dict[str, str] = {}

    # ---- 参照 ----
    def store_id(self, code: str) -> int:
        return self._stores[code]["id"]

    def variant(self, item_code: str, size: str = "-", temperature: str = "-") -> int:
        return self._variants[(item_code, size, temperature)]

    def db(self) -> psycopg.Connection:
        return psycopg.connect(self.db_url, row_factory=dict_row, autocommit=True)

    # ---- 利用者・スタッフ ----
    @staticmethod
    def user() -> dict:
        return {"X-Dev-User": f"t-{uuid.uuid4().hex[:12]}"}

    def login(self, email: str, password: str = "test-staff-pass"):
        return self.client.post("/api/staff/login", json={"email": email, "password": password})

    def staff(self, store_code: str | None = None) -> dict:
        """デモのスタッフ（store_code が None なら店長）の Bearer ヘッダー。トークンは使い回す。"""
        email = "manager@oasis-cafe.example" if store_code is None else f"staff-{store_code}@oasis-cafe.example"
        if email not in self._staff_tokens:
            r = self.login(email)
            assert r.status_code == 200, r.text
            self._staff_tokens[email] = r.json()["token"]
        return {"Authorization": f"Bearer {self._staff_tokens[email]}"}

    def make_staff(self, role: str, store_code: str | None, password: str = "pw-for-tests-1") -> str:
        """テスト専用のスタッフを作る（email を返す）。デモのスタッフを巻き込まないために使う（ログイン失敗の制限など）。"""
        from app import auth

        email = f"{uuid.uuid4().hex[:10]}@oasis-cafe.example"
        store_id = self.store_id(store_code) if store_code else None
        with self.db() as conn:
            conn.execute(
                "INSERT INTO staff_accounts (store_id, role, name, email, password_hash) VALUES (%s, %s, %s, %s, %s)",
                (store_id, role, "テスト用", email, auth.hash_password(password)),
            )
        return email

    # ---- カート → 提案 → 確定 ----
    def fill_cart(self, headers: dict, store_code: str, lines: list[tuple[int, int]]) -> None:
        r = self.client.put("/api/cart", json={"store_id": self.store_id(store_code), "fulfillment": "pickup"}, headers=headers)
        assert r.status_code == 200, r.text
        for variant_id, qty in lines:
            r = self.client.put(f"/api/cart/items/{variant_id}", json={"qty": qty}, headers=headers)
            assert r.status_code == 200, r.text

    def proposal(self, headers: dict, store_code: str, lines: list[tuple[int, int]]) -> dict:
        self.fill_cart(headers, store_code, lines)
        r = self.client.post("/api/cart/checkout-proposal", headers=headers)
        assert r.status_code == 200, r.text
        return r.json()

    def place(self, headers: dict, proposal_id: str, key: str | None = None):
        return self.client.post(
            "/api/orders", json={"proposal_id": proposal_id}, headers={**headers, "Idempotency-Key": key or f"key-{uuid.uuid4().hex}"}
        )

    def order(self, headers: dict, store_code: str, lines: list[tuple[int, int]]) -> dict:
        """カート → 提案 → 確定まで通して、placed の注文を返す。"""
        p = self.proposal(headers, store_code, lines)
        r = self.place(headers, p["id"])
        assert r.status_code == 201, r.text
        return r.json()

    def paid_order(self, headers: dict, store_code: str, lines: list[tuple[int, int]]) -> dict:
        o = self.order(headers, store_code, lines)
        r = self.client.post(f"/api/orders/{o['public_id']}/pay", headers=headers)
        assert r.status_code == 200, r.text
        return r.json()

    def act(self, staff_headers: dict, public_id: str, action: str, reason: str | None = None):
        body = {"action": action} if reason is None else {"action": action, "reason": reason}
        return self.client.post(f"/api/staff/orders/{public_id}/transition", json=body, headers=staff_headers)

    def get_order(self, headers: dict, public_id: str) -> dict:
        r = self.client.get(f"/api/orders/{public_id}", headers=headers)
        assert r.status_code == 200, r.text
        return r.json()

    # ---- 在庫（DB を直接） ----
    def balance(self, store_code: str, item_code: str) -> tuple[int, int]:
        """(on_hand, reserved)"""
        with self.db() as conn:
            row = conn.execute(
                "SELECT b.on_hand, b.reserved FROM stock_balances b JOIN stock_items i ON i.id = b.item_id WHERE b.store_id = %s AND i.code = %s",
                (self.store_id(store_code), item_code),
            ).fetchone()
        return row["on_hand"], row["reserved"]

    def set_available(self, store_code: str, item_code: str, available: int) -> None:
        """今出せる量（on_hand - reserved - safety_stock）を、台帳の adjust で指定の数にする（台帳と残高を合わせたまま）。"""
        from app import clock, inventory

        with self.db() as conn:
            item = conn.execute("SELECT id, safety_stock FROM stock_items WHERE code = %s", (item_code,)).fetchone()
            on_hand, reserved = self.balance(store_code, item_code)
            delta = (reserved + item["safety_stock"] + available) - on_hand
            if delta:
                with conn.transaction():
                    inventory.adjust(conn, self.store_id(store_code), item["id"], delta, reason="テストの準備", actor="test", now=clock.utc_now())

    def movements(self, public_id: str) -> list[dict]:
        with self.db() as conn:
            return conn.execute(
                "SELECT i.code, m.kind, m.qty, m.actor FROM stock_movements m JOIN stock_items i ON i.id = m.item_id "
                "WHERE m.ref_type = 'order' AND m.ref_id = %s ORDER BY m.id",
                (public_id,),
            ).fetchall()

    def reconcile(self) -> list[dict]:
        from app import inventory

        with self.db() as conn:
            return inventory.reconcile(conn)
