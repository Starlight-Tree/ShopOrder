"""設計の既定の数字（docs/order-flow.md・docs/api.md）。実測ではなく、設計で決めた値。変えるときは、ここだけを直す。"""

from datetime import timedelta

MAX_LINES = 30  # 1 注文の行（品の種類）の上限
MAX_QTY = 20  # 1 行の数量の上限
MAX_TOTAL_LUMI = 30_000  # 1 注文の合計の上限（ルミ）
IDEMPOTENCY_KEY_MIN = 8
IDEMPOTENCY_KEY_MAX = 64
MAX_UNPAID_ORDERS = 2  # 1 人が同時に持てる、未払い（placed）の注文の数。超えたら 409
REASON_MAX = 200  # 取消し・調整の理由の文字数

PROPOSAL_TTL = timedelta(minutes=10)  # 確定の許可証の有効期間
RESERVATION_TTL = timedelta(minutes=15)  # 確定から支払いまでの在庫の確保の期間
STAFF_SESSION_TTL = timedelta(hours=12)

LOGIN_MAX_FAILURES = 5  # email ごとに、この窓の中で許す失敗の回数（超えたら 429）
LOGIN_WINDOW = timedelta(minutes=15)

LOYALTY_LUMI_PER_POINT = 100  # 会計 100 ルミごとに 1 点（docs/world.md「ポイント」）

STAFF_ORDER_LIST_LIMIT = 200
CUSTOMER_ORDER_LIST_LIMIT = 50
EXPIRE_BATCH = 100  # expire_stale が 1 回で戻す件数の上限

TX_RETRIES = 3  # デッドロック（40P01）・直列化失敗（40001）の再試行の回数
