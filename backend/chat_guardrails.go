package main

// ルールベースの入出力ガード（backend/app/chat/guardrails.py の移植）。LLM を使わない純粋関数だけ。模擬モデルでも実モデルでも同じに動き、テストが決定的になる。
// パターン照合は「典型的な手口を安く弾く」ためで、プロンプトとツールの設計（確定のツールが無いこと）の代わりにはならない。
// **守りの本体は、確定のツールを渡さないこと**で、ここは文面の事故を減らす層。
//   - 入力: 指示の上書き・プロンプトの開示・役の乗っ取り・テンプレートの偽装・内部のツール名の指定（checkInput）
//   - ツール結果: 商品名・説明などの文字列は、信頼できないデータ。長さを切り、指示に見える文は伏せ、包みの記号を壊す（scrubUntrusted）
//   - 出力: ①確定を言い切る文 ②ツール結果に無い価格・合計 ③アレルギーで、データに無いことを言い切る文 ④プロンプトの漏洩、を、固定の文に置き換える（checkOutput）
// Python の re の先読みは使っていないので、そのまま RE2（Go の regexp）に移せる。

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// 拒否・置き換えの理由コード（ログ・監査用。利用者には返さない）
const (
	reasonOverride     = "instruction_override"
	reasonDisclosure   = "prompt_disclosure"
	reasonRoleHijack   = "role_hijack"
	reasonTemplate     = "template_injection"
	reasonToolName     = "tool_name"
	reasonConfirmClaim = "confirmation_claim"
	reasonPrice        = "price_not_in_tool_result"
	reasonAllergy      = "allergy_negative_claim"
	reasonLeak         = "prompt_leak"
)

// 固定の文（理由を細かく伝えると回避の手がかりになるため、いつも同じ文）
const (
	inputRefusalReply    = "申し訳ありませんが、そのご依頼にはお応えできません。ご注文や商品についてお知らせください。"
	redactedUserText     = "（この発言は安全上の理由により履歴から除外されました）"
	claimFallback        = "注文の確定は、確認カードの確定ボタンを押したときだけ行われます。チャットの返事では、注文は確定されていません。"
	priceFallback        = "金額は、カードに表示されている値が正です。お手数ですが、カードの内容をご確認ください。"
	allergyFallback      = "アレルギーについては、登録されているデータの範囲でしかお答えできません。データに無いことを、私から言い切ることはできませんので、店舗のスタッフへご確認ください。"
	leakFallback         = "申し訳ありませんが、この回答は内容を確認できないためお出しできません。別の聞き方でお知らせください。"
	failureReply         = "申し訳ありません。うまく処理できませんでした。しばらくしてから、もう一度お試しください。"
	limitReply           = "一度に処理できる量を超えたため、ここで止めました。内容を分けて、もう一度お知らせください。"
	emptyReply           = "うまく聞き取れませんでした。ご注文の品・サイズ・温度・数量をお知らせください。"
	untrustedPlaceholder = "（内容を省略しました）"
)

var fallbacks = map[string]string{
	reasonConfirmClaim: claimFallback,
	reasonPrice:        priceFallback,
	reasonAllergy:      allergyFallback,
	reasonLeak:         leakFallback,
}

// kataToHira はカタカナ（U+30A1〜U+30F6）をひらがなにする。表記ゆれ（システム / しすてむ）を同一視するために使う。
func kataToHira(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0x30A1 && r < 0x30F7 {
			return r - 0x60
		}
		return r
	}, s)
}

var folder = cases.Fold()

// normalizeGuard は NFKC（全角半角・合字の統一）、不可視文字の除去、小文字化、かな統一を行う。
func normalizeGuard(text string) string {
	nfkc := norm.NFKC.String(text)
	visible := strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) { // ゼロ幅スペースなどを挟んだ回避を防ぐ
			return -1
		}
		return r
	}, nfkc)
	return kataToHira(folder.String(visible))
}

// isZPSCM は Unicode の一般カテゴリの先頭が Z・P・S・C・M のどれか。
func isZPSCM(r rune) bool {
	return unicode.In(r, unicode.Z, unicode.P, unicode.S, unicode.C, unicode.M)
}

// squash は空白・句読点・記号・結合文字を全て除く。「i.g n-o r e」型の挿入回避に耐えるため。
func squash(normalized string) string {
	return strings.Map(func(r rune) rune {
		if isZPSCM(r) {
			return -1
		}
		return r
	}, normalized)
}

func compileGuard(pattern string) *regexp.Regexp {
	return regexp.MustCompile("(?m)" + kataToHira(pattern))
}

// near は a と b が window 文字以内に（どちらの順でも）現れるパターン。量指定子は上限付き。
func near(a, b string, window int) string {
	w := strconv.Itoa(window)
	return "(?:" + a + ".{0," + w + "}?" + b + "|" + b + ".{0," + w + "}?" + a + ")"
}

// ---- 入力のルール（日本語と英語）----
const (
	jaOverridePrefix = `(?:以前|これまで|それまで|今まで|先ほど|さっき|上記|前述|前回|前|あなた(?:の|への|に与えられた)|初期|デフォルト)の?`
	jaOverrideTarget = `(?:指示|命令|ルール|制約|制限|設定|プロンプト|指令|会話|やり取り|やりとり|内容|入力|条件|ガイドライン|方針|役割)`
	// 「取り消す・キャンセル・リセット」は入れない（注文では「さっきの内容をキャンセルして」が、カートをやめる普通の頼みになる。ツールが無いので害は無い）
	jaDiscard    = `(?:(?:無視|破棄|無効|解除|上書き)(?:して|しろ|せよ|しなさい|に)|忘れ(?:て|ろ|よ|なさい))`
	jaRoleEnd    = `(?:です|だ(?:よ|ぞ|ね)?$|である|になりきっ|になって|になる|を演じ|のふり|と名乗|と呼ばれ|として扱|として(?:振る舞|ふるまう|ふるまっ|行動|答え|回答|返答|話し|喋|応答|対応))`
	jaNow        = `(?:今|いま|これ|今後|今日|今度|これ以降|以後|以降)`
	jaYou        = `(?:あなた|君|きみ|お前|おまえ|貴方|そなた)`
	jaPromptNoun = `(?:システム(?:プロンプト|メッセージ|指示|命令)|初期(?:プロンプト|指示)|内部(?:プロンプト|指示|命令|ルール)|隠し(?:プロンプト|指示|命令)` +
		`|あなた(?:の|への|に与えられた|が与えられた)(?:プロンプト|指示|命令|ルール|設定|制約|プログラム|ガイドライン)` +
		`|開発者(?:の|からの)(?:指示|命令|プロンプト|メッセージ)|プロンプト)`
	jaDiscloseVerb = `(?:教えて|おしえて|教示|見せて|みせて|見たい|知りたい|表示|出力|開示|公開|暴露|漏ら|漏洩|言って|いって|答えて|こたえて|書いて|かいて` +
		`|書き出|コピー|貼って|貼り付|晒|さらし|そのまま|全文|列挙|復唱|繰り返|くりかえ|読み上げ|提示|共有|翻訳|要約|言い換|変更|書き換|上書き|更新|差し替|置き換)`
	enOverrideVerb = `(?:ignore|disregard|forget|override|bypass|discard)`
	enOverrideMod  = `(?:all|any|every|the|your|my|these|those|of|everything|anything|previous|prior|above|earlier|preceding` +
		`|former|original|initial|system|safety|existing|current|given|other)`
	enOverrideNoun = `(?:instructions?|prompts?|rules?|directions?|directives?|guidelines?|context|messages?|commands?|constraints?|restrictions?|programming|training|said|told)`
	enPromptNoun   = `(?:system(?:prompt|message|instructions?|directives?)` +
		`|your(?:system|initial|original|hidden|secret|internal|core|underlying)?(?:prompt|instructions?|rules|guidelines|directives?|programming|configuration|settings|preamble|setup)` +
		`|developermessage)`
	enDiscloseVerb = `(?:reveal|show|print|display|repeat|output|tell|give|share|leak|dump|expose|disclose|recite|paste|copy|write|echo|send|provide|list|read|quote` +
		`|translate|summari[sz]e|paraphrase|encode|decode|whatis|whatare|whats|whatwas|whatwere|spell|extract|retrieve|verbatim|wordforword|reproduce|outline|describe|explain)`
	// 内部のツール名（確定・決済・個人情報の変更）を指定して呼ばせようとする入力。これらのツールは存在しないが、試みとして拒否する
	toolNamePattern = `(?:place_?order|confirm_?order|submit_?order|execute_?payment|process_?payment|charge_?card|refund_?order|update_?address|change_?address` +
		`|delete_?account|set_?price|apply_?discount|checkout_?confirm)`
)

type guardRule struct {
	reason string
	re     *regexp.Regexp
}

var squashedRules = func() []guardRule {
	var rules []guardRule
	add := func(reason string, patterns ...string) {
		for _, p := range patterns {
			rules = append(rules, guardRule{reason, compileGuard(p)})
		}
	}
	add(reasonOverride,
		jaOverridePrefix+jaOverrideTarget+`(?:を|は|も)?(?:すべて|全て|全部|一切|いったん|一旦)?`+jaDiscard,
		`(?:指示|命令|ルール|制約|制限|プロンプト|設定)(?:を|は|も)(?:すべて|全て|全部|一切)`+jaDiscard,
		`新しい(?:指示|命令|プロンプト)`,
		`(?:制限|規制|フィルター|ガードレール|検閲)(?:を|は)?(?:すべて|全て|全部)?(?:解除|外し|無視|無効|取り払|撤廃)(?:して|しろ|せよ|してください|してくれ|なさい)`,
		enOverrideVerb+enOverrideMod+`{1,6}`+enOverrideNoun,
		`(?:ignore|disregard|forget)(?:everything|anything|all)(?:above|before|previously|prior|youweretold|youknow)`,
		`(?:overwrite|override|replace|update|change|modify)(?:your|the|all)(?:system|original|initial|previous)?(?:instructions?|prompt|rules|programming|directives?)`,
		`new(?:system)?(?:instructions?|directives?|prompt)`,
	)
	add(reasonDisclosure,
		near(jaPromptNoun, jaDiscloseVerb, 20),
		near(enPromptNoun, enDiscloseVerb, 20),
		`(?:repeat|print|output|recite|echo|copy|write|say|show)(?:out|back)?(?:everything|all|the(?:words|text|content|message|conversation|sentences?))(?:above|before|prior|sofar)`,
		`startingwith(?:the)?(?:words?)?youare`,
	)
	add(reasonRoleHijack,
		`あなた(?:は|が|には)`+jaNow+`(?:から|より|は).{0,40}?`+jaRoleEnd,
		jaNow+`(?:から|より)(?:は)?`+jaYou+`(?:は|が|には).{0,40}?`+jaRoleEnd,
		`脱獄|ジェイルブレイク|開発者モード|デベロッパーモード|管理者モード`,
		`youarenow(?:a|an|the|my|in|free|unrestricted|no|called|named|dan|going|acting|playing|operating)`,
		`youarenolonger`,
		`(?:fromnow(?:on(?:wards?)?)?|fromthis(?:point|moment)on(?:wards?)?|startingnow)(?:you(?:are|re|will|shall|must|should|can|may)|act|behave|respond|answer|pretend|ignore|play|roleplay)`,
		`pretend(?:to|that|you|youre)`,
		`(?:actas|behaveas)(?:if|though|a|an|my)|playtheroleof|roleplayas`,
		`doanythingnow|jailbreak|(?:dan|dev|developer|god|sudo|admin|unrestricted|unfiltered)mode`,
	)
	add(reasonToolName, toolNamePattern)
	return rules
}()

// 句読点などを保ったまま（normalizeGuard 後）照合するルール。チャットテンプレートの偽装など
var templateRules = func() []guardRule {
	var rules []guardRule
	for _, p := range []string{
		`<\|[a-z0-9_]{2,24}\|>`,
		`\[/?(?:inst|sys|system)\]|<</?sys>>`,
		`^[ \t]*(?:system|assistant|developer|tool|システム|アシスタント|開発者)[ \t]*:`,
	} {
		rules = append(rules, guardRule{reasonTemplate, compileGuard(p)})
	}
	return rules
}()

// ツール結果（商品名・説明など）の中の、指示に見える文。入力のルールに加えて、注文・ツールに特有の言い回しを伏せる
var dataRules = func() []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, p := range []string{
		`(?:注文|決済|支払い|お支払い|購入|会計)(?:を)?(?:確定|実行|完了|成立)?(?:して|しろ|せよ|しなさい|してください|させて)`,
		`(?:ツール|関数|function|tool)(?:を)?(?:呼|実行|使)`,
		`(?:回答|返答|答え|応答)(?:は|を)?.{0,12}?(?:にして|として|と答えて|と言って|とだけ)`,
		`(?:ユーザー|お客様|顧客)(?:に|へ)(?:は)?.{0,12}?(?:伝えて|言って|答えて|知らせて|表示して)`,
		`(?:無料|ただ|0ルミ|ゼロ)(?:に|で)(?:して|しろ|せよ)`,
		`(?:カート|品|商品)(?:を)?(?:空|全部|すべて|全て).{0,6}?(?:して|しろ|せよ)`,
	} {
		out = append(out, compileGuard(p))
	}
	return out
}()

// checkInput は利用者の入力が拒否対象なら理由コードを、通過なら空文字を返す。
func checkInput(text string) string {
	normalized := normalizeGuard(text)
	for _, r := range templateRules {
		if r.re.MatchString(normalized) {
			return r.reason
		}
	}
	squashed := squash(normalized)
	for _, r := range squashedRules {
		if r.re.MatchString(squashed) {
			return r.reason
		}
	}
	return ""
}

// ---- ツール結果（信頼できないデータ）----

// scrubUntrusted はツール結果の文字列（商品名・説明など）を、モデルに見せられる形にする。
// ① 制御文字を空白にして長さを切る ② 指示に見える文が入っていれば、全体を伏せる ③ 包みの記号 [ ] を全角にして、データの中に「データの終わり」を作れないようにする。
func scrubUntrusted(text string, limit int) string {
	if limit <= 0 {
		limit = toolTextMaxChars
	}
	cleaned := pyStrip(strings.Map(func(r rune) rune {
		if unicode.Is(unicode.C, r) {
			return ' '
		}
		return r
	}, text))
	squashed := squash(normalizeGuard(cleaned))
	hit := checkInput(cleaned) != ""
	if !hit {
		for _, p := range dataRules {
			if p.MatchString(squashed) {
				hit = true
				break
			}
		}
	}
	if hit {
		return untrustedPlaceholder
	}
	cleaned = strings.NewReplacer("[", "［", "]", "］").Replace(cleaned)
	runes := []rune(cleaned)
	if len(runes) <= limit {
		return cleaned
	}
	return string(runes[:limit-1]) + "…"
}

// ---- 出力 ----

var claimRules = func() []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, p := range []string{
		// 注文の確定・完了を、事実として言い切る文（AI は確定できないので、どれも事実ではない）
		`(?:ご)?注文(?:を|が|は)?(?:確定|完了|成立|受理|受付)(?:しました|いたしました|致しました|されました|できました|しています|しております|済み|ずみ)`,
		`(?:ご)?注文(?:を)?(?:しました|いたしました|致しました|承りました|うけたまわりました|受け付けました|受付しました|受けつけました|通しました|通りました)`,
		`(?:確定|決済|支払い|お支払い|会計|購入|発注)(?:を|が)?(?:完了|成立|済み|済ませ|させ)`,
		`(?:確定|決済|お?支払い|購入|発注|手配|予約|注文)(?:を)?(?:しました|いたしました|致しました|してあります|しておきました|済ませました)`,
		// 「確定します」「決済いたします」: AI が確定できるかのような言い方
		`(?:確定|決済|お?支払い|購入|発注)(?:を|は)?(?:します|いたします|致します|行います|おこないます|させていただきます)`,
		`ご注文(?:を)?(?:ありがとうございました|いただきました|頂きました)`,
		`orders?(?:hasbeen|is|was|has)?(?:placed|confirmed|complete|completed|submitted|finalized)`,
		`(?:i|ive|ihave|ivejust|ihavejust)?(?:placed|confirmed|submitted|finalized)(?:your|the)order`,
		`payment(?:was|is|has)?(?:successful|completed|processed|made)`,
	} {
		out = append(out, compileGuard(p))
	}
	return out
}()

var allergyContext = compileGuard(`アレルギー|アレルゲン|乳|卵|小麦|くるみ|ナッツ|そば|蕎麦|えび|海老|かに|蟹|落花生|ピーナッツ|大豆|ごま|胡麻|グルテン|ラクトース|乳糖|原材料|成分|添加物`)

var allergyNegative = func() []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, p := range []string{
		`(?:含まれ|入っ|使われ|使っ|使用され|使用し|含ん|含有し)(?:て)?(?:い)?(?:ません|ない|おりません)`,
		`含みません|含まない|含有しません`,
		`アレルゲン(?:は|が)?(?:ありません|ない|なし|ゼロ|フリー|不使用)`,
		`アレルギー(?:フリー|対応済み)|ノンアレルゲン`,
		`アレルギー(?:の方|のある方)?(?:も|でも|の方も)(?:大丈夫|問題ありません|安心|召し上がれ|お召し上がり|お飲み)`,
		`安心して(?:お召し上がり|召し上がっ|お飲み|ご利用|お楽しみ)`,
	} {
		out = append(out, compileGuard(p))
	}
	return out
}()

// 同じ文に、言い切らない言い方（できない・かどうか）があれば、言い切りではない
var allergyHedge = compileGuard(`言い切れ|限りません|断言|断定|確認できません|分かりません|わかりません|かどうか|ご確認ください|スタッフへ`)

var (
	priceUnit    = regexp.MustCompile(`(\d[\d,]*)\s*(ルミ|円)`)
	priceYenSign = regexp.MustCompile(`[¥￥]\s*(\d[\d,]*)`)
	priceLabel   = regexp.MustCompile(`(?:合計|小計|総額|お会計|代金|料金|価格|値段|金額|送料)[^\d。\n]{0,6}?(\d[\d,]*)`)
)

// numbersIn はツール結果（map・配列・数値）に出てくる整数を全部集める（価格・合計の検査の「許す値」）。真偽値は数えない。
func numbersIn(value any) map[int64]bool {
	found := map[int64]bool{}
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case bool:
		case int:
			found[int64(x)] = true
		case int64:
			found[x] = true
		case json.Number:
			if n, err := strconv.ParseInt(string(x), 10, 64); err == nil {
				found[n] = true
			}
		case map[string]any:
			for _, e := range x {
				walk(e)
			}
		case []any:
			for _, e := range x {
				walk(e)
			}
		}
	}
	walk(value)
	return found
}

func parseCommaInt(s string) (int64, bool) {
	n, err := strconv.ParseInt(strings.ReplaceAll(s, ",", ""), 10, 64)
	return n, err == nil
}

func priceViolation(text string, allowed map[int64]bool) bool {
	normalized := norm.NFKC.String(text)
	for _, m := range priceUnit.FindAllStringSubmatch(normalized, -1) {
		if m[2] == "円" {
			return true
		}
		if n, ok := parseCommaInt(m[1]); !ok || !allowed[n] {
			return true
		}
	}
	for _, re := range []*regexp.Regexp{priceYenSign, priceLabel} {
		for _, m := range re.FindAllStringSubmatch(normalized, -1) {
			if n, ok := parseCommaInt(m[1]); !ok || !allowed[n] {
				return true
			}
		}
	}
	return false
}

var sentenceSplit = regexp.MustCompile(`[。！？!?\n]`)

func allergyViolation(text string) bool {
	for _, sentence := range sentenceSplit.Split(norm.NFKC.String(text), -1) {
		if sentence == "" {
			continue
		}
		squashed := squash(normalizeGuard(sentence))
		if !allergyContext.MatchString(squashed) || allergyHedge.MatchString(squashed) {
			continue
		}
		for _, p := range allergyNegative {
			if p.MatchString(squashed) {
				return true
			}
		}
	}
	return false
}

// leaksSecret は text が secret（システムプロンプト）をほぼそのまま含んでいるか。空白や記号の違いを無視した最長共通部分文字列で判定する。
func leaksSecret(text, secret string, minRun int) bool {
	reply := []rune(squash(normalizeGuard(text)))
	target := []rune(squash(normalizeGuard(secret)))
	if len(reply) == 0 || len(target) == 0 {
		return false
	}
	need := minRun
	if len(target) < need {
		need = len(target)
	}
	return longestCommonRun(reply, target) >= need
}

// longestCommonRun は 2 つの文字列の最長共通部分文字列の長さ（difflib の find_longest_match の size と同じ）。
func longestCommonRun(a, b []rune) int {
	best := 0
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			if a[i-1] == b[j-1] {
				cur[j] = prev[j-1] + 1
				if cur[j] > best {
					best = cur[j]
				}
			} else {
				cur[j] = 0
			}
		}
		prev, cur = cur, prev
	}
	return best
}

type outputVerdict struct {
	text   string // 利用者へ出す本文（問題があれば固定の文）
	reason string // 置き換えた理由のコード（問題が無ければ空）
}

// checkOutput はモデルの本文を検査する。①確定の言い切り ②ツール結果に無い価格・合計 ③アレルギーの言い切り ④プロンプトの漏洩。1 つでも当たれば、固定の文に置き換える。
func checkOutput(text string, allowed map[int64]bool, secret string) outputVerdict {
	squashed := squash(normalizeGuard(text))
	for _, p := range claimRules {
		if p.MatchString(squashed) {
			return outputVerdict{fallbacks[reasonConfirmClaim], reasonConfirmClaim}
		}
	}
	if priceViolation(text, allowed) {
		return outputVerdict{fallbacks[reasonPrice], reasonPrice}
	}
	if allergyViolation(text) {
		return outputVerdict{fallbacks[reasonAllergy], reasonAllergy}
	}
	if secret != "" && leaksSecret(text, secret, 24) {
		return outputVerdict{fallbacks[reasonLeak], reasonLeak}
	}
	return outputVerdict{text, ""}
}
