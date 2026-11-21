-- 顧客・カート・スタッフの表（docs/data-model.md「顧客と注文」「スタッフ」）。新しい表と索引を作るだけ。
-- ロック: 既存の表への ALTER・書き込みは無い。参照先の stores・menu_variants には、外部キーの作成の間だけ SHARE ROW EXCLUSIVE
--         （書き込みを待たせ、読み取りは通す）がかかる。どちらも小さい表で、一瞬で終わる。
-- 個人情報: users.display_name・users.email（🔒）、staff_accounts.name・email・password_hash。ログに出さない。
--           パスワードは argon2 のハッシュだけを保存する（平文は持たない）。セッションのトークンも SHA-256 のハッシュだけ。
--           staff_login_attempts は、email を SHA-256 にしたものだけを持つ（メールアドレスそのものは入れない）。

-- 顧客。auth_user_id は認証側（開発の既定は 'dev:<名前>'。Better Auth は P6）の ID。
CREATE TABLE users (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id    text    NOT NULL UNIQUE,
  display_name    text    NOT NULL,
  email           text,
  loyalty_points  integer NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 下書きのカート（1 利用者に 1 つ）。変更のたびに version を上げる。価格は持たない（いつも今のメニューから計算する）。
CREATE TABLE carts (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  store_id    integer REFERENCES stores(id) ON DELETE RESTRICT,
  fulfillment text    NOT NULL DEFAULT 'pickup' CHECK (fulfillment IN ('pickup', 'delivery')),
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  cart_id     integer NOT NULL REFERENCES carts(id) ON DELETE RESTRICT,
  variant_id  integer NOT NULL REFERENCES menu_variants(id) ON DELETE RESTRICT,
  qty         integer NOT NULL CHECK (qty BETWEEN 1 AND 20),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, variant_id)
);

-- 確定ボタンの許可証。カートの版・合計・期限に結び付き、版が変われば無効。
CREATE TABLE checkout_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id       integer NOT NULL REFERENCES carts(id) ON DELETE RESTRICT,
  cart_version  integer NOT NULL,
  total_lumi    integer NOT NULL CHECK (total_lumi >= 0),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkout_proposals_cart ON checkout_proposals (cart_id);

-- スタッフ・配達員・店長。manager 以外は store_id が必須（manager は store_id が NULL なら全店）。
CREATE TABLE staff_accounts (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id       integer REFERENCES stores(id) ON DELETE RESTRICT,
  role           text    NOT NULL CHECK (role IN ('staff', 'courier', 'manager')),
  name           text    NOT NULL,
  email          text    NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash  text    NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (role = 'manager' OR store_id IS NOT NULL)
);

CREATE TABLE staff_sessions (
  token_hash  text PRIMARY KEY,
  staff_id    integer NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_sessions_staff ON staff_sessions (staff_id);

-- ログインの失敗の記録（レート制限用。email の SHA-256 だけ。成功すると、その email の分を消す）。
CREATE TABLE staff_login_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_hash  text NOT NULL,
  at          timestamptz NOT NULL
);
CREATE INDEX staff_login_attempts_lookup ON staff_login_attempts (email_hash, at);
