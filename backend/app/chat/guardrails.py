"""ルールベースの入出力ガード（DocuNavi の app/agents/guardrails.py から、注文用に書き直したもの）。

LLM を使わない純粋関数だけ。模擬モデルでも実モデルでも同じに動き、テストが決定的になる。パターン照合は「典型的な手口を安く弾く」ためで、
プロンプトとツールの設計（確定のツールが無いこと）の代わりにはならない。**守りの本体は、確定のツールを渡さないこと**で、ここは文面の事故を減らす層。

- 入力: 指示の上書き・プロンプトの開示・役の乗っ取り・テンプレートの偽装・内部のツール名の指定（check_input）。
- ツール結果: 商品名・説明などの文字列は、信頼できないデータ。長さを切り、指示に見える文は伏せ、包みの記号を壊す（scrub_untrusted）。
- 出力: ①確定を言い切る文（確定のイベントが無いのに）②ツール結果に無い価格・合計 ③アレルギーで、データに無いことを言い切る文
  ④プロンプトの漏洩、を、固定の文に置き換える（check_output）。
"""

import re
import unicodedata
from collections.abc import Collection
from dataclasses import dataclass
from difflib import SequenceMatcher

from app.chat import config

# 拒否・置き換えの理由コード（ログ・監査用。利用者には返さない）
REASON_OVERRIDE = "instruction_override"
REASON_DISCLOSURE = "prompt_disclosure"
REASON_ROLE_HIJACK = "role_hijack"
REASON_TEMPLATE = "template_injection"
REASON_TOOL_NAME = "tool_name"
REASON_CONFIRM_CLAIM = "confirmation_claim"
REASON_PRICE = "price_not_in_tool_result"
REASON_ALLERGY = "allergy_negative_claim"
REASON_LEAK = "prompt_leak"

# 固定の文（理由を細かく伝えると回避の手がかりになるため、いつも同じ文）
INPUT_REFUSAL_REPLY = "申し訳ありませんが、そのご依頼にはお応えできません。ご注文や商品についてお知らせください。"
REDACTED_USER_TEXT = "（この発言は安全上の理由により履歴から除外されました）"
CLAIM_FALLBACK = "注文の確定は、確認カードの確定ボタンを押したときだけ行われます。チャットの返事では、注文は確定されていません。"
PRICE_FALLBACK = "金額は、カードに表示されている値が正です。お手数ですが、カードの内容をご確認ください。"
ALLERGY_FALLBACK = (
    "アレルギーについては、登録されているデータの範囲でしかお答えできません。"
    "データに無いことを、私から言い切ることはできませんので、店舗のスタッフへご確認ください。"
)
LEAK_FALLBACK = "申し訳ありませんが、この回答は内容を確認できないためお出しできません。別の聞き方でお知らせください。"
FAILURE_REPLY = "申し訳ありません。うまく処理できませんでした。しばらくしてから、もう一度お試しください。"
LIMIT_REPLY = "一度に処理できる量を超えたため、ここで止めました。内容を分けて、もう一度お知らせください。"
EMPTY_REPLY = "うまく聞き取れませんでした。ご注文の品・サイズ・温度・数量をお知らせください。"
UNTRUSTED_PLACEHOLDER = "（内容を省略しました）"

_FALLBACKS = {
    REASON_CONFIRM_CLAIM: CLAIM_FALLBACK,
    REASON_PRICE: PRICE_FALLBACK,
    REASON_ALLERGY: ALLERGY_FALLBACK,
    REASON_LEAK: LEAK_FALLBACK,
}

# カタカナ -> ひらがな。表記ゆれ（システム / しすてむ）を同一視するために使う
_KATA_TO_HIRA = {c: c - 0x60 for c in range(0x30A1, 0x30F7)}


def _normalize(text: str) -> str:
    """NFKC（全角半角・合字の統一）、不可視文字の除去、小文字化、かな統一を行う。"""
    nfkc = unicodedata.normalize("NFKC", text)
    visible = "".join(ch for ch in nfkc if unicodedata.category(ch) != "Cf")  # ゼロ幅スペースなどを挟んだ回避を防ぐ
    return visible.casefold().translate(_KATA_TO_HIRA)


def _squash(normalized: str) -> str:
    """空白・句読点・記号・結合文字を全て除く。「i.g n-o r e」型の挿入回避に耐えるため。"""
    return "".join(ch for ch in normalized if unicodedata.category(ch)[0] not in "ZPSCM")


def _compile(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern.translate(_KATA_TO_HIRA), re.MULTILINE)


def _near(a: str, b: str, window: int) -> str:
    """a と b が window 文字以内に（どちらの順でも）現れるパターン。量指定子は上限付きで ReDoS を避ける。"""
    return rf"(?:{a}.{{0,{window}}}?{b}|{b}.{{0,{window}}}?{a})"


# ---- 入力のルール（日本語と英語。DocuNavi から、「前の指示」などを足した） ----
_JA_OVERRIDE_PREFIX = r"(?:以前|これまで|それまで|今まで|先ほど|さっき|上記|前述|前回|前|あなた(?:の|への|に与えられた)|初期|デフォルト)の?"
_JA_OVERRIDE_TARGET = r"(?:指示|命令|ルール|制約|制限|設定|プロンプト|指令|会話|やり取り|やりとり|内容|入力|条件|ガイドライン|方針|役割)"
# 「取り消す・キャンセル・リセット」は入れない（注文では「さっきの内容をキャンセルして」が、カートをやめる普通の頼みになる。ツールが無いので害は無い）
_JA_DISCARD = r"(?:(?:無視|破棄|無効|解除|上書き)(?:して|しろ|せよ|しなさい|に)|忘れ(?:て|ろ|よ|なさい))"
_JA_ROLE_END = (
    r"(?:です|だ(?:よ|ぞ|ね)?$|である|になりきっ|になって|になる|を演じ|のふり|と名乗|と呼ばれ|として扱"
    r"|として(?:振る舞|ふるまう|ふるまっ|行動|答え|回答|返答|話し|喋|応答|対応))"
)
_JA_NOW = r"(?:今|いま|これ|今後|今日|今度|これ以降|以後|以降)"
_JA_YOU = r"(?:あなた|君|きみ|お前|おまえ|貴方|そなた)"
_JA_PROMPT_NOUN = (
    r"(?:システム(?:プロンプト|メッセージ|指示|命令)|初期(?:プロンプト|指示)|内部(?:プロンプト|指示|命令|ルール)|隠し(?:プロンプト|指示|命令)"
    r"|あなた(?:の|への|に与えられた|が与えられた)(?:プロンプト|指示|命令|ルール|設定|制約|プログラム|ガイドライン)"
    r"|開発者(?:の|からの)(?:指示|命令|プロンプト|メッセージ)|プロンプト)"
)
_JA_DISCLOSE_VERB = (
    r"(?:教えて|おしえて|教示|見せて|みせて|見たい|知りたい|表示|出力|開示|公開|暴露|漏ら|漏洩|言って|いって|答えて|こたえて|書いて|かいて"
    r"|書き出|コピー|貼って|貼り付|晒|さらし|そのまま|全文|列挙|復唱|繰り返|くりかえ|読み上げ|提示|共有|翻訳|要約|言い換|変更|書き換|上書き|更新|差し替|置き換)"
)
_EN_OVERRIDE_VERB = r"(?:ignore|disregard|forget|override|bypass|discard)"
_EN_OVERRIDE_MOD = (
    r"(?:all|any|every|the|your|my|these|those|of|everything|anything|previous|prior|above|earlier|preceding"
    r"|former|original|initial|system|safety|existing|current|given|other)"
)
_EN_OVERRIDE_NOUN = (
    r"(?:instructions?|prompts?|rules?|directions?|directives?|guidelines?|context|messages?|commands?|constraints?|restrictions?|programming|training|said|told)"
)
_EN_PROMPT_NOUN = (
    r"(?:system(?:prompt|message|instructions?|directives?)"
    r"|your(?:system|initial|original|hidden|secret|internal|core|underlying)?(?:prompt|instructions?|rules|guidelines|directives?|programming|configuration|settings|preamble|setup)"
    r"|developermessage)"
)
_EN_DISCLOSE_VERB = (
    r"(?:reveal|show|print|display|repeat|output|tell|give|share|leak|dump|expose|disclose|recite|paste|copy|write|echo|send|provide|list|read|quote"
    r"|translate|summari[sz]e|paraphrase|encode|decode|whatis|whatare|whats|whatwas|whatwere|spell|extract|retrieve|verbatim|wordforword|reproduce|outline|describe|explain)"
)
# 内部のツール名（確定・決済・個人情報の変更）を指定して呼ばせようとする入力。これらのツールは存在しないが、試みとして拒否する
_TOOL_NAME = (
    r"(?:place_?order|confirm_?order|submit_?order|execute_?payment|process_?payment|charge_?card|refund_?order|update_?address|change_?address"
    r"|delete_?account|set_?price|apply_?discount|checkout_?confirm)"
)

_SQUASHED_RULES: list[tuple[str, re.Pattern[str]]] = (
    [
        (REASON_OVERRIDE, _compile(p))
        for p in [
            rf"{_JA_OVERRIDE_PREFIX}{_JA_OVERRIDE_TARGET}(?:を|は|も)?(?:すべて|全て|全部|一切|いったん|一旦)?{_JA_DISCARD}",
            rf"(?:指示|命令|ルール|制約|制限|プロンプト|設定)(?:を|は|も)(?:すべて|全て|全部|一切){_JA_DISCARD}",
            r"新しい(?:指示|命令|プロンプト)",
            r"(?:制限|規制|フィルター|ガードレール|検閲)(?:を|は)?(?:すべて|全て|全部)?(?:解除|外し|無視|無効|取り払|撤廃)(?:して|しろ|せよ|してください|してくれ|なさい)",
            rf"{_EN_OVERRIDE_VERB}{_EN_OVERRIDE_MOD}{{1,6}}{_EN_OVERRIDE_NOUN}",
            r"(?:ignore|disregard|forget)(?:everything|anything|all)(?:above|before|previously|prior|youweretold|youknow)",
            r"(?:overwrite|override|replace|update|change|modify)(?:your|the|all)(?:system|original|initial|previous)?(?:instructions?|prompt|rules|programming|directives?)",
            r"new(?:system)?(?:instructions?|directives?|prompt)",
        ]
    ]
    + [
        (REASON_DISCLOSURE, _compile(p))
        for p in [
            _near(_JA_PROMPT_NOUN, _JA_DISCLOSE_VERB, 20),
            _near(_EN_PROMPT_NOUN, _EN_DISCLOSE_VERB, 20),
            r"(?:repeat|print|output|recite|echo|copy|write|say|show)(?:out|back)?(?:everything|all|the(?:words|text|content|message|conversation|sentences?))(?:above|before|prior|sofar)",
            r"startingwith(?:the)?(?:words?)?youare",
        ]
    ]
    + [
        (REASON_ROLE_HIJACK, _compile(p))
        for p in [
            rf"あなた(?:は|が|には){_JA_NOW}(?:から|より|は).{{0,40}}?{_JA_ROLE_END}",
            rf"{_JA_NOW}(?:から|より)(?:は)?{_JA_YOU}(?:は|が|には).{{0,40}}?{_JA_ROLE_END}",
            r"脱獄|ジェイルブレイク|開発者モード|デベロッパーモード|管理者モード",
            r"youarenow(?:a|an|the|my|in|free|unrestricted|no|called|named|dan|going|acting|playing|operating)",
            r"youarenolonger",
            r"(?:fromnow(?:on(?:wards?)?)?|fromthis(?:point|moment)on(?:wards?)?|startingnow)(?:you(?:are|re|will|shall|must|should|can|may)|act|behave|respond|answer|pretend|ignore|play|roleplay)",
            r"pretend(?:to|that|you|youre)",
            r"(?:actas|behaveas)(?:if|though|a|an|my)|playtheroleof|roleplayas",
            r"doanythingnow|jailbreak|(?:dan|dev|developer|god|sudo|admin|unrestricted|unfiltered)mode",
        ]
    ]
    + [(REASON_TOOL_NAME, _compile(_TOOL_NAME))]
)

# 句読点などを保ったまま（_normalize 後）照合するルール。チャットテンプレートの偽装など
_TEMPLATE_RULES: list[tuple[str, re.Pattern[str]]] = [
    (REASON_TEMPLATE, _compile(p))
    for p in [
        r"<\|[a-z0-9_]{2,24}\|>",
        r"\[/?(?:inst|sys|system)\]|<</?sys>>",
        r"^[ \t]*(?:system|assistant|developer|tool|システム|アシスタント|開発者)[ \t]*:",
    ]
]

# ツール結果（商品名・説明など）の中の、指示に見える文。入力のルールに加えて、注文・ツールに特有の言い回しを伏せる
_DATA_RULES: list[re.Pattern[str]] = [
    _compile(p)
    for p in [
        r"(?:注文|決済|支払い|お支払い|購入|会計)(?:を)?(?:確定|実行|完了|成立)?(?:して|しろ|せよ|しなさい|してください|させて)",
        r"(?:ツール|関数|function|tool)(?:を)?(?:呼|実行|使)",
        r"(?:回答|返答|答え|応答)(?:は|を)?.{0,12}?(?:にして|として|と答えて|と言って|とだけ)",
        r"(?:ユーザー|お客様|顧客)(?:に|へ)(?:は)?.{0,12}?(?:伝えて|言って|答えて|知らせて|表示して)",
        r"(?:無料|ただ|0ルミ|ゼロ)(?:に|で)(?:して|しろ|せよ)",
        r"(?:カート|品|商品)(?:を)?(?:空|全部|すべて|全て).{0,6}?(?:して|しろ|せよ)",
    ]
]


def check_input(text: str) -> str | None:
    """利用者の入力が拒否対象なら理由コードを、通過なら None を返す。"""
    normalized = _normalize(text)
    for reason, pattern in _TEMPLATE_RULES:
        if pattern.search(normalized):
            return reason
    squashed = _squash(normalized)
    for reason, pattern in _SQUASHED_RULES:
        if pattern.search(squashed):
            return reason
    return None


# ---- ツール結果（信頼できないデータ） ----

def scrub_untrusted(text: str, limit: int | None = None) -> str:
    """ツール結果の文字列（商品名・説明など）を、モデルに見せられる形にする。

    ① 制御文字を空白にして長さを切る ② 指示に見える文（入力のルール + 注文・ツール特有の言い回し）が入っていれば、全体を伏せる
    ③ 包みの記号 [ ] を全角にして、データの中に「データの終わり」を作れないようにする。
    """
    limit = config.TOOL_TEXT_MAX_CHARS if limit is None else limit
    cleaned = "".join(" " if unicodedata.category(ch)[0] == "C" else ch for ch in text).strip()
    normalized = _normalize(cleaned)
    squashed = _squash(normalized)
    if check_input(cleaned) is not None or any(p.search(squashed) for p in _DATA_RULES):
        return UNTRUSTED_PLACEHOLDER
    cleaned = cleaned.replace("[", "［").replace("]", "］")
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1] + "…"


# ---- 出力 ----

_CLAIM_RULES: list[re.Pattern[str]] = [
    _compile(p)
    for p in [
        # 注文の確定・完了を、事実として言い切る文（AI は確定できないので、どれも事実ではない）
        r"(?:ご)?注文(?:を|が|は)?(?:確定|完了|成立|受理|受付)(?:しました|いたしました|致しました|されました|できました|しています|しております|済み|ずみ)",
        r"(?:ご)?注文(?:を)?(?:しました|いたしました|致しました|承りました|うけたまわりました|受け付けました|受付しました|受けつけました|通しました|通りました)",
        r"(?:確定|決済|支払い|お支払い|会計|購入|発注)(?:を|が)?(?:完了|成立|済み|済ませ|させ)",
        r"(?:確定|決済|お?支払い|購入|発注|手配|予約|注文)(?:を)?(?:しました|いたしました|致しました|してあります|しておきました|済ませました)",
        # 「確定します」「決済いたします」: AI が確定できるかのような言い方
        r"(?:確定|決済|お?支払い|購入|発注)(?:を|は)?(?:します|いたします|致します|行います|おこないます|させていただきます)",
        r"ご注文(?:を)?(?:ありがとうございました|いただきました|頂きました)",
        r"orders?(?:hasbeen|is|was|has)?(?:placed|confirmed|complete|completed|submitted|finalized)",
        r"(?:i|ive|ihave|ivejust|ihavejust)?(?:placed|confirmed|submitted|finalized)(?:your|the)order",
        r"payment(?:was|is|has)?(?:successful|completed|processed|made)",
    ]
]

_ALLERGY_CONTEXT = _compile(
    r"アレルギー|アレルゲン|乳|卵|小麦|くるみ|ナッツ|そば|蕎麦|えび|海老|かに|蟹|落花生|ピーナッツ|大豆|ごま|胡麻|グルテン|ラクトース|乳糖|原材料|成分|添加物"
)
_ALLERGY_NEGATIVE = [
    _compile(p)
    for p in [
        r"(?:含まれ|入っ|使われ|使っ|使用され|使用し|含ん|含有し)(?:て)?(?:い)?(?:ません|ない|おりません)",
        r"含みません|含まない|含有しません",
        r"アレルゲン(?:は|が)?(?:ありません|ない|なし|ゼロ|フリー|不使用)",
        r"アレルギー(?:フリー|対応済み)|ノンアレルゲン",
        r"アレルギー(?:の方|のある方)?(?:も|でも|の方も)(?:大丈夫|問題ありません|安心|召し上がれ|お召し上がり|お飲み)",
        r"安心して(?:お召し上がり|召し上がっ|お飲み|ご利用|お楽しみ)",
    ]
]
# 同じ文に、言い切らない言い方（できない・かどうか）があれば、言い切りではない
_ALLERGY_HEDGE = _compile(r"言い切れ|限りません|断言|断定|確認できません|分かりません|わかりません|かどうか|ご確認ください|スタッフへ")

_PRICE_UNIT = re.compile(r"(\d[\d,]*)\s*(ルミ|円)")
_PRICE_YEN_SIGN = re.compile(r"[¥￥]\s*(\d[\d,]*)")
_PRICE_LABEL = re.compile(r"(?:合計|小計|総額|お会計|代金|料金|価格|値段|金額|送料)[^\d。\n]{0,6}?(\d[\d,]*)")


def numbers_in(value: object) -> set[int]:
    """ツール結果（dict・list・数値）に出てくる整数を全部集める（価格・合計の検査の「許す値」）。真偽値は数えない。"""
    found: set[int] = set()

    def walk(v: object) -> None:
        if isinstance(v, bool):
            return
        if isinstance(v, int):
            found.add(v)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple)):
            for x in v:
                walk(x)

    walk(value)
    return found


def _price_violation(text: str, allowed: Collection[int]) -> bool:
    normalized = unicodedata.normalize("NFKC", text)
    for number, unit in _PRICE_UNIT.findall(normalized):
        if unit == "円" or int(number.replace(",", "")) not in allowed:
            return True
    for number in _PRICE_YEN_SIGN.findall(normalized) + _PRICE_LABEL.findall(normalized):
        if int(number.replace(",", "")) not in allowed:
            return True
    return False


def _allergy_violation(text: str) -> bool:
    for sentence in re.split(r"[。！？!?\n]", unicodedata.normalize("NFKC", text)):
        if not sentence:
            continue
        squashed = _squash(_normalize(sentence))
        if not _ALLERGY_CONTEXT.search(squashed) or _ALLERGY_HEDGE.search(squashed):
            continue
        if any(p.search(squashed) for p in _ALLERGY_NEGATIVE):
            return True
    return False


def leaks_secret(text: str, secret: str, min_run: int = 24) -> bool:
    """text が secret（システムプロンプト）をほぼそのまま含んでいるか。空白や記号の違いを無視した最長共通部分文字列で判定する。"""
    reply = _squash(_normalize(text))
    target = _squash(_normalize(secret))
    if not reply or not target:
        return False
    longest = SequenceMatcher(None, reply, target, autojunk=False).find_longest_match(0, len(reply), 0, len(target))
    return longest.size >= min(min_run, len(target))


@dataclass(frozen=True)
class OutputVerdict:
    text: str  # 利用者へ出す本文（問題があれば固定の文）
    reason: str | None  # 置き換えた理由のコード（問題が無ければ None）


def check_output(text: str, allowed_numbers: Collection[int], secret: str = "") -> OutputVerdict:
    """モデルの本文を検査する。①確定の言い切り ②ツール結果に無い価格・合計 ③アレルギーの言い切り ④プロンプトの漏洩。1 つでも当たれば、固定の文に置き換える。

    allowed_numbers は、このターンのツール結果に出てきた整数（numbers_in）。確定のイベントは、チャットには存在しない（確定は画面のボタンだけ）ので、
    確定を言い切る文は、いつも置き換える（ツール結果の「状態」を読んで伝える文は、「確定しました」でなく状態の語を使う）。
    """
    squashed = _squash(_normalize(text))
    if any(p.search(squashed) for p in _CLAIM_RULES):
        return OutputVerdict(_FALLBACKS[REASON_CONFIRM_CLAIM], REASON_CONFIRM_CLAIM)
    if _price_violation(text, allowed_numbers):
        return OutputVerdict(_FALLBACKS[REASON_PRICE], REASON_PRICE)
    if _allergy_violation(text):
        return OutputVerdict(_FALLBACKS[REASON_ALLERGY], REASON_ALLERGY)
    if secret and leaks_secret(text, secret):
        return OutputVerdict(_FALLBACKS[REASON_LEAK], REASON_LEAK)
    return OutputVerdict(text, None)
