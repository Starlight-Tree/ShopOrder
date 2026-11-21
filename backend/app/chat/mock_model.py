"""模擬の ChatModel（CHAT_MODEL=mock。既定）。決定的な規則ベースで、日本語の注文の言い回しを解釈して、ツールを呼ぶ。

- 乱数・時刻・外部通信を使わない（同じ会話からは、同じ応答）。メニューの知識を持たず、品の特定・価格・在庫は、すべてツール（search_menu など）の結果から取る。
- 作りは「発話ごとの台本（ジェネレーター）」。台本は、ツール呼び出しを yield し、その結果を受け取って、次の呼び出しか最終の文を yield する。
  reply() は呼ばれるたび、台本を最初から再生し、このターンで済んだツール結果を順に渡して、次の 1 手を返す（モデル自身は状態を持たない）。
- 文面に出す価格・合計は、ツール結果の数字だけ（guardrails が検査する）。確定を言い切らない（「注文しました」は言わない）。
- **限界（評価の README にも書く）:** これは「配線」と安全の層を決定的に試すための道具で、実モデルの言語理解・ツール選択・指示への弱さの代わりにはならない。
  解釈できるのは、下の規則に書いた言い回しだけ（品名・サイズ・温度・数量・「いつもの」・確認・やめる・状況・アレルギー・宅配・メニューの質問）。
"""

import re
import unicodedata
from collections.abc import Generator, Sequence
from dataclasses import dataclass, field
from typing import Any

from app import clock
from app.chat import guardrails
from app.chat.model import ChatMessage, ModelReply, ToolCall, ToolSpec

REPEAT_MARK = "いつものご注文の候補です"  # 「いつもの」の候補を出した発話の目印（次の発話の「1」「2」を、その選択として読む）
MAX_ITEMS_PER_TURN = 4  # 1 つの発話で解釈する品名の数（書き込みは別に 3 回まで）
MAX_WRITES = 3  # chat.md: 1 ターンの書き込みは 3 回まで（ツール側でも拒否する。模擬は、先に数えて、残りを案内する）

_REASON_JA = {"out_of_season": "季節・期間の外", "out_of_hours": "販売時間の外", "sold_out": "売り切れ"}
_CLOSED_JA = {
    "closed_today": "本日は定休日です",
    "temporary_closure": "本日は臨時休業です",
    "outside_hours": "いまは営業時間の外です",
    "past_last_order": "ラストオーダーの時間を過ぎています",
    "mobile_order_unavailable": "この店はモバイルオーダーに対応していません",
}
_TEMP_JA = {"hot": "ホット", "ice": "アイス", "-": ""}

# ---- 文面（固定。数字は入れない。入れるときは、ツール結果の値だけ）----
SAY_GREETING = "いらっしゃいませ。ご注文のお手伝いをします。品名・サイズ・温度・数量を、たとえば「オアシスブレンドのMをホットで2つ」のようにお知らせください。"
SAY_UNKNOWN = "うまく聞き取れませんでした。「オアシスブレンドのMをホットで2つ」のように、品名・サイズ・温度・数量をお知らせください。"
SAY_REFUSE_ACCOUNT = "ご登録内容（住所・電話・お支払い方法など）の変更や、他のお客様の情報のご案内は、チャットではできません。ご自身の画面からお手続きください。"
SAY_REFUSE_ORDER_CHANGE = "ご注文の取り消しや返金は、チャットではできません。注文の画面からお手続きください。"
SAY_ACK = "「はい」のお返事では、ご注文は確定されません。確認カードの確定ボタンを押してください。内容を変えるときは、お知らせください。"
SAY_DELIVERY = "宅配は準備中です。いまは、店頭でのお受け取りだけをご案内しています。店頭受け取りで進めますか。"
SAY_PICKUP = "店頭でのお受け取りにしました。お受け取りは、店舗のカウンターです。"
SAY_ALLERGY_CLOSING = "データに無いことは、私からはお答えできません。アレルギーのある方は、ご注文の前に店舗のスタッフへご確認ください。"
SAY_CONFIRM_HINT = "ご注文の確認は「注文内容を確認」とお伝えください。"


@dataclass(frozen=True)
class _Call:
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class _Say:
    text: str


@dataclass(frozen=True)
class _Seg:
    core: str  # 品名の部分
    size: str | None
    temp: str | None
    qty: int | None
    additive: bool  # 「追加で」「もう 1 杯」: いまのカートの数量に足す


@dataclass
class _View:
    text: str  # 今回の発話（NFKC）
    cart: dict[str, Any]  # ターンの先頭で読んだカート
    results: list[tuple[ToolCall, dict[str, Any]]] = field(default_factory=list)  # このターンで済んだツール結果（先頭の get_cart を除く）
    prev_text: str = ""  # 直前のアシスタントの発話
    prev_cards: tuple[str, ...] = ()  # 直前のアシスタントの発話に付いたカードの種類


def _parse(messages: Sequence[ChatMessage]) -> _View:
    last_user = max((i for i, m in enumerate(messages) if m.role == "user"), default=-1)
    text = unicodedata.normalize("NFKC", messages[last_user].content) if last_user >= 0 else ""
    view = _View(text=text, cart={"lines": [], "total_lumi": 0, "version": 0})
    for m in reversed(messages[:last_user] if last_user >= 0 else []):
        if m.role == "assistant" and not m.tool_calls:
            view.prev_text, view.prev_cards = m.content, tuple(m.meta.get("card_kinds", ()))
            break
    calls: dict[str, ToolCall] = {}
    first_tool = True
    for m in messages[last_user + 1:]:
        if m.role == "assistant":
            calls.update({c.id: c for c in m.tool_calls})
        elif m.role == "tool":
            call = calls.get(m.tool_call_id or "")
            data = m.data or {"ok": False}
            if first_tool and call is not None and call.name == "get_cart":
                view.cart = data.get("cart", view.cart)
            elif call is not None:
                view.results.append((call, data))
            first_tool = False
    return view


# ---- 言い回しの解釈 ----

_SPLIT = re.compile(r"[、,，。\n]|(?:それから|それと|あとは|あと|ほかに|それに|および)|と(?![きこそうい])|[＋+＆&]")
_QTY_UNIT = re.compile(r"(?:(\d+)|([一二三四五六七八九十])|(ひと|ふた|みっ|よっ|いつ))\s*(?:つ|個|杯|本|袋|枚|点|人前|セット)")
_QTY_BARE = re.compile(r"(?<![\d.A-Za-z])(\d{1,2})(?![\d.A-Za-z])")
_SIZE = re.compile(r"(?<![a-zA-Z])([smlSML])(?![a-zA-Z])|(エス|エム|エル)サイズ")
_HOT = re.compile(r"ホット(?!サンド)|あったかい|温かい|あたたかい|(?<![a-z])hot(?![a-z])", re.IGNORECASE)
_ICE = re.compile(r"アイス|冷たい|つめたい|冷やし|(?<![a-z])iced?(?![a-z])", re.IGNORECASE)
_ADDITIVE = re.compile(r"追加|もう|さらに|プラス|もっと")
_POLITE = re.compile(
    r"サイズ|お願い(?:します|いたします|できますか)?|くださいな|ください|下さい|ちょうだい|頂戴|ほしい|欲しい|頼(?:む|みたい|みます|んで)|注文(?:したい|します|して|お願い)?"
    r"|追加(?:して)?|入れて|いただけますか|もらえますか|もう|さらに|プラス|もっと"
)
_JP_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "ひと": 1, "ふた": 2, "みっ": 3, "よっ": 4, "いつ": 5}
_EDGE = "をのでがはもにやへ 　、。,.!！?？"
_SIZE_FROM_KANA = {"エス": "S", "エム": "M", "エル": "L"}


def _strip_edges(s: str) -> str:
    return s.strip(_EDGE)


def _segment(piece: str) -> _Seg:
    additive = bool(_ADDITIVE.search(piece))
    size = None
    m = _SIZE.search(piece)
    if m:
        size = (m.group(1) or _SIZE_FROM_KANA[m.group(2)]).upper()
        piece = piece[: m.start()] + " " + piece[m.end():]
    temp = None
    if _HOT.search(piece):
        temp, piece = "hot", _HOT.sub(" ", piece)
    if _ICE.search(piece):
        temp, piece = "ice", _ICE.sub(" ", piece)
    qty = None
    m = _QTY_UNIT.search(piece)
    if m:
        qty = int(m.group(1)) if m.group(1) else _JP_NUM[m.group(2) or m.group(3)]
        piece = piece[: m.start()] + " " + piece[m.end():]
    else:
        m = _QTY_BARE.search(piece)
        if m:
            qty = int(m.group(1))
            piece = piece[: m.start()] + " " + piece[m.end():]
    core = _strip_edges(_POLITE.sub(" ", re.sub(r"[()「」『』\[\]]", " ", piece)))
    core = _strip_edges(re.sub(r"\s+", "", core))
    return _Seg(core=core, size=size, temp=temp, qty=qty, additive=additive)


def _segments(text: str) -> list[_Seg]:
    return [seg for seg in (_segment(p) for p in _SPLIT.split(unicodedata.normalize("NFKC", text))) if seg.core]


_RE_ORDER_ID = re.compile(r"(?<![A-Za-z0-9])([A-HJ-NP-Za-hj-np-z2-9]{8})(?![A-Za-z0-9])")
_ACCOUNT = re.compile(r"(住所|電話|メール|パスワード|退会|アカウント|カード番号|クレジット|個人情報|登録情報)")
_ACCOUNT_ACT = re.compile(r"(変更|変えて|変えたい|教えて|削除|消して|更新|登録|見せて)")
_OTHERS = re.compile(r"(他の(人|お客|方)|ほかの(人|お客|方)|他人|別の人|[^\s]{1,10}さんの(注文|履歴|住所))")
_REFUND = re.compile(r"返金|払い戻し|払戻")
_CANCEL = re.compile(r"(やっぱり|やはり).{0,6}(やめ|いらな|キャンセル|いい)|全部(やめ|消|キャンセル)|(注文|カート)(を)?(やめ|キャンセル|空に|クリア|取り消)|キャンセル|やめます|やめる|やめておく|いらない|最初から")
_ACK = re.compile(r"^(はい|ええ|うん|ok|オーケー|おっけー|お願いします|それで(お願い|いい|ok)|大丈夫(です)?)[。!！、\s]*$", re.IGNORECASE)
_CONFIRM_KEY = re.compile(r"確認|会計|決定|確定|購入|支払|決済|注文|これで|それで|レジ|以上|チェックアウト")
_CONFIRM_VOCAB = re.compile(
    r"注文内容|注文|内容|確認|お会計|会計|これで|それで|お願い(?:します)?|いい(?:です)?|決定|決め(?:て|る|ます)?|して|したい|ください|下さい|する|します|を|は|も|で|に|の|です"
    r"|はい|ええ|カート|全部|以上|次|進んで|購入|支払い?|決済|確定|レジ|チェックアウト|お|ご|[。.!！、\s]"
)
_STATUS = re.compile(r"状況|状態|どうなって|できあが|できた|いつ(頃)?(できる|受け取れ|届)|注文履歴|過去の注文|私の注文|自分の注文|注文(は|って)(どう|まだ)|まだ(です)?か|進捗")
_REPEAT = re.compile(r"いつもの|いつも通り|同じ(の|もの|やつ)|前と同じ|さっきと同じ|前回と同じ|もう(1|一)杯|リピート|前に頼んだ")
_PICK = re.compile(r"(\d|[一二三])|最初|一番上|上の|はじめ")
_PICK_FILLER = re.compile(r"[\d一二三]|番目|番|つ目|個目|つめ|でお願い(?:します)?|お願い(?:します)?|にする|にします|最初の?|一番上|上の|はじめの?|で|を|に|です|[。!！\s]")
_ALLERGY = re.compile(r"アレルギ|アレルゲン|(乳|卵|小麦|くるみ|ナッツ|そば|えび|かに|落花生|大豆|ごま|グルテン|ラクトース)(は|が|を)?(入って|含ま|使って|大丈夫|ありま)|入ってますか|含まれてますか")
_DELIVERY = re.compile(r"宅配|配達|届けて|デリバリー|持ってきて|お届け|自宅|家まで")
_PICKUP = re.compile(r"店頭|受け取り|取りに行|持ち帰り|テイクアウト|お店で|店で")
_PICKUP_WORDS = re.compile(r"店頭|受け取り|受取|取りに行(?:きます|く)?|持ち帰り|テイクアウト|お店|店|にして|にする|にします|したい|します|ます|お願い|ください|で|を|に|は|[。!！\s]")
_MENU_Q = re.compile(r"メニュー|おすすめ|オススメ|何がある|いくら|値段|価格|ありますか|ありますでしょうか|売り切れ|在庫|どんな|について|説明|教えて|一覧")
_GREETING = re.compile(r"^(こんにちは|こんばんは|おはよう|はじめまして|やあ|ありがとう|助かりました|どうも|よろしく)")
_QUESTION_WORDS = re.compile(
    r"(?:は|って)?(?:ありますか|ありますでしょうか|ある|いくらですか|いくら|について(?:教えて)?(?:ください)?|を?教えて(?:ください)?|ですか|ますか|おすすめ|オススメ|メニュー"
    r"|値段|価格|説明|詳しく|どんな(?:もの)?|売り切れ|在庫|一覧|アレルギー|アレルゲン|入って(?:ますか|いますか)|含まれて(?:ますか|いますか)|[?？])"
)


def _residue(text: str) -> str:
    return _CONFIRM_VOCAB.sub("", text)


def _intent(view: _View) -> str:
    t = view.text
    if _OTHERS.search(t) or (_ACCOUNT.search(t) and _ACCOUNT_ACT.search(t)):
        return "refuse_account"
    if _REFUND.search(t) or (re.search(r"注文", t) and _CANCEL.search(t) and (_RE_ORDER_ID.search(t) or not view.cart["lines"])):
        return "refuse_order_change"
    if _CANCEL.search(t):
        return "cancel"
    if _ACK.match(t.strip()) and "confirm" in view.prev_cards:
        return "ack"
    if _CONFIRM_KEY.search(t) and len(_residue(t)) <= 1:
        return "confirm"
    if _RE_ORDER_ID.search(t.upper()) and not _MENU_Q.search(t):
        return "status"
    if _STATUS.search(t):
        return "status"
    if view.prev_text.startswith(REPEAT_MARK) and _PICK.search(t) and not _PICK_FILLER.sub("", t):
        return "repeat_pick"
    if _REPEAT.search(t):
        return "repeat"
    if _ALLERGY.search(t):
        return "allergy"
    if _DELIVERY.search(t):
        return "delivery"
    if _MENU_Q.search(t):
        return "menu"
    if _PICKUP.search(t) and not _segments(_PICKUP_WORDS.sub(" ", t)):
        return "pickup"
    if _GREETING.match(t.strip()) and len(t) <= 20:
        return "greeting"
    return "order"


# ---- 台本 ----

def _label(name: str, variant: dict[str, Any]) -> str:
    parts = [name]
    if variant["size"] != "-":
        parts.append(variant["size"])
    temp = _TEMP_JA.get(variant["temperature"], "")
    return " ".join(parts) + (f"（{temp}）" if temp else "")


def _price_text(variants: list[dict[str, Any]]) -> str:
    by_size: dict[str, dict[str, int]] = {}
    for v in variants:
        by_size.setdefault(v["size"], {})[v["temperature"]] = v["price_lumi"]
    parts = []
    for size, temps in by_size.items():
        prefix = "" if size == "-" else f"{size} "
        if len(set(temps.values())) == 1:
            parts.append(f"{prefix}{next(iter(temps.values()))} ルミ")
        else:
            parts.extend(f"{prefix}（{_TEMP_JA.get(t, t)}）{p} ルミ" for t, p in temps.items())
    return " / ".join(parts)


def _item_line(item: dict[str, Any]) -> str:
    out = [v for v in item["variants"] if not v["available"]]
    reasons = "・".join(sorted({_REASON_JA.get(v["unavailable_reason"] or "", "出せません") for v in out}))
    note = "" if not out else (f"（いまは出せません: {reasons}）" if len(out) == len(item["variants"]) else f"（一部は、いま出せません: {reasons}）")
    return f"{item['name']}: {_price_text(item['variants'])}{note}"


def _names(items: list[dict[str, Any]], limit: int = 4) -> str:
    return "・".join(i["name"] for i in items[:limit])


def _qty_in_cart(cart: dict[str, Any], variant_id: int) -> int:
    return next((line["qty"] for line in cart["lines"] if line["variant_id"] == variant_id), 0)


def _script_greeting(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    yield _Say(SAY_GREETING)


def _script_unknown(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    yield _Say(SAY_UNKNOWN)


def _script_refuse_account(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    yield _Say(SAY_REFUSE_ACCOUNT)


def _script_refuse_order_change(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    yield _Say(SAY_REFUSE_ORDER_CHANGE)


def _script_ack(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    yield _Say(SAY_ACK)


def _script_order(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    segs = _segments(view.text)[:MAX_ITEMS_PER_TURN]
    if not segs:
        yield _Say(SAY_UNKNOWN)
        return
    planned: list[tuple[dict[str, Any], dict[str, Any], int]] = []  # (品, 変種, 数量)
    questions: list[str] = []
    unavailable: list[dict[str, Any]] = []
    for seg in segs:
        res = yield _Call("search_menu", {"query": seg.core})
        items = res.get("items", []) if res.get("ok") else []
        pool = [i for i in items if i.get("match") == "name"] or items
        if not pool:
            questions.append(f"「{seg.core}」は、メニューで見つかりませんでした。")
            continue
        if len(pool) > 1:
            questions.append(f"「{seg.core}」には、{_names(pool)} があります。どれにしますか。")
            continue
        item = pool[0]
        variants = item["variants"]
        sizes, temps = {v["size"] for v in variants}, {v["temperature"] for v in variants}
        chosen = variants
        if len(sizes) > 1:
            if seg.size is None:
                questions.append(f"{item['name']}のサイズ（{'・'.join(sorted(sizes, key='SML-'.index))}）を教えてください。")
                continue
            chosen = [v for v in chosen if v["size"] == seg.size]
        if len(temps) > 1:
            if seg.temp is None:
                questions.append(f"{item['name']}は、ホットとアイスのどちらにしますか。")
                continue
            chosen = [v for v in chosen if v["temperature"] == seg.temp]
        if len(chosen) != 1:
            questions.append(f"{item['name']} に、その組み合わせはありません。ほかの組み合わせをお選びください。")
            continue
        variant = chosen[0]
        if not variant["available"]:
            unavailable.append({"label": _label(item["name"], variant), "reason": variant["unavailable_reason"], "category": item["category"]})
            continue
        qty = (seg.qty or 1) + (_qty_in_cart(view.cart, variant["variant_id"]) if seg.additive else 0)
        planned.append((item, variant, qty))
    if unavailable:
        alt = yield _Call("search_menu", {"query": "", "filters": {"category": unavailable[0]["category"], "available_only": True}})
        alt_items = alt.get("items", []) if alt.get("ok") else []
        for u in unavailable:
            suffix = f"代わりに、{_names(alt_items, 3)}はいかがですか。" if alt_items else "ほかの品をお選びください。"
            questions.append(f"{u['label']}は、いま{_REASON_JA.get(u['reason'] or '', '出せない状態')}です。{suffix}")
    applied: list[str] = []
    problems: list[str] = []
    last_cart: dict[str, Any] | None = None
    for item, variant, qty in planned[:MAX_WRITES]:
        res = yield _Call("set_cart_item", {"variant_id": variant["variant_id"], "qty": qty})
        if res.get("ok"):
            last_cart = res["cart"]
            applied.append(f"{_label(item['name'], variant)}を {qty} 点")
            line = next((ln for ln in last_cart["lines"] if ln["variant_id"] == variant["variant_id"]), None)
            if line and not line["available"]:
                problems.append(f"{item['name']}は、いま{_REASON_JA.get(line['unavailable_reason'] or '', '出せない状態')}のため、ご注文が通らないかもしれません。")
        elif res.get("error") == "invalid_arguments":
            problems.append(f"{item['name']}の数量が多すぎます。1 品あたりの上限を超えています。")
        else:
            problems.append(f"{item['name']}をカートに入れられませんでした（{res.get('message', '失敗しました')}）")
    if len(planned) > MAX_WRITES:
        problems.append("一度に変更できるのは 3 品までです。残りは、続けてお知らせください。")
    parts: list[str] = []
    if applied:
        parts.append("、".join(applied) + "、カートに入れました。")
        if last_cart is not None:
            parts.append(f"カートの合計は {last_cart['total_lumi']} ルミです。")
    parts += problems + questions
    if applied and not questions:
        parts.append(f"ほかにご希望があればお知らせください。{SAY_CONFIRM_HINT}")
    yield _Say("".join(parts) if parts else SAY_UNKNOWN)


def _script_cancel(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    lines = view.cart["lines"]
    if not lines:
        yield _Say("カートはすでに空です。")
        return
    removed = 0
    for line in lines[:MAX_WRITES]:
        res = yield _Call("set_cart_item", {"variant_id": line["variant_id"], "qty": 0})
        removed += 1 if res.get("ok") else 0
    rest = len(lines) - removed
    if rest > 0:
        yield _Say(f"カートの品を外しました。まだ {rest} 品 残っています。もう一度「やっぱりやめる」とお伝えください。")
    else:
        yield _Say("カートを空にしました。先に出した確認カードは、使えなくなります。")


def _script_confirm(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    res = yield _Call("propose_checkout", {})
    if res.get("ok"):
        total = res["proposal"]["total_lumi"]
        yield _Say(f"ご注文内容の確認カードを出しました。合計は {total} ルミです。内容をご確認のうえ、カードの確定ボタンを押してください。確定ボタンを押すまで、ご注文は確定されません。")
        return
    code = res.get("error")
    if code == "cart_empty":
        yield _Say("カートが空です。ご注文の品をお知らせください。")
    elif code == "store_closed":
        why = _CLOSED_JA.get(res.get("closed_reason", ""), "いまは注文を受けられません")
        retry = "別の店で新しく会話を始めてください。" if res.get("closed_reason") == "mobile_order_unavailable" else "営業時間内にもう一度お試しいただくか、別の店で新しく会話を始めてください。"
        yield _Say(f"この店は、いまご注文をお受けできません（{why}）。{retry}")
    elif code == "item_unavailable":
        ids = set(res.get("variant_ids", []))
        names = "・".join(line["name"] for line in view.cart["lines"] if line["variant_id"] in ids) or "一部の品"
        yield _Say(f"{names}は、いま出せません。カートの品を入れ替えてから、もう一度ご確認ください。")
    elif code == "sold_out":
        yield _Say(f"{res.get('item_name', '一部の品')} が売り切れです。数量を減らすか、別の品にしてください。")
    elif code == "over_limit":
        yield _Say("1 回のご注文の上限を超えています。品数か数量を減らしてください。")
    else:
        yield _Say(f"確認カードを作れませんでした（{res.get('message', '失敗しました')}）")


_ACTIVE = ("placed", "paid", "accepted", "preparing", "ready")


def _script_status(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    m = _RE_ORDER_ID.search(view.text.upper())
    if m:
        res = yield _Call("get_order_status", {"order_id": m.group(1)})
        if not res.get("ok"):
            yield _Say("その番号のご注文は、見つかりませんでした。番号をご確認ください。")
            return
        order = res["order"]
        yield _Say(f"ご注文 {order['public_id']}（受け取り番号 {order['pickup_no']}）の状態は「{order['status_label']}」です。")
        return
    listed = yield _Call("list_my_orders", {"limit": 3})
    orders = listed.get("orders", []) if listed.get("ok") else []
    if not orders:
        yield _Say("ご注文の履歴は、まだありません。")
        return
    target = next((o for o in orders if o["status"] in _ACTIVE), orders[0])
    res = yield _Call("get_order_status", {"order_id": target["public_id"]})
    if not res.get("ok"):
        yield _Say("ご注文の状態を取得できませんでした。しばらくしてから、もう一度お試しください。")
        return
    order = res["order"]
    yield _Say(f"いちばん新しいご注文 {order['public_id']}（受け取り番号 {order['pickup_no']}）の状態は「{order['status_label']}」です。")


def _candidates(orders: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """過去の注文から、「いつもの」の候補（品目の組）を、よく頼む順（同数なら新しい順）に最大 3 つ。"""
    counts: dict[tuple, list[int]] = {}
    sets: dict[tuple, list[dict[str, Any]]] = {}
    for recency, order in enumerate(orders):  # orders は新しい順
        items = [i for i in order["items"] if i["qty"] > 0]
        if not items:
            continue
        key = tuple((i["name"], i["size"], i["temperature"], i["qty"]) for i in items)
        counts.setdefault(key, []).append(recency)
        sets.setdefault(key, items)
    ranked = sorted(counts, key=lambda k: (-len(counts[k]), min(counts[k])))
    return [sets[k] for k in ranked[:3]]


def _describe(items: list[dict[str, Any]]) -> str:
    return "、".join(f"{_label(i['name'], i)} × {i['qty']}" for i in items)


def _script_repeat(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    res = yield _Call("list_my_orders", {"limit": 5})
    cands = _candidates(res.get("orders", []) if res.get("ok") else [])
    if not cands:
        yield _Say("ご注文の履歴が見つかりませんでした。品名・サイズ・温度・数量をお知らせください。")
        return
    lines = [f"{n}. {_describe(items)}" for n, items in enumerate(cands, start=1)]
    yield _Say(f"{REPEAT_MARK}。番号でお選びください。\n" + "\n".join(lines))


def _script_repeat_pick(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    m = re.search(r"(\d|[一二三])", view.text)
    pick = 1 if m is None else (int(m.group(1)) if m.group(1).isdigit() else _JP_NUM[m.group(1)])
    res = yield _Call("list_my_orders", {"limit": 5})
    cands = _candidates(res.get("orders", []) if res.get("ok") else [])
    if not 1 <= pick <= len(cands):
        yield _Say("その番号の候補はありません。もう一度「いつもの」とお伝えください。")
        return
    chosen = cands[pick - 1]
    applied, problems = [], []
    last_cart = None
    for i in chosen[:MAX_WRITES]:
        found = yield _Call("search_menu", {"query": i["name"]})
        items = [x for x in (found.get("items", []) if found.get("ok") else []) if x.get("match") == "name"]
        variant = next((v for it in items[:1] for v in it["variants"] if v["size"] == i["size"] and v["temperature"] == i["temperature"]), None)
        if variant is None or not variant["available"]:
            problems.append(f"{_label(i['name'], i)}は、いま出せません。")
            continue
        res = yield _Call("set_cart_item", {"variant_id": variant["variant_id"], "qty": i["qty"]})
        if res.get("ok"):
            last_cart = res["cart"]
            applied.append(f"{_label(i['name'], i)}を {i['qty']} 点")
        else:
            problems.append(f"{i['name']}をカートに入れられませんでした。")
    if len(chosen) > MAX_WRITES:
        problems.append("一度に変更できるのは 3 品までです。残りは、続けてお知らせください。")
    parts = []
    if applied:
        parts.append("、".join(applied) + "、カートに入れました。")
        if last_cart is not None:
            parts.append(f"カートの合計は {last_cart['total_lumi']} ルミです。")
        parts.append(SAY_CONFIRM_HINT)
    yield _Say("".join(parts + problems) or SAY_UNKNOWN)


def _question_core(text: str) -> str:
    core = _QUESTION_WORDS.sub(" ", text)
    return _strip_edges(re.sub(r"\s+", "", _POLITE.sub(" ", core)))


def _script_allergy(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    core = _question_core(re.sub(r"(乳|卵|小麦|くるみ|ナッツ|そば|えび|かに|落花生|大豆|ごま|グルテン|ラクトース)(は|が|を)?", " ", view.text))
    if not core:
        yield _Say("どの商品についてのご質問か、品名をお知らせください。")
        return
    res = yield _Call("search_menu", {"query": core})
    items = [i for i in (res.get("items", []) if res.get("ok") else [])]
    items = [i for i in items if i.get("match") == "name"] or items
    if not items:
        yield _Say(f"「{core}」は、メニューで見つかりませんでした。品名をご確認ください。")
        return
    lines = []
    for item in items[:3]:
        registered = item["allergens_registered"]
        lines.append(
            f"{item['name']}に登録されているアレルゲンは、{'・'.join(registered)}です。" if registered else f"{item['name']}には、アレルゲンの登録がありません。"
        )
    yield _Say("".join(lines) + SAY_ALLERGY_CLOSING)


def _script_menu(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    core = _question_core(view.text)
    args: dict[str, Any] = {"query": core}
    if not core:
        category = "drink" if re.search(r"ドリンク|飲み物|コーヒー", view.text) else "food" if re.search(r"フード|食べ物|軽食|ケーキ|パン", view.text) else "beans" if "豆" in view.text else None
        args = {"query": "", "filters": {"category": category}} if category else {"query": ""}
    res = yield _Call("search_menu", args)
    items = res.get("items", []) if res.get("ok") else []
    items = [i for i in items if i.get("match") == "name"] or items
    if not items:
        yield _Say("お探しの品は、メニューで見つかりませんでした。")
        return
    shown = items[:5]
    text = "\n".join(_item_line(i) for i in shown)
    more = "\nほかにも品があります。カードをご覧ください。" if len(items) > len(shown) else ""
    yield _Say(text + more)


def _script_delivery(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    yield _Call("set_fulfillment", {"kind": "delivery"})
    yield _Call("check_slots", {"date": clock.local_now().date().isoformat()})
    yield _Say(SAY_DELIVERY)


def _script_pickup(view: _View) -> Generator[_Call | _Say, dict[str, Any], None]:
    res = yield _Call("set_fulfillment", {"kind": "pickup"})
    yield _Say(SAY_PICKUP if res.get("ok") else "受け取り方法を変えられませんでした。しばらくしてから、もう一度お試しください。")


_SCRIPTS = {
    "greeting": _script_greeting, "refuse_account": _script_refuse_account, "refuse_order_change": _script_refuse_order_change, "ack": _script_ack,
    "order": _script_order, "cancel": _script_cancel, "confirm": _script_confirm, "status": _script_status, "repeat": _script_repeat,
    "repeat_pick": _script_repeat_pick, "allergy": _script_allergy, "menu": _script_menu, "delivery": _script_delivery, "pickup": _script_pickup,
}


class MockChatModel:
    """決定的な規則ベースの ChatModel（ChatModel Protocol）。"""

    name = "mock"

    def reply(self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec]) -> ModelReply:
        view = _parse(messages)
        gen = _SCRIPTS.get(_intent(view), _script_unknown)(view)
        try:
            step = next(gen)
            for call, data in view.results:  # このターンで済んだ結果を、順に台本へ渡して、次の 1 手まで進める
                if not isinstance(step, _Call) or step.name != call.name:
                    return ModelReply(text=guardrails.FAILURE_REPLY)  # 再生がずれた（起きない想定）
                step = gen.send(data)
        except StopIteration:
            return ModelReply(text=guardrails.EMPTY_REPLY)
        if isinstance(step, _Call):
            return ModelReply(tool_calls=(ToolCall(f"mock-{len(view.results) + 1}", step.name, step.args),))
        return ModelReply(text=step.text)
