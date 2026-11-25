package main

// 模擬の ChatModel（CHAT_MODEL=mock。既定）。決定的な規則ベースで、日本語の注文の言い回しを解釈して、ツールを呼ぶ（backend/app/chat/mock_model.py の移植）。
//   - 乱数・時刻・外部通信を使わない（同じ会話からは、同じ応答）。メニューの知識を持たず、品の特定・価格・在庫は、すべてツール（search_menu など）の結果から取る
//   - 作りは「発話ごとの台本」。台本は、ツールを呼び（callTool）、その結果を受け取って、次の呼び出しか最終の文を返す。
//     reply() は呼ばれるたび、台本を最初から再生し、このターンで済んだツール結果を順に渡して、次の 1 手を返す（モデル自身は状態を持たない）。
//     Python は生成器（yield）で書いていた。Go では、結果が足りない呼び出しの所で panic(needCall) して、reply が受ける
//   - 文面に出す価格・合計は、ツール結果の数字だけ（ガードが検査する）。確定を言い切らない（「注文しました」は言わない）
//   - **限界:** これは「配線」と安全の層を決定的に試すための道具で、実モデルの言語理解・ツール選択・指示への弱さの代わりにはならない。
//     解釈できるのは、下の規則に書いた言い回しだけ
// Python の re の先読み・後読み（?<!…）（?!…）は RE2 に無いので、該当する所（区切り・サイズ・ホット・アイス・数量・注文番号）は、同じ規則を手で書いた。

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	repeatMark      = "いつものご注文の候補です" // 「いつもの」の候補を出した発話の目印（次の発話の「1」「2」を、その選択として読む）
	maxItemsPerTurn = 4              // 1 つの発話で解釈する品名の数（書き込みは別に 3 回まで）
	mockMaxWrites   = 3              // chat.md: 1 ターンの書き込みは 3 回まで（ツール側でも拒否する。模擬は、先に数えて、残りを案内する）
)

var reasonJA = map[string]string{"out_of_season": "季節・期間の外", "out_of_hours": "販売時間の外", "sold_out": "売り切れ"}
var closedJA = map[string]string{
	"closed_today":             "本日は定休日です",
	"temporary_closure":        "本日は臨時休業です",
	"outside_hours":            "いまは営業時間の外です",
	"past_last_order":          "ラストオーダーの時間を過ぎています",
	"mobile_order_unavailable": "この店はモバイルオーダーに対応していません",
}
var tempJA = map[string]string{"hot": "ホット", "ice": "アイス", "-": ""}

// ---- 文面（固定。数字は入れない。入れるときは、ツール結果の値だけ）----
const (
	sayGreeting          = "いらっしゃいませ。ご注文のお手伝いをします。品名・サイズ・温度・数量を、たとえば「オアシスブレンドのMをホットで2つ」のようにお知らせください。"
	sayUnknown           = "うまく聞き取れませんでした。「オアシスブレンドのMをホットで2つ」のように、品名・サイズ・温度・数量をお知らせください。"
	sayRefuseAccount     = "ご登録内容（住所・電話・お支払い方法など）の変更や、他のお客様の情報のご案内は、チャットではできません。ご自身の画面からお手続きください。"
	sayRefuseOrderChange = "ご注文の取り消しや返金は、チャットではできません。注文の画面からお手続きください。"
	sayAck               = "「はい」のお返事では、ご注文は確定されません。確認カードの確定ボタンを押してください。内容を変えるときは、お知らせください。"
	sayDelivery          = "宅配は準備中です。いまは、店頭でのお受け取りだけをご案内しています。店頭受け取りで進めますか。"
	sayPickup            = "店頭でのお受け取りにしました。お受け取りは、店舗のカウンターです。"
	sayAllergyClosing    = "データに無いことは、私からはお答えできません。アレルギーのある方は、ご注文の前に店舗のスタッフへご確認ください。"
	sayConfirmHint       = "ご注文の確認は「注文内容を確認」とお伝えください。"
)

type mockSeg struct {
	core     string // 品名の部分
	size     string // 空なら指定なし
	temp     string
	qty      int // 0 なら指定なし（Python は 0 と None を、どちらも「指定なし」に使う。hasQty は、数字が書かれていたか）
	hasQty   bool
	additive bool
}

type recordedCall struct {
	call toolCall
	data map[string]any
}

type mockView struct {
	text      string         // 今回の発話（NFKC）
	cart      map[string]any // ターンの先頭で読んだカート
	results   []recordedCall // このターンで済んだツール結果（先頭の get_cart を除く）
	prevText  string         // 直前のアシスタントの発話
	prevCards []string       // 直前のアシスタントの発話に付いたカードの種類
}

func parseMock(messages []chatMessage) *mockView {
	lastUser := -1
	for i, m := range messages {
		if m.role == "user" {
			lastUser = i
		}
	}
	text := ""
	if lastUser >= 0 {
		text = norm.NFKC.String(messages[lastUser].content)
	}
	view := &mockView{text: text, cart: map[string]any{"lines": []any{}, "total_lumi": 0, "version": 0}}
	if lastUser >= 0 {
		for i := lastUser - 1; i >= 0; i-- {
			m := messages[i]
			if m.role == "assistant" && len(m.toolCalls) == 0 {
				view.prevText = m.content
				if kinds, ok := m.meta["card_kinds"].([]any); ok {
					for _, k := range kinds {
						view.prevCards = append(view.prevCards, asStr(k))
					}
				}
				break
			}
		}
	}
	calls := map[string]toolCall{}
	firstTool := true
	for _, m := range messages[lastUser+1:] {
		switch m.role {
		case "assistant":
			for _, c := range m.toolCalls {
				calls[c.id] = c
			}
		case "tool":
			call, found := calls[m.toolCallID]
			data := m.data
			if data == nil {
				data = map[string]any{"ok": false}
			}
			if firstTool && found && call.name == "get_cart" {
				if c, ok := data["cart"]; ok {
					view.cart = asMap(plain(c))
				}
			} else if found {
				view.results = append(view.results, recordedCall{call, asMap(plain(data))})
			}
			firstTool = false
		}
	}
	return view
}

// ---- 言い回しの解釈 ----

var (
	wsClass    = `[\s\x{0b}\x{1c}-\x{1f}\x{85}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]`
	reWS       = regexp.MustCompile(wsClass + `+`)
	qtyUnitRe  = regexp.MustCompile(`(?:(\d+)|([一二三四五六七八九十])|(ひと|ふた|みっ|よっ|いつ))\s*(?:つ|個|杯|本|袋|枚|点|人前|セット)`)
	additiveRe = regexp.MustCompile(`追加|もう|さらに|プラス|もっと`)
	politeRe   = regexp.MustCompile(`サイズ|お願い(?:します|いたします|できますか)?|くださいな|ください|下さい|ちょうだい|頂戴|ほしい|欲しい|頼(?:む|みたい|みます|んで)|注文(?:したい|します|して|お願い)?` +
		`|追加(?:して)?|入れて|いただけますか|もらえますか|もう|さらに|プラス|もっと`)
	bracketsRe   = regexp.MustCompile(`[()「」『』\[\]]`)
	jpNum        = map[string]int{"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "ひと": 1, "ふた": 2, "みっ": 3, "よっ": 4, "いつ": 5}
	edgeChars    = "をのでがはもにやへ 　、。,.!！?？"
	sizeFromKana = map[string]string{"エス": "S", "エム": "M", "エル": "L"}
)

func stripEdges(s string) string { return strings.Trim(s, edgeChars) }

func isASCIILetter(r rune) bool { return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') }

func hasPrefixAt(r []rune, i int, lit string) bool {
	lr := []rune(lit)
	if i+len(lr) > len(r) {
		return false
	}
	for k, c := range lr {
		if r[i+k] != c {
			return false
		}
	}
	return true
}

func foldEqualAt(r []rune, i int, lit string) bool {
	lr := []rune(lit)
	if i+len(lr) > len(r) {
		return false
	}
	for k, c := range lr {
		if unicode.ToLower(r[i+k]) != c {
			return false
		}
	}
	return true
}

var splitWords = []string{"それから", "それと", "あとは", "あと", "ほかに", "それに", "および"}

// splitMatchLen は区切り（_SPLIT）の、位置 i の一致の長さ（無ければ 0）:
// [、,，。\n] | それから|それと|あとは|あと|ほかに|それに|および | と(?![きこそうい]) | [＋+＆&]
func splitMatchLen(r []rune, i int) int {
	if strings.ContainsRune("、,，。\n", r[i]) {
		return 1
	}
	for _, w := range splitWords {
		if hasPrefixAt(r, i, w) {
			return utf8.RuneCountInString(w)
		}
	}
	if r[i] == 'と' && (i+1 >= len(r) || !strings.ContainsRune("きこそうい", r[i+1])) {
		return 1
	}
	if strings.ContainsRune("＋+＆&", r[i]) {
		return 1
	}
	return 0
}

func splitPieces(text string) []string {
	r := []rune(text)
	var pieces []string
	start := 0
	for i := 0; i < len(r); {
		if n := splitMatchLen(r, i); n > 0 {
			pieces = append(pieces, string(r[start:i]))
			i += n
			start = i
			continue
		}
		i++
	}
	return append(pieces, string(r[start:]))
}

// findSize は _SIZE（(?<![a-zA-Z])([smlSML])(?![a-zA-Z])|(エス|エム|エル)サイズ）の最初の一致。(開始, 終了, サイズ文字) の位置は文字の番号。
func findSize(r []rune) (int, int, string, bool) {
	for i := range r {
		if strings.ContainsRune("smlSML", r[i]) && (i == 0 || !isASCIILetter(r[i-1])) && (i+1 >= len(r) || !isASCIILetter(r[i+1])) {
			return i, i + 1, strings.ToUpper(string(r[i])), true
		}
		for kana, sz := range sizeFromKana {
			if hasPrefixAt(r, i, kana+"サイズ") {
				return i, i + 5, sz, true
			}
		}
	}
	return 0, 0, "", false
}

type span struct{ start, end int }

// findAllMatches は (位置 → 一致の長さ) の関数で、重ならない一致を全部集める（re.finditer と同じ）。
func findAllMatches(r []rune, matchLen func(r []rune, i int) int) []span {
	var out []span
	for i := 0; i < len(r); {
		if n := matchLen(r, i); n > 0 {
			out = append(out, span{i, i + n})
			i += n
			continue
		}
		i++
	}
	return out
}

// hotLen は _HOT（ホット(?!サンド)|あったかい|温かい|あたたかい|(?<![a-z])hot(?![a-z])。大文字小文字を区別しない）。
func hotLen(r []rune, i int) int {
	if hasPrefixAt(r, i, "ホット") && !hasPrefixAt(r, i+3, "サンド") {
		return 3
	}
	for _, w := range []string{"あったかい", "温かい", "あたたかい"} {
		if hasPrefixAt(r, i, w) {
			return utf8.RuneCountInString(w)
		}
	}
	if foldEqualAt(r, i, "hot") && (i == 0 || !isASCIILetter(r[i-1])) && (i+3 >= len(r) || !isASCIILetter(r[i+3])) {
		return 3
	}
	return 0
}

// iceLen は _ICE（アイス|冷たい|つめたい|冷やし|(?<![a-z])iced?(?![a-z])）。
func iceLen(r []rune, i int) int {
	for _, w := range []string{"アイス", "冷たい", "つめたい", "冷やし"} {
		if hasPrefixAt(r, i, w) {
			return utf8.RuneCountInString(w)
		}
	}
	if i == 0 || !isASCIILetter(r[i-1]) {
		for _, w := range []string{"iced", "ice"} {
			if foldEqualAt(r, i, w) {
				n := len(w)
				if i+n >= len(r) || !isASCIILetter(r[i+n]) {
					return n
				}
			}
		}
	}
	return 0
}

func removeSpans(r []rune, spans []span, repl string) string {
	var b strings.Builder
	prev := 0
	for _, s := range spans {
		b.WriteString(string(r[prev:s.start]))
		b.WriteString(repl)
		prev = s.end
	}
	b.WriteString(string(r[prev:]))
	return b.String()
}

func isWordLike(r rune) bool { return unicode.IsDigit(r) || r == '.' || isASCIILetter(r) }

// findBareQty は _QTY_BARE（(?<![\d.A-Za-z])(\d{1,2})(?![\d.A-Za-z])）の最初の一致。
func findBareQty(r []rune) (int, int, int, bool) {
	for i := range r {
		if !unicode.IsDigit(r[i]) || (i > 0 && isWordLike(r[i-1])) {
			continue
		}
		for n := 2; n >= 1; n-- {
			if i+n > len(r) {
				continue
			}
			ok := true
			for k := 0; k < n; k++ {
				if !unicode.IsDigit(r[i+k]) {
					ok = false
				}
			}
			if ok && (i+n >= len(r) || !isWordLike(r[i+n])) {
				v, _ := strconv.Atoi(string(r[i : i+n]))
				return i, i + n, v, true
			}
		}
	}
	return 0, 0, 0, false
}

func segmentOfPiece(piece string) mockSeg {
	seg := mockSeg{additive: additiveRe.MatchString(piece)}
	r := []rune(piece)
	if s, e, sz, ok := findSize(r); ok {
		seg.size = sz
		piece = string(r[:s]) + " " + string(r[e:])
	}
	r = []rune(piece)
	if spans := findAllMatches(r, hotLen); len(spans) > 0 {
		seg.temp = "hot"
		piece = removeSpans(r, spans, " ")
	}
	r = []rune(piece)
	if spans := findAllMatches(r, iceLen); len(spans) > 0 {
		seg.temp = "ice"
		piece = removeSpans(r, spans, " ")
	}
	if loc := qtyUnitRe.FindStringSubmatchIndex(piece); loc != nil {
		sub := qtyUnitRe.FindStringSubmatch(piece)
		seg.hasQty = true
		switch {
		case sub[1] != "":
			seg.qty, _ = strconv.Atoi(sub[1])
		case sub[2] != "":
			seg.qty = jpNum[sub[2]]
		default:
			seg.qty = jpNum[sub[3]]
		}
		piece = piece[:loc[0]] + " " + piece[loc[1]:]
	} else if s, e, q, ok := findBareQty([]rune(piece)); ok {
		seg.qty, seg.hasQty = q, true
		rr := []rune(piece)
		piece = string(rr[:s]) + " " + string(rr[e:])
	}
	core := stripEdges(politeRe.ReplaceAllString(bracketsRe.ReplaceAllString(piece, " "), " "))
	seg.core = stripEdges(reWS.ReplaceAllString(core, ""))
	return seg
}

func segmentsOf(text string) []mockSeg {
	var out []mockSeg
	for _, p := range splitPieces(norm.NFKC.String(text)) {
		if seg := segmentOfPiece(p); seg.core != "" {
			out = append(out, seg)
		}
	}
	return out
}

// findOrderID は _RE_ORDER_ID（(?<![A-Za-z0-9])([A-HJ-NP-Za-hj-np-z2-9]{8})(?![A-Za-z0-9])）の最初の一致。
func findOrderID(s string) (string, bool) {
	r := []rune(s)
	alnum := func(c rune) bool { return isASCIILetter(c) || (c >= '0' && c <= '9') }
	inClass := func(c rune) bool {
		switch {
		case c >= 'A' && c <= 'Z':
			return c != 'I' && c != 'O'
		case c >= 'a' && c <= 'z':
			return c != 'i' && c != 'o'
		case c >= '2' && c <= '9':
			return true
		}
		return false
	}
	for i := 0; i+8 <= len(r); i++ {
		if i > 0 && alnum(r[i-1]) {
			continue
		}
		ok := true
		for k := 0; k < 8; k++ {
			if !inClass(r[i+k]) {
				ok = false
				break
			}
		}
		if ok && (i+8 >= len(r) || !alnum(r[i+8])) {
			return string(r[i : i+8]), true
		}
	}
	return "", false
}

var (
	accountRe    = regexp.MustCompile(`(住所|電話|メール|パスワード|退会|アカウント|カード番号|クレジット|個人情報|登録情報)`)
	accountActRe = regexp.MustCompile(`(変更|変えて|変えたい|教えて|削除|消して|更新|登録|見せて)`)
	othersRe     = regexp.MustCompile(`(他の(人|お客|方)|ほかの(人|お客|方)|他人|別の人|[^\s]{1,10}さんの(注文|履歴|住所))`)
	refundRe     = regexp.MustCompile(`返金|払い戻し|払戻`)
	cancelRe     = regexp.MustCompile(`(やっぱり|やはり).{0,6}(やめ|いらな|キャンセル|いい)|全部(やめ|消|キャンセル)|(注文|カート)(を)?(やめ|キャンセル|空に|クリア|取り消)|キャンセル|やめます|やめる|やめておく|いらない|最初から`)
	ackRe        = regexp.MustCompile(`(?i)^(はい|ええ|うん|ok|オーケー|おっけー|お願いします|それで(お願い|いい|ok)|大丈夫(です)?)[。!！、\s]*$`)
	confirmKeyRe = regexp.MustCompile(`確認|会計|決定|確定|購入|支払|決済|注文|これで|それで|レジ|以上|チェックアウト`)
	confirmVocab = regexp.MustCompile(`注文内容|注文|内容|確認|お会計|会計|これで|それで|お願い(?:します)?|いい(?:です)?|決定|決め(?:て|る|ます)?|して|したい|ください|下さい|する|します|を|は|も|で|に|の|です` +
		`|はい|ええ|カート|全部|以上|次|進んで|購入|支払い?|決済|確定|レジ|チェックアウト|お|ご|[。.!！、\s]`)
	statusRe      = regexp.MustCompile(`状況|状態|どうなって|できあが|できた|いつ(頃)?(できる|受け取れ|届)|注文履歴|過去の注文|私の注文|自分の注文|注文(は|って)(どう|まだ)|まだ(です)?か|進捗`)
	repeatRe      = regexp.MustCompile(`いつもの|いつも通り|同じ(の|もの|やつ)|前と同じ|さっきと同じ|前回と同じ|もう(1|一)杯|リピート|前に頼んだ`)
	pickRe        = regexp.MustCompile(`(\d|[一二三])|最初|一番上|上の|はじめ`)
	pickFillerRe  = regexp.MustCompile(`[\d一二三]|番目|番|つ目|個目|つめ|でお願い(?:します)?|お願い(?:します)?|にする|にします|最初の?|一番上|上の|はじめの?|で|を|に|です|[。!！\s]`)
	allergyRe     = regexp.MustCompile(`アレルギ|アレルゲン|(乳|卵|小麦|くるみ|ナッツ|そば|えび|かに|落花生|大豆|ごま|グルテン|ラクトース)(は|が|を)?(入って|含ま|使って|大丈夫|ありま)|入ってますか|含まれてますか`)
	deliveryRe    = regexp.MustCompile(`宅配|配達|届けて|デリバリー|持ってきて|お届け|自宅|家まで`)
	pickupRe      = regexp.MustCompile(`店頭|受け取り|取りに行|持ち帰り|テイクアウト|お店で|店で`)
	pickupWordsRe = regexp.MustCompile(`店頭|受け取り|受取|取りに行(?:きます|く)?|持ち帰り|テイクアウト|お店|店|にして|にする|にします|したい|します|ます|お願い|ください|で|を|に|は|[。!！\s]`)
	menuQRe       = regexp.MustCompile(`メニュー|おすすめ|オススメ|何がある|いくら|値段|価格|ありますか|ありますでしょうか|売り切れ|在庫|どんな|について|説明|教えて|一覧`)
	greetingRe    = regexp.MustCompile(`^(こんにちは|こんばんは|おはよう|はじめまして|やあ|ありがとう|助かりました|どうも|よろしく)`)
	questionWords = regexp.MustCompile(`(?:は|って)?(?:ありますか|ありますでしょうか|ある|いくらですか|いくら|について(?:教えて)?(?:ください)?|を?教えて(?:ください)?|ですか|ますか|おすすめ|オススメ|メニュー` +
		`|値段|価格|説明|詳しく|どんな(?:もの)?|売り切れ|在庫|一覧|アレルギー|アレルゲン|入って(?:ますか|いますか)|含まれて(?:ますか|いますか)|[?？])`)
	allergenWordRe = regexp.MustCompile(`(乳|卵|小麦|くるみ|ナッツ|そば|えび|かに|落花生|大豆|ごま|グルテン|ラクトース)(は|が|を)?`)
	categoryDrink  = regexp.MustCompile(`ドリンク|飲み物|コーヒー`)
	categoryFood   = regexp.MustCompile(`フード|食べ物|軽食|ケーキ|パン`)
)

func residueLen(text string) int {
	return utf8.RuneCountInString(confirmVocab.ReplaceAllString(text, ""))
}

func cartLines(view *mockView) []any { return asList(view.cart["lines"]) }

func hasCard(view *mockView, kind string) bool {
	for _, k := range view.prevCards {
		if k == kind {
			return true
		}
	}
	return false
}

func mockIntent(view *mockView) string {
	t := view.text
	if othersRe.MatchString(t) || (accountRe.MatchString(t) && accountActRe.MatchString(t)) {
		return "refuse_account"
	}
	_, hasID := findOrderID(t)
	if refundRe.MatchString(t) || (strings.Contains(t, "注文") && cancelRe.MatchString(t) && (hasID || len(cartLines(view)) == 0)) {
		return "refuse_order_change"
	}
	if cancelRe.MatchString(t) {
		return "cancel"
	}
	if ackRe.MatchString(pyStrip(t)) && hasCard(view, "confirm") {
		return "ack"
	}
	if confirmKeyRe.MatchString(t) && residueLen(t) <= 1 {
		return "confirm"
	}
	_, hasIDUpper := findOrderID(strings.ToUpper(t))
	if hasIDUpper && !menuQRe.MatchString(t) {
		return "status"
	}
	if statusRe.MatchString(t) {
		return "status"
	}
	if strings.HasPrefix(view.prevText, repeatMark) && pickRe.MatchString(t) && pickFillerRe.ReplaceAllString(t, "") == "" {
		return "repeat_pick"
	}
	if repeatRe.MatchString(t) {
		return "repeat"
	}
	if allergyRe.MatchString(t) {
		return "allergy"
	}
	if deliveryRe.MatchString(t) {
		return "delivery"
	}
	if menuQRe.MatchString(t) {
		return "menu"
	}
	if pickupRe.MatchString(t) && len(segmentsOf(pickupWordsRe.ReplaceAllString(t, " "))) == 0 {
		return "pickup"
	}
	if greetingRe.MatchString(pyStrip(t)) && utf8.RuneCountInString(t) <= 20 {
		return "greeting"
	}
	return "order"
}

// ---- 台本 ----

type needCall struct {
	name string
	args omap
}

type replayMismatch struct{}

type scriptRT struct {
	view *mockView
	idx  int
}

// callTool はツールを呼ぶ。このターンで済んだ結果があれば、それを返す。無ければ、呼び出しを要求して台本を止める（panic(needCall)）。
func (rt *scriptRT) callTool(name string, args omap) map[string]any {
	if rt.idx < len(rt.view.results) {
		rec := rt.view.results[rt.idx]
		if rec.call.name != name {
			panic(replayMismatch{})
		}
		rt.idx++
		return rec.data
	}
	panic(needCall{name, args})
}

func isOK(res map[string]any) bool { return asBool(res["ok"]) }

func labelOf(name string, variant map[string]any) string {
	parts := []string{name}
	if asStr(variant["size"]) != "-" {
		parts = append(parts, asStr(variant["size"]))
	}
	out := strings.Join(parts, " ")
	if temp := tempJA[asStr(variant["temperature"])]; temp != "" {
		out += "（" + temp + "）"
	}
	return out
}

func priceText(variants []any) string {
	type temps struct {
		order  []string
		prices map[string]int
	}
	var sizes []string
	bySize := map[string]*temps{}
	for _, v := range variants {
		vm := asMap(v)
		size, temp := asStr(vm["size"]), asStr(vm["temperature"])
		tm, ok := bySize[size]
		if !ok {
			tm = &temps{prices: map[string]int{}}
			bySize[size] = tm
			sizes = append(sizes, size)
		}
		if _, seen := tm.prices[temp]; !seen {
			tm.order = append(tm.order, temp)
		}
		tm.prices[temp] = asInt(vm["price_lumi"])
	}
	var parts []string
	for _, size := range sizes {
		prefix := ""
		if size != "-" {
			prefix = size + " "
		}
		tm := bySize[size]
		distinct := map[int]bool{}
		for _, p := range tm.prices {
			distinct[p] = true
		}
		if len(distinct) == 1 {
			parts = append(parts, fmt.Sprintf("%s%d ルミ", prefix, tm.prices[tm.order[0]]))
		} else {
			for _, t := range tm.order {
				name, ok := tempJA[t]
				if !ok {
					name = t
				}
				parts = append(parts, fmt.Sprintf("%s（%s）%d ルミ", prefix, name, tm.prices[t]))
			}
		}
	}
	return strings.Join(parts, " / ")
}

func itemLine(item map[string]any) string {
	variants := asList(item["variants"])
	var out []map[string]any
	for _, v := range variants {
		if vm := asMap(v); !asBool(vm["available"]) {
			out = append(out, vm)
		}
	}
	note := ""
	if len(out) > 0 {
		set := map[string]bool{}
		for _, v := range out {
			r, ok := reasonJA[asStr(v["unavailable_reason"])]
			if !ok {
				r = "出せません"
			}
			set[r] = true
		}
		var reasons []string
		for r := range set {
			reasons = append(reasons, r)
		}
		sort.Strings(reasons)
		joined := strings.Join(reasons, "・")
		if len(out) == len(variants) {
			note = "（いまは出せません: " + joined + "）"
		} else {
			note = "（一部は、いま出せません: " + joined + "）"
		}
	}
	return asStr(item["name"]) + ": " + priceText(variants) + note
}

func namesOf(items []map[string]any, limit int) string {
	var names []string
	for i, it := range items {
		if i >= limit {
			break
		}
		names = append(names, asStr(it["name"]))
	}
	return strings.Join(names, "・")
}

func qtyInCart(cart map[string]any, variantID int) int {
	for _, l := range asList(cart["lines"]) {
		lm := asMap(l)
		if asInt(lm["variant_id"]) == variantID {
			return asInt(lm["qty"])
		}
	}
	return 0
}

func itemsOf(res map[string]any) []map[string]any {
	if !isOK(res) {
		return nil
	}
	var out []map[string]any
	for _, i := range asList(res["items"]) {
		out = append(out, asMap(i))
	}
	return out
}

func onlyNameMatches(items []map[string]any) []map[string]any {
	var named []map[string]any
	for _, i := range items {
		if asStr(i["match"]) == "name" {
			named = append(named, i)
		}
	}
	if len(named) > 0 {
		return named
	}
	return items
}

func reasonText(reason string, def string) string {
	if r, ok := reasonJA[reason]; ok {
		return r
	}
	return def
}

func scriptOrder(rt *scriptRT) string {
	view := rt.view
	segs := segmentsOf(view.text)
	if len(segs) > maxItemsPerTurn {
		segs = segs[:maxItemsPerTurn]
	}
	if len(segs) == 0 {
		return sayUnknown
	}
	type plan struct {
		item, variant map[string]any
		qty           int
	}
	var planned []plan
	var questions []string
	type unavail struct{ label, reason, category string }
	var unavailable []unavail
	for _, seg := range segs {
		res := rt.callTool("search_menu", omap{{"query", seg.core}})
		items := itemsOf(res)
		pool := onlyNameMatches(items)
		if len(pool) == 0 {
			questions = append(questions, fmt.Sprintf("「%s」は、メニューで見つかりませんでした。", seg.core))
			continue
		}
		if len(pool) > 1 {
			questions = append(questions, fmt.Sprintf("「%s」には、%s があります。どれにしますか。", seg.core, namesOf(pool, 4)))
			continue
		}
		item := pool[0]
		var variants []map[string]any
		sizes, temps := map[string]bool{}, map[string]bool{}
		for _, v := range asList(item["variants"]) {
			vm := asMap(v)
			variants = append(variants, vm)
			sizes[asStr(vm["size"])] = true
			temps[asStr(vm["temperature"])] = true
		}
		chosen := variants
		if len(sizes) > 1 {
			if seg.size == "" {
				var ss []string
				for s := range sizes {
					ss = append(ss, s)
				}
				sort.Slice(ss, func(i, j int) bool { return strings.Index("SML-", ss[i]) < strings.Index("SML-", ss[j]) })
				questions = append(questions, fmt.Sprintf("%sのサイズ（%s）を教えてください。", asStr(item["name"]), strings.Join(ss, "・")))
				continue
			}
			var f []map[string]any
			for _, v := range chosen {
				if asStr(v["size"]) == seg.size {
					f = append(f, v)
				}
			}
			chosen = f
		}
		if len(temps) > 1 {
			if seg.temp == "" {
				questions = append(questions, fmt.Sprintf("%sは、ホットとアイスのどちらにしますか。", asStr(item["name"])))
				continue
			}
			var f []map[string]any
			for _, v := range chosen {
				if asStr(v["temperature"]) == seg.temp {
					f = append(f, v)
				}
			}
			chosen = f
		}
		if len(chosen) != 1 {
			questions = append(questions, fmt.Sprintf("%s に、その組み合わせはありません。ほかの組み合わせをお選びください。", asStr(item["name"])))
			continue
		}
		variant := chosen[0]
		if !asBool(variant["available"]) {
			unavailable = append(unavailable, unavail{labelOf(asStr(item["name"]), variant), asStr(variant["unavailable_reason"]), asStr(item["category"])})
			continue
		}
		qty := seg.qty
		if qty == 0 {
			qty = 1
		}
		if seg.additive {
			qty += qtyInCart(view.cart, asInt(variant["variant_id"]))
		}
		planned = append(planned, plan{item, variant, qty})
	}
	if len(unavailable) > 0 {
		alt := rt.callTool("search_menu", omap{{"query", ""}, {"filters", omap{{"category", unavailable[0].category}, {"available_only", true}}}})
		altItems := itemsOf(alt)
		for _, u := range unavailable {
			suffix := "ほかの品をお選びください。"
			if len(altItems) > 0 {
				suffix = fmt.Sprintf("代わりに、%sはいかがですか。", namesOf(altItems, 3))
			}
			questions = append(questions, fmt.Sprintf("%sは、いま%sです。%s", u.label, reasonText(u.reason, "出せない状態"), suffix))
		}
	}
	var applied, problems []string
	var lastCart map[string]any
	for i, p := range planned {
		if i >= mockMaxWrites {
			break
		}
		res := rt.callTool("set_cart_item", omap{{"variant_id", asInt(p.variant["variant_id"])}, {"qty", p.qty}})
		name := asStr(p.item["name"])
		switch {
		case isOK(res):
			lastCart = asMap(res["cart"])
			applied = append(applied, fmt.Sprintf("%sを %d 点", labelOf(name, p.variant), p.qty))
			for _, l := range asList(lastCart["lines"]) {
				lm := asMap(l)
				if asInt(lm["variant_id"]) == asInt(p.variant["variant_id"]) {
					if !asBool(lm["available"]) {
						problems = append(problems, fmt.Sprintf("%sは、いま%sのため、ご注文が通らないかもしれません。", name, reasonText(asStr(lm["unavailable_reason"]), "出せない状態")))
					}
					break
				}
			}
		case asStr(res["error"]) == "invalid_arguments":
			problems = append(problems, fmt.Sprintf("%sの数量が多すぎます。1 品あたりの上限を超えています。", name))
		default:
			msg := asStr(res["message"])
			if msg == "" {
				msg = "失敗しました"
			}
			problems = append(problems, fmt.Sprintf("%sをカートに入れられませんでした（%s）", name, msg))
		}
	}
	if len(planned) > mockMaxWrites {
		problems = append(problems, "一度に変更できるのは 3 品までです。残りは、続けてお知らせください。")
	}
	var parts []string
	if len(applied) > 0 {
		parts = append(parts, strings.Join(applied, "、")+"、カートに入れました。")
		if lastCart != nil {
			parts = append(parts, fmt.Sprintf("カートの合計は %d ルミです。", asInt(lastCart["total_lumi"])))
		}
	}
	parts = append(parts, problems...)
	parts = append(parts, questions...)
	if len(applied) > 0 && len(questions) == 0 {
		parts = append(parts, "ほかにご希望があればお知らせください。"+sayConfirmHint)
	}
	if len(parts) == 0 {
		return sayUnknown
	}
	return strings.Join(parts, "")
}

func scriptCancel(rt *scriptRT) string {
	lines := cartLines(rt.view)
	if len(lines) == 0 {
		return "カートはすでに空です。"
	}
	removed := 0
	for i, l := range lines {
		if i >= mockMaxWrites {
			break
		}
		res := rt.callTool("set_cart_item", omap{{"variant_id", asInt(asMap(l)["variant_id"])}, {"qty", 0}})
		if isOK(res) {
			removed++
		}
	}
	if rest := len(lines) - removed; rest > 0 {
		return fmt.Sprintf("カートの品を外しました。まだ %d 品 残っています。もう一度「やっぱりやめる」とお伝えください。", rest)
	}
	return "カートを空にしました。先に出した確認カードは、使えなくなります。"
}

func scriptConfirm(rt *scriptRT) string {
	res := rt.callTool("propose_checkout", omap{})
	if isOK(res) {
		total := asInt(asMap(res["proposal"])["total_lumi"])
		return fmt.Sprintf("ご注文内容の確認カードを出しました。合計は %d ルミです。内容をご確認のうえ、カードの確定ボタンを押してください。確定ボタンを押すまで、ご注文は確定されません。", total)
	}
	msg := asStr(res["message"])
	if msg == "" {
		msg = "失敗しました"
	}
	switch asStr(res["error"]) {
	case "cart_empty":
		return "カートが空です。ご注文の品をお知らせください。"
	case "store_closed":
		reason := asStr(res["closed_reason"])
		why, ok := closedJA[reason]
		if !ok {
			why = "いまは注文を受けられません"
		}
		retry := "営業時間内にもう一度お試しいただくか、別の店で新しく会話を始めてください。"
		if reason == "mobile_order_unavailable" {
			retry = "別の店で新しく会話を始めてください。"
		}
		return fmt.Sprintf("この店は、いまご注文をお受けできません（%s）。%s", why, retry)
	case "item_unavailable":
		ids := map[int]bool{}
		for _, v := range asList(res["variant_ids"]) {
			ids[asInt(v)] = true
		}
		var names []string
		for _, l := range cartLines(rt.view) {
			lm := asMap(l)
			if ids[asInt(lm["variant_id"])] {
				names = append(names, asStr(lm["name"]))
			}
		}
		joined := strings.Join(names, "・")
		if joined == "" {
			joined = "一部の品"
		}
		return fmt.Sprintf("%sは、いま出せません。カートの品を入れ替えてから、もう一度ご確認ください。", joined)
	case "sold_out":
		name := asStr(res["item_name"])
		if name == "" {
			name = "一部の品"
		}
		return fmt.Sprintf("%s が売り切れです。数量を減らすか、別の品にしてください。", name)
	case "over_limit":
		return "1 回のご注文の上限を超えています。品数か数量を減らしてください。"
	}
	return fmt.Sprintf("確認カードを作れませんでした（%s）", msg)
}

var activeOrderStatuses = []string{"placed", "paid", "accepted", "preparing", "ready"}

func scriptStatus(rt *scriptRT) string {
	if id, ok := findOrderID(strings.ToUpper(rt.view.text)); ok {
		res := rt.callTool("get_order_status", omap{{"order_id", id}})
		if !isOK(res) {
			return "その番号のご注文は、見つかりませんでした。番号をご確認ください。"
		}
		o := asMap(res["order"])
		return fmt.Sprintf("ご注文 %s（受け取り番号 %d）の状態は「%s」です。", asStr(o["public_id"]), asInt(o["pickup_no"]), asStr(o["status_label"]))
	}
	listed := rt.callTool("list_my_orders", omap{{"limit", 3}})
	var orders []map[string]any
	if isOK(listed) {
		for _, o := range asList(listed["orders"]) {
			orders = append(orders, asMap(o))
		}
	}
	if len(orders) == 0 {
		return "ご注文の履歴は、まだありません。"
	}
	target := orders[0]
	for _, o := range orders {
		if contains(activeOrderStatuses, asStr(o["status"])) {
			target = o
			break
		}
	}
	res := rt.callTool("get_order_status", omap{{"order_id", asStr(target["public_id"])}})
	if !isOK(res) {
		return "ご注文の状態を取得できませんでした。しばらくしてから、もう一度お試しください。"
	}
	o := asMap(res["order"])
	return fmt.Sprintf("いちばん新しいご注文 %s（受け取り番号 %d）の状態は「%s」です。", asStr(o["public_id"]), asInt(o["pickup_no"]), asStr(o["status_label"]))
}

// candidates は過去の注文から、「いつもの」の候補（品目の組）を、よく頼む順（同数なら新しい順）に最大 3 つ。
func candidates(orders []map[string]any) [][]map[string]any {
	type group struct {
		key     string
		recency []int
		items   []map[string]any
	}
	var groups []*group
	byKey := map[string]*group{}
	for recency, o := range orders { // orders は新しい順
		var items []map[string]any
		for _, i := range asList(o["items"]) {
			if im := asMap(i); asInt(im["qty"]) > 0 {
				items = append(items, im)
			}
		}
		if len(items) == 0 {
			continue
		}
		var kb strings.Builder
		for _, i := range items {
			fmt.Fprintf(&kb, "%s\x00%s\x00%s\x00%d\x01", asStr(i["name"]), asStr(i["size"]), asStr(i["temperature"]), asInt(i["qty"]))
		}
		g, ok := byKey[kb.String()]
		if !ok {
			g = &group{key: kb.String(), items: items}
			byKey[g.key] = g
			groups = append(groups, g)
		}
		g.recency = append(g.recency, recency)
	}
	sort.SliceStable(groups, func(i, j int) bool {
		if len(groups[i].recency) != len(groups[j].recency) {
			return len(groups[i].recency) > len(groups[j].recency)
		}
		return groups[i].recency[0] < groups[j].recency[0]
	})
	var out [][]map[string]any
	for i, g := range groups {
		if i >= 3 {
			break
		}
		out = append(out, g.items)
	}
	return out
}

func describeItems(items []map[string]any) string {
	parts := make([]string, len(items))
	for i, it := range items {
		parts[i] = fmt.Sprintf("%s × %d", labelOf(asStr(it["name"]), it), asInt(it["qty"]))
	}
	return strings.Join(parts, "、")
}

func ordersOf(res map[string]any) []map[string]any {
	if !isOK(res) {
		return nil
	}
	var out []map[string]any
	for _, o := range asList(res["orders"]) {
		out = append(out, asMap(o))
	}
	return out
}

func scriptRepeat(rt *scriptRT) string {
	res := rt.callTool("list_my_orders", omap{{"limit", 5}})
	cands := candidates(ordersOf(res))
	if len(cands) == 0 {
		return "ご注文の履歴が見つかりませんでした。品名・サイズ・温度・数量をお知らせください。"
	}
	lines := make([]string, len(cands))
	for i, items := range cands {
		lines[i] = fmt.Sprintf("%d. %s", i+1, describeItems(items))
	}
	return repeatMark + "。番号でお選びください。\n" + strings.Join(lines, "\n")
}

var pickDigitRe = regexp.MustCompile(`(\d|[一二三])`)

func scriptRepeatPick(rt *scriptRT) string {
	pick := 1
	if m := pickDigitRe.FindString(rt.view.text); m != "" {
		if n, err := strconv.Atoi(m); err == nil {
			pick = n
		} else {
			pick = jpNum[m]
		}
	}
	res := rt.callTool("list_my_orders", omap{{"limit", 5}})
	cands := candidates(ordersOf(res))
	if pick < 1 || pick > len(cands) {
		return "その番号の候補はありません。もう一度「いつもの」とお伝えください。"
	}
	chosen := cands[pick-1]
	var applied, problems []string
	var lastCart map[string]any
	for i, it := range chosen {
		if i >= mockMaxWrites {
			break
		}
		found := rt.callTool("search_menu", omap{{"query", asStr(it["name"])}})
		var named []map[string]any
		for _, x := range itemsOf(found) {
			if asStr(x["match"]) == "name" {
				named = append(named, x)
			}
		}
		var variant map[string]any
		if len(named) > 0 {
			for _, v := range asList(named[0]["variants"]) {
				vm := asMap(v)
				if asStr(vm["size"]) == asStr(it["size"]) && asStr(vm["temperature"]) == asStr(it["temperature"]) {
					variant = vm
					break
				}
			}
		}
		if variant == nil || !asBool(variant["available"]) {
			problems = append(problems, fmt.Sprintf("%sは、いま出せません。", labelOf(asStr(it["name"]), it)))
			continue
		}
		res := rt.callTool("set_cart_item", omap{{"variant_id", asInt(variant["variant_id"])}, {"qty", asInt(it["qty"])}})
		if isOK(res) {
			lastCart = asMap(res["cart"])
			applied = append(applied, fmt.Sprintf("%sを %d 点", labelOf(asStr(it["name"]), it), asInt(it["qty"])))
		} else {
			problems = append(problems, fmt.Sprintf("%sをカートに入れられませんでした。", asStr(it["name"])))
		}
	}
	if len(chosen) > mockMaxWrites {
		problems = append(problems, "一度に変更できるのは 3 品までです。残りは、続けてお知らせください。")
	}
	var parts []string
	if len(applied) > 0 {
		parts = append(parts, strings.Join(applied, "、")+"、カートに入れました。")
		if lastCart != nil {
			parts = append(parts, fmt.Sprintf("カートの合計は %d ルミです。", asInt(lastCart["total_lumi"])))
		}
		parts = append(parts, sayConfirmHint)
	}
	out := strings.Join(append(parts, problems...), "")
	if out == "" {
		return sayUnknown
	}
	return out
}

func questionCore(text string) string {
	core := questionWords.ReplaceAllString(text, " ")
	return stripEdges(reWS.ReplaceAllString(politeRe.ReplaceAllString(core, " "), ""))
}

func scriptAllergy(rt *scriptRT) string {
	core := questionCore(allergenWordRe.ReplaceAllString(rt.view.text, " "))
	if core == "" {
		return "どの商品についてのご質問か、品名をお知らせください。"
	}
	res := rt.callTool("search_menu", omap{{"query", core}})
	items := onlyNameMatches(itemsOf(res))
	if len(items) == 0 {
		return fmt.Sprintf("「%s」は、メニューで見つかりませんでした。品名をご確認ください。", core)
	}
	var b strings.Builder
	for i, item := range items {
		if i >= 3 {
			break
		}
		var reg []string
		for _, a := range asList(item["allergens_registered"]) {
			reg = append(reg, asStr(a))
		}
		if len(reg) > 0 {
			fmt.Fprintf(&b, "%sに登録されているアレルゲンは、%sです。", asStr(item["name"]), strings.Join(reg, "・"))
		} else {
			fmt.Fprintf(&b, "%sには、アレルゲンの登録がありません。", asStr(item["name"]))
		}
	}
	return b.String() + sayAllergyClosing
}

func scriptMenu(rt *scriptRT) string {
	core := questionCore(rt.view.text)
	args := omap{{"query", core}}
	if core == "" {
		category := ""
		switch {
		case categoryDrink.MatchString(rt.view.text):
			category = "drink"
		case categoryFood.MatchString(rt.view.text):
			category = "food"
		case strings.Contains(rt.view.text, "豆"):
			category = "beans"
		}
		args = omap{{"query", ""}}
		if category != "" {
			args = omap{{"query", ""}, {"filters", omap{{"category", category}}}}
		}
	}
	res := rt.callTool("search_menu", args)
	items := onlyNameMatches(itemsOf(res))
	if len(items) == 0 {
		return "お探しの品は、メニューで見つかりませんでした。"
	}
	shown := items
	if len(shown) > 5 {
		shown = shown[:5]
	}
	lines := make([]string, len(shown))
	for i, it := range shown {
		lines[i] = itemLine(it)
	}
	more := ""
	if len(items) > len(shown) {
		more = "\nほかにも品があります。カードをご覧ください。"
	}
	return strings.Join(lines, "\n") + more
}

func scriptDelivery(rt *scriptRT) string {
	rt.callTool("set_fulfillment", omap{{"kind", "delivery"}})
	rt.callTool("check_slots", omap{{"date", dateOf(localNow()).String()}})
	return sayDelivery
}

func scriptPickup(rt *scriptRT) string {
	res := rt.callTool("set_fulfillment", omap{{"kind", "pickup"}})
	if isOK(res) {
		return sayPickup
	}
	return "受け取り方法を変えられませんでした。しばらくしてから、もう一度お試しください。"
}

var mockScripts = map[string]func(rt *scriptRT) string{
	"greeting":            func(*scriptRT) string { return sayGreeting },
	"refuse_account":      func(*scriptRT) string { return sayRefuseAccount },
	"refuse_order_change": func(*scriptRT) string { return sayRefuseOrderChange },
	"ack":                 func(*scriptRT) string { return sayAck },
	"order":               scriptOrder,
	"cancel":              scriptCancel,
	"confirm":             scriptConfirm,
	"status":              scriptStatus,
	"repeat":              scriptRepeat,
	"repeat_pick":         scriptRepeatPick,
	"allergy":             scriptAllergy,
	"menu":                scriptMenu,
	"delivery":            scriptDelivery,
	"pickup":              scriptPickup,
}

// mockChatModel は決定的な規則ベースの chatModel。
type mockChatModel struct{}

func (mockChatModel) reply(messages []chatMessage, tools []toolSpec) (out modelReply) {
	view := parseMock(messages)
	rt := &scriptRT{view: view}
	say := func(s string) modelReply { return modelReply{text: &s} }
	defer func() {
		switch x := recover().(type) {
		case nil:
		case needCall:
			out = modelReply{toolCalls: []toolCall{{id: fmt.Sprintf("mock-%d", len(view.results)+1), name: x.name, args: x.args}}}
		case replayMismatch:
			out = say(failureReply) // 再生がずれた（起きない想定）
		default:
			panic(x)
		}
	}()
	script, ok := mockScripts[mockIntent(view)]
	if !ok {
		script = func(*scriptRT) string { return sayUnknown }
	}
	text := script(rt)
	if rt.idx < len(view.results) {
		return say(failureReply) // 台本の呼び出しより、済んだ結果の方が多い
	}
	return say(text)
}
