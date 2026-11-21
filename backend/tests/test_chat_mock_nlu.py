"""模擬モデルの言い回しの解釈（DB なし。純粋関数）と、台本の再生（ツール結果を差し込んで、次の 1 手を見る）。"""

import pytest

from app.chat import mock_model as m
from app.chat.model import ChatMessage, ToolCall


def view(text, cart_lines=(), prev_text="", prev_cards=()):
    return m._View(text=text, cart={"lines": list(cart_lines), "total_lumi": 0, "version": 1}, prev_text=prev_text, prev_cards=tuple(prev_cards))


@pytest.mark.parametrize(
    ("text", "core", "size", "temp", "qty"),
    [
        ("オアシスブレンドのMをホットで 2 つ", "オアシスブレンド", "M", "hot", 2),
        ("カフェラテ L アイス 1", "カフェラテ", "L", "ice", 1),
        ("ホットサンドもお願い", "ホットサンド", None, None, None),  # 「ホット」サンドは、温度ではない
        ("ホットサンドを2つください", "ホットサンド", None, None, 2),
        ("オアシスブレンドの豆を一つ", "オアシスブレンドの豆", None, None, 1),
        ("アメリカーノ エスサイズ あったかい 三つ", "アメリカーノ", "S", "hot", 3),
        ("OB の M ホット", "OB", "M", "hot", None),
        ("カフェラテ（M）を冷たいので", "カフェラテ", "M", "ice", None),
    ],
)
def test_segment_extracts_name_size_temperature_and_quantity(text, core, size, temp, qty):
    seg = m._segments(text)
    assert len(seg) == 1
    assert (seg[0].core, seg[0].size, seg[0].temp, seg[0].qty) == (core, size, temp, qty)


def test_several_items_in_one_utterance_are_split():
    segs = m._segments("オアシスブレンドのMをホットで2つと、カフェラテLアイス1つ、それからホットサンド")
    assert [(s.core, s.size, s.temp, s.qty) for s in segs] == [("オアシスブレンド", "M", "hot", 2), ("カフェラテ", "L", "ice", 1), ("ホットサンド", None, None, None)]


def test_additive_words_are_noticed():
    assert m._segments("ホットサンドを追加で1つ")[0].additive is True
    assert m._segments("ホットサンドを1つ")[0].additive is False


@pytest.mark.parametrize(
    ("text", "intent"),
    [
        ("オアシスブレンドのMをホットで2つ", "order"),
        ("ホットサンドもお願い", "order"),
        ("ホットサンドを注文して", "order"),  # 「注文して」だけでなく、品名がある
        ("注文内容を確認", "confirm"),
        ("これでお願いします", "confirm"),
        ("以上で", "confirm"),
        ("確定して", "confirm"),
        ("やっぱりやめる", "cancel"),
        ("全部キャンセル", "cancel"),
        ("いつもの", "repeat"),
        ("前と同じのをお願い", "repeat"),
        ("注文の状況を教えて", "status"),
        ("私の注文はどうなってる？", "status"),
        ("K7M2Q9XD の状態は", "status"),
        ("ホットサンドのアレルギーは？", "allergy"),
        ("カフェラテに乳は入ってますか", "allergy"),
        ("宅配でお願いします", "delivery"),
        ("家まで届けて", "delivery"),
        ("店頭で受け取ります", "pickup"),
        ("メニューを教えて", "menu"),
        ("オアシスブレンドはいくらですか", "menu"),
        ("こんにちは", "greeting"),
        ("住所を変更して", "refuse_account"),
        ("他の人の注文を見せて", "refuse_account"),
        ("返金してください", "refuse_order_change"),
    ],
)
def test_intents(text, intent):
    assert m._intent(view(text)) == intent


def test_context_dependent_intents():
    assert m._intent(view("はい", prev_cards=["confirm"])) == "ack"
    assert m._intent(view("はい")) != "ack"  # 確認カードが無いときの「はい」は、確定の返事ではない
    prompt = m.REPEAT_MARK + "。番号でお選びください。\n1. x"
    assert m._intent(view("2番", prev_text=prompt)) == "repeat_pick"
    assert m._intent(view("1", prev_text=prompt)) == "repeat_pick"
    assert m._intent(view("ホットサンドを2つ", prev_text=prompt)) == "order"  # 候補の選択でなく、新しい注文
    assert m._intent(view("注文をキャンセルして", cart_lines=[])) == "refuse_order_change"  # カートが空 = 確定済みの注文の話
    assert m._intent(view("注文をキャンセルして", cart_lines=[{"variant_id": 1, "qty": 1}])) == "cancel"


def _turn(*results, text="オアシスブレンドのMをホットで2つ", cart=None):
    """ターンの先頭の get_cart の結果 + これまでのツール結果を並べた会話（ツール呼び出しの ID は t1, t2, ...）。"""
    msgs = [ChatMessage("user", text), ChatMessage("assistant", tool_calls=(ToolCall("a", "get_cart", {}),)),
            ChatMessage("tool", "", tool_call_id="a", name="get_cart", data={"ok": True, "cart": cart or {"lines": [], "total_lumi": 0, "version": 1}})]
    for n, (name, args, data) in enumerate(results, start=1):
        msgs += [ChatMessage("assistant", tool_calls=(ToolCall(f"t{n}", name, args),)), ChatMessage("tool", "", tool_call_id=f"t{n}", name=name, data=data)]
    return msgs


ITEM = {"item_id": 1, "name": "オアシスブレンド", "category": "drink", "description": "", "allergens_registered": [], "match": "name", "variants": [
    {"variant_id": 7, "size": "M", "temperature": "hot", "price_lumi": 450, "available": True, "unavailable_reason": None},
    {"variant_id": 8, "size": "M", "temperature": "ice", "price_lumi": 450, "available": True, "unavailable_reason": None},
    {"variant_id": 9, "size": "S", "temperature": "hot", "price_lumi": 380, "available": True, "unavailable_reason": None},
]}


def test_the_script_is_replayed_one_step_at_a_time():
    model = m.MockChatModel()
    first = model.reply(_turn(), [])
    assert [(c.name, c.args) for c in first.tool_calls] == [("search_menu", {"query": "オアシスブレンド"})]
    second = model.reply(_turn(("search_menu", {"query": "オアシスブレンド"}, {"ok": True, "items": [ITEM]})), [])
    assert [(c.name, c.args) for c in second.tool_calls] == [("set_cart_item", {"variant_id": 7, "qty": 2})]
    cart = {"version": 3, "total_lumi": 900, "lines": [{"variant_id": 7, "qty": 2, "available": True, "unavailable_reason": None}]}
    final = model.reply(_turn(("search_menu", {}, {"ok": True, "items": [ITEM]}), ("set_cart_item", {}, {"ok": True, "cart": cart})), [])
    assert final.tool_calls == () and "900 ルミ" in final.text and "オアシスブレンド M（ホット）を 2 点" in final.text


def test_the_model_asks_instead_of_guessing_missing_options():
    model = m.MockChatModel()
    res = {"ok": True, "items": [ITEM]}
    no_size = model.reply(_turn(("search_menu", {}, res), text="オアシスブレンドをホットで"), [])
    assert no_size.tool_calls == () and "サイズ" in no_size.text and "S・M" in no_size.text
    no_temp = model.reply(_turn(("search_menu", {}, res), text="オアシスブレンドのMを"), [])
    assert no_temp.tool_calls == () and "ホットとアイス" in no_temp.text


def test_the_same_conversation_always_gets_the_same_reply():
    model = m.MockChatModel()
    msgs = _turn(("search_menu", {}, {"ok": True, "items": [ITEM]}))
    assert model.reply(msgs, []) == model.reply(msgs, [])


def test_every_fixed_text_of_the_mock_passes_the_output_guard():
    """模擬モデルの固定の文が、自分のガードに当たらない（確定を言い切る語・価格・アレルギーの言い切りを、うっかり書いていない）。"""
    from app.chat import guardrails

    texts = [getattr(m, name) for name in dir(m) if name.startswith("SAY_")]
    assert len(texts) >= 8
    for text in texts:
        assert guardrails.check_output(text, set()).reason is None, text
