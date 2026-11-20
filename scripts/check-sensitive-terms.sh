#!/usr/bin/env bash
# コミットに入れたくない固定の文字列（実プロジェクト ID、プロジェクト番号など）が、追加行に無いかを調べる。
# push protection や一般的な秘密スキャンは、認証情報の形をしたものしか見ない。プロジェクト ID は対象外なので、
# 自分で決めた語を機械的に検査する層として使う。
#
# 検索語そのものはリポジトリに置かない（置くと、その文字列をコミットに載せてしまう）。次のどちらかで渡す。
#   .git/sensitive-terms     1 行 1 語。# 以降はコメント、空行は無視。大文字小文字は区別しない。Git の管理外
#   環境変数 SENSITIVE_TERMS  改行区切り。CI ではリポジトリの Secret に入れる（ログではマスクされる）
#
#   ./scripts/check-sensitive-terms.sh              # ステージ済みの追加行（pre-commit 向け）
#   ./scripts/check-sensitive-terms.sh A..B         # コミット範囲の追加行（pre-push 向け。例 origin/main..HEAD）
#   ./scripts/check-sensitive-terms.sh --tracked    # 追跡中のファイルの現在の内容（CI 向け・棚卸し）
#   ./scripts/check-sensitive-terms.sh --history    # 全ブランチの全履歴の追加行（定期の棚卸し）
#
# 一致した語は表示しない（ログに残さないため）。ファイル名と行番号、検索語の番号だけを出す。
# 終了コード: 0 = 一致なし、1 = 一致あり、2 = 使い方の誤り。検索語が 1 つも無いときは警告を出して 0 で終わる
# （何も検査していない。CI で使うときは SENSITIVE_TERMS が渡っているか確認する）。
#
# pre-commit に組み込む例（.git/hooks は Git の管理外なので、clone し直したら入れ直す）:
#   printf '#!/bin/sh\nexec scripts/check-sensitive-terms.sh\n' > .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
# 一時的に外すなら git commit --no-verify（ただし、その場合は push 前に範囲指定で必ず検査する）。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

mode="staged"
range=""
case "${1:-}" in
  "") ;;
  --tracked) mode="tracked" ;;
  --history) mode="history" ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "$0" | sed '$d'
    exit 0
    ;;
  -*)
    echo "使い方: $0 [A..B | --tracked | --history]" >&2
    exit 2
    ;;
  *)
    mode="range"
    range="$1"
    ;;
esac

terms_file="$(mktemp)"
trap 'rm -f "$terms_file"' EXIT

# 標準入力の各行から、# 以降と前後の空白（CR を含む）を落とし、空行を捨てて検索語の一覧に足す。
add_terms() {
  sed -e 's/#.*$//' -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | { grep -v '^$' || true; } >>"$terms_file"
}

local_file="$(git rev-parse --git-common-dir)/sensitive-terms"
if [[ -f "$local_file" ]]; then
  add_terms <"$local_file"
fi
if [[ -n "${SENSITIVE_TERMS:-}" ]]; then
  printf '%s\n' "$SENSITIVE_TERMS" | add_terms
fi

if [[ ! -s "$terms_file" ]]; then
  echo "警告: 検索語が無いので、何も検査していません（.git/sensitive-terms か環境変数 SENSITIVE_TERMS）。" >&2
  exit 0
fi

# 追加行（+）だけを見る。diff を 1 本読み、ファイル名と、新しい側の行番号を数えながら、検索語を含む行を報告する。
scan_diff() {
  awk -v termsfile="$terms_file" '
    BEGIN {
      while ((getline t < termsfile) > 0) terms[++n] = tolower(t)
    }
    /^diff --git / { header = 1; next }
    header && /^\+\+\+ / { file = ($0 == "+++ /dev/null") ? "" : substr($0, 7); next }
    /^@@ / {
      header = 0
      match($0, /\+[0-9]+/)
      line = substr($0, RSTART + 1, RLENGTH - 1) - 1
      next
    }
    header { next }
    /^\+/ {
      line++
      low = tolower($0)
      for (i = 1; i <= n; i++) {
        if (index(low, terms[i])) printf "%s:%d: 検索語 #%d に一致\n", file, line, i
      }
      next
    }
  '
}

hits=""
case "$mode" in
  staged)
    hits="$(git diff --cached -U0 --no-color --no-ext-diff | scan_diff)"
    ;;
  range)
    hits="$(git log -p --format= -U0 --no-color --no-ext-diff "$range" -- | scan_diff)"
    ;;
  history)
    hits="$(git log --all -p --format= -U0 --no-color --no-ext-diff | scan_diff)"
    ;;
  tracked)
    i=0
    while IFS= read -r term; do
      i=$((i + 1))
      found="$(git grep -n -I -i -F -e "$term" -- . | awk -F: -v n="$i" '{ printf "%s:%s: 検索語 #%d に一致\n", $1, $2, n }' || true)"
      if [[ -n "$found" ]]; then
        hits+="${found}"$'\n'
      fi
    done <"$terms_file"
    ;;
esac

if [[ -n "$hits" ]]; then
  printf '%s\n' "$hits"
  echo "追加行（または追跡中のファイル）に、登録した検索語が入っています（語は表示しません）。" >&2
  echo "実際の値を、PROJECT_ID などのプレースホルダに置き換えてください。" >&2
  exit 1
fi
