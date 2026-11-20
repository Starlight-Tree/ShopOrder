#!/usr/bin/env python3
"""SessionStart（resume / compact）: oasis-order の重要ルールの固定文を文脈へ入れる。

会話の再開・圧縮のあとに、CLAUDE.md の要点が抜けるのを防ぐ。決定は返さず、読み込みに失敗しても作業は止めない。
固定文だけを出す（ファイルの読み込み・外部への通信・環境変数の参照はしない）。詳細は CLAUDE.md と docs/。
"""
import json

MAX_CHARS = 1200  # 超えたら注入しない（長文の事故防止）
RULES = """【再注入: oasis-order の重要ルール】
■必ず守る
1. 世界観（店・地名・通貨ルミ・メニュー・価格）は docs/world.md が正本。資料に無い設定は「新設」と書き、資料の事実として扱わない。金額はルミの整数。
2. チャット（AI）は、人の確認なしに注文の確定・決済・個人情報の変更をしない。権限は API が毎回確認し、他人の注文は 404。
3. 頼まれた範囲だけ編集する。範囲外は提案にとどめる。未コミットの差分は、頼まれない限り触らず、コミットにも含めない。
■承認が必要（承認は、その操作だけに有効）
4. 実 API・課金（LLM・画像生成・決済の本物）、本番の DB・デプロイ: 件数・回数・概算費用を先に示す。マイグレーションの適用の前は、DB のバックアップ。
5. git push、git reset / restore、フック・権限・CLAUDE.md の変更: 差分を示してから。止められたら回避せず報告する。
■禁止
6. .env・backups/ を読まない。認証情報は、表示・記録・コミットをしない。
7. seed を本番の DB に向けない。適用済みのマイグレーションを書き換えない。DROP / TRUNCATE を足さない。git add -A / git add . は使わない（パスを指定）。
詳細は CLAUDE.md と docs/。"""


def main():
    text = RULES.strip()
    if len(text) > MAX_CHARS:
        return
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}, ensure_ascii=False))


main()
