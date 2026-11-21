"""golden set（発話 → 期待するツールの列・最終のカート・必ず含む語・含んではいけない語・カードの種類）。

条件を固定してから測る（docs/chat.md「評価」）: 模擬モデル（CHAT_MODEL=mock）・使い捨ての DB・seed の初期在庫。実 API は使わない。
ツールの列は、ターンの先頭の get_cart（サーバーが自動で呼ぶ）を含む。カートは、(品の code, サイズ, 温度) → 数量。
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Turn:
    say: str
    tools: list[str]
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    cards: tuple[str, ...] | None = None  # None なら、カードの種類は見ない


@dataclass(frozen=True)
class Case:
    id: str
    what: str
    turns: list[Turn]
    cart: dict[tuple[str, str, str], int] = field(default_factory=dict)  # 会話の終わりのカート
    store: str = "residential-main"
    setup: str | None = None


OB_M_HOT = ("oasis-blend", "M", "hot")
LATTE_L_ICE = ("cafe-latte", "L", "ice")
SANDWICH = ("hot-sandwich", "-", "-")
G = "get_cart"
SEARCH, SET = "search_menu", "set_cart_item"

CASES: list[Case] = [
    Case("g01", "品名・サイズ・温度・数量を言い切る", [Turn("オアシスブレンドのMをホットで 2 つ", [G, SEARCH, SET], include=("900 ルミ", "カートに入れました"), cards=("products", "cart"))], {OB_M_HOT: 2}),
    Case("g02", "半角の英字と数字だけの言い方", [Turn("カフェラテ L アイス 1", [G, SEARCH, SET], include=("570 ルミ",))], {LATTE_L_ICE: 1}),
    Case("g03", "2 品を 1 回で（書き込みは 2 回）", [Turn("オアシスブレンドのMをホットで2つと、カフェラテLアイス1つ", [G, SEARCH, SEARCH, SET, SET], include=("1470 ルミ",))], {OB_M_HOT: 2, LATTE_L_ICE: 1}),
    Case("g04", "続けて足す（「ホットサンドもお願い」は 1 つ）", [
        Turn("オアシスブレンドのMをホットで 2 つ", [G, SEARCH, SET]),
        Turn("ホットサンドもお願い", [G, SEARCH, SET], include=("1420 ルミ",)),
    ], {OB_M_HOT: 2, SANDWICH: 1}),
    Case("g05", "サイズが足りない → 推測せず聞き返す", [Turn("オアシスブレンドをホットで", [G, SEARCH], include=("サイズ",), exclude=("カートに入れました",))]),
    Case("g06", "温度が足りない → 聞き返す", [Turn("カフェラテのMをください", [G, SEARCH], include=("ホットとアイス",), exclude=("カートに入れました",))]),
    Case("g07", "あいまいな品名 → 候補を出して選ばせる", [Turn("ブレンドを1つ", [G, SEARCH], include=("どれにしますか", "オアシスブレンド", "季節のブレンド"), cards=("products",))]),
    Case("g08", "サイズ・温度の無い品は、そのまま", [Turn("ホットサンドを2つください", [G, SEARCH, SET])], {SANDWICH: 2}),
    Case("g09", "確認 → 確認カード（確定はしない）", [
        Turn("オアシスブレンドのMをホットで 2 つ", [G, SEARCH, SET]),
        Turn("注文内容を確認", [G, "propose_checkout"], include=("確定ボタン", "900 ルミ"), exclude=("確定しました", "注文しました"), cards=("confirm",)),
    ], {OB_M_HOT: 2}),
    Case("g10", "売り切れ → 理由と代わりの案", [Turn("ガトーショコラを1つ", [G, SEARCH, SEARCH], include=("売り切れ", "代わりに"), exclude=("カートに入れました",))], store="rock-lookout", setup="sold_out_gateau"),
    Case("g11", "営業時間外 → 確認カードを作らず理由を伝える", [
        Turn("オアシスブレンドのMをホットで1つ", [G, SEARCH, SET]),
        Turn("注文内容を確認", [G, "propose_checkout"], include=("営業時間",), exclude=("確認カードを出しました",), cards=()),
    ], {OB_M_HOT: 1}, setup="after_hours"),
    Case("g12", "モバイルオーダー不可の店 → 理由を伝える", [
        Turn("ホットサンドを1つ", [G, SEARCH, SET]),
        Turn("注文内容を確認", [G, "propose_checkout"], include=("モバイルオーダーに対応していません",), cards=()),
    ], {SANDWICH: 1}, store="residential-signal"),
    Case("g13", "アレルギー → データにある内容だけ。店舗への確認を案内", [
        Turn("ホットサンドのアレルギーは？", [G, SEARCH], include=("乳・小麦", "スタッフ"), exclude=("含まれていません", "入っていません", "安心"))
    ]),
    Case("g14", "アレルギー → 登録が無いときも、無いと言い切らない", [
        Turn("オアシスブレンドにアレルギー成分は入ってますか", [G, SEARCH], include=("アレルゲンの登録がありません", "スタッフ"), exclude=("含まれていません", "入っていません"))
    ]),
    Case("g15", "「いつもの」→ 履歴から候補 3 つ → 番号で選ぶ", [
        Turn("いつもの", [G, "list_my_orders"], include=("いつものご注文の候補です", "1.", "2.", "3."), exclude=("カートに入れました",), cards=("orders",)),
        Turn("2番", [G, "list_my_orders", SEARCH, SET], include=("アメリカーノ S（ホット）",)),
    ], {("americano", "S", "hot"): 1}, setup="past_orders"),
    Case("g16", "やっぱりやめる → カートを空にする", [
        Turn("オアシスブレンドのMをホットで 2 つ", [G, SEARCH, SET]),
        Turn("ホットサンドもお願い", [G, SEARCH, SET]),
        Turn("やっぱりやめる", [G, SET, SET], include=("空にしました",)),
    ]),
    Case("g17", "注文の状況 → 履歴 → 最新の状態（API の値から）", [Turn("注文の状況を教えて", [G, "list_my_orders", "get_order_status"], include=("お支払い待ち",), cards=("orders", "order"))], setup="one_order"),
    Case("g18", "宅配 → 準備中と断り、店頭を案内（カートは店頭のまま）", [Turn("宅配でお願い", [G, "set_fulfillment", "check_slots"], include=("準備中", "店頭"))]),
    Case("g19", "数量が多すぎる → 上限を伝える（カートは変えない）", [Turn("オアシスブレンドのMをホットで25個", [G, SEARCH, SET], include=("上限",), exclude=("カートに入れました",))]),
    Case("g20", "あいさつ → ツールは先頭の get_cart だけ", [Turn("こんにちは", [G], include=("お手伝い",))]),
    Case("g21", "確認カードの後の「はい」では確定しない", [
        Turn("ホットサンドを1つ", [G, SEARCH, SET]),
        Turn("注文内容を確認", [G, "propose_checkout"], cards=("confirm",)),
        Turn("はい", [G], include=("確定されません", "確定ボタン"), cards=()),
    ], {SANDWICH: 1}),
    Case("g22", "メニューの質問 → 商品カード", [Turn("メニューを教えて", [G, SEARCH], include=("オアシスブレンド", "380 ルミ"), cards=("products",))]),
    Case("g23", "価格の質問 → ツール結果の価格だけ", [Turn("オアシスブレンドはいくらですか", [G, SEARCH], include=("S 380 ルミ", "M 450 ルミ", "L 520 ルミ"))]),
    Case("g24", "登録内容の変更 → チャットではできない", [Turn("住所を変更して", [G], include=("できません",), exclude=("変更しました",))]),
    Case("g25", "店頭受け取り → 受け取り方法の設定", [Turn("店頭で受け取ります", [G, "set_fulfillment"], include=("店頭",))]),
]
