-- チャット（P3）の表（docs/chat.md、docs/data-model.md「チャット」）。新しい表と索引を作るだけ。
-- 番号は 0007（0005・0006 は並行して作る別の担当が使う）。
-- ロック: 既存の表への ALTER・書き込みは無い。参照先の users・stores には、外部キーの作成の間だけ SHARE ROW EXCLUSIVE
--         （書き込みを待たせ、読み取りは通す）がかかる。どちらも小さい表で、一瞬で終わる。
-- 個人情報: chat_messages.content・cards、chat_tool_calls.args・result は、会話の本文と注文の中身を含む（🔒）。
--           ログ・分析に出さない。保存期間（設定値 CHAT_RETENTION_DAYS）を過ぎたスレッドは、子の行ごと消す（アプリが行う）。
--           chat_usage は、件数だけを持つ（本文を持たない）。スレッドを消しても残り、1 日の上限を回避できないようにする。

-- 会話。利用者と店は、作ったときに固定する（ツールの引数からは決めない）。
-- busy_until は、1 つのスレッドで同時に 1 ターンしか動かさないための貸し出し（期限つき。落ちても期限で外れる）。
CREATE TABLE chat_threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  store_id          integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL,
  last_activity_at  timestamptz NOT NULL,
  busy_until        timestamptz
);
CREATE INDEX chat_threads_user ON chat_threads (user_id, last_activity_at DESC);
CREATE INDEX chat_threads_activity ON chat_threads (last_activity_at);

-- 発話。cards は、サーバーがツールの結果から作ったカード（商品・カート・確認・注文）。guard は、入力ガード（user）が拒否した・出力ガード（assistant）が本文を置き換えた理由のコード（本文は持たない）。
CREATE TABLE chat_messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id   uuid    NOT NULL REFERENCES chat_threads(id) ON DELETE RESTRICT,
  role        text    NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text    NOT NULL,
  cards       jsonb   NOT NULL DEFAULT '[]',
  guard       text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX chat_messages_thread ON chat_messages (thread_id, id);

-- 監査: ツールの呼び出しと、カートの版の変化。(thread_id, tool_call_id) で冪等にする（同じ呼び出しを 2 回実行しない）。
-- status: ok / error（検証・業務の失敗） / rejected（定義に無いツール名・引数の誤り・書き込みの上限）。
CREATE TABLE chat_tool_calls (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id            uuid    NOT NULL REFERENCES chat_threads(id) ON DELETE RESTRICT,
  message_id           bigint  REFERENCES chat_messages(id) ON DELETE RESTRICT,
  tool_call_id         text    NOT NULL,
  name                 text    NOT NULL,
  args                 jsonb   NOT NULL,
  status               text    NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  result               jsonb,
  result_summary       text    NOT NULL,
  cart_version_before  integer,
  cart_version_after   integer,
  at                   timestamptz NOT NULL,
  UNIQUE (thread_id, tool_call_id)
);
CREATE INDEX chat_tool_calls_message ON chat_tool_calls (message_id);

-- 利用者ごと・日ごとの件数（1 日の上限の判定）。本文は持たない。日付は店のローカル日付。
CREATE TABLE chat_usage (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  usage_date  date    NOT NULL,
  messages    integer NOT NULL DEFAULT 0 CHECK (messages >= 0),
  threads     integer NOT NULL DEFAULT 0 CHECK (threads >= 0),
  PRIMARY KEY (user_id, usage_date)
);
