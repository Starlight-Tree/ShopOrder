#!/usr/bin/env bash
# 検査の入口。CI（.github/workflows/ci.yml）に近い検査を、ローカルで 1 コマンドで流す（JobNavi の scripts/verify.sh を小さくしたもの）。
#
#   scripts/verify.sh [backend|frontend|lint|all]...     （引数なし = all。複数指定できる）
#
# 段（CI のジョブとの対応）:
#   backend   CI の backend ジョブ。gofmt・go vet・`go test -race -count=1 -v ./...` と、スキップが 1 件でもあれば落とす検査
#   frontend  CI の frontend ジョブ。npm test → build → typecheck（この順。typecheck は build の後）
#   lint      版の整合（scripts/check-versions.sh）と、docker-compose.yml の構文検査（.env は読まない）
#
# CI と違う点（合格しても「CI と同じ」とは言えない）:
#   - 依存の導入（npm ci）と、backend イメージのビルドはしない。Go（go.mod の版以上）と frontend/node_modules は先に用意する
#     （ホストの node_modules は Linux 用のことがある。動かなければ、スクラッチのコピーで npm ci して流す）。
#   - Postgres サーバーの版（CI は 17）は見ない。
#   - actionlint・zizmor（ワークフローの検査）は、まだ入れていない。
#
# 環境変数:
#   TEST_DATABASE_URL  backend に必須（使い捨ての Postgres 17。DROP DATABASE IF EXISTS → CREATE をするので、テスト用のサーバーに向ける）。
#                      ホストが localhost / 127.0.0.1 / ::1 でなければ流さない。使い捨てのサーバーなら、
#                      VERIFY_ALLOW_REMOTE_DB にそのホスト名を入れる（完全一致。開発コンテナは test-db。1 などの「全部許す」値は効かない）
#   GO                 go の実行ファイル（既定は PATH の go）
#
# 流せない段は「未実行」と出す。合格とは数えない。失敗しても残りの段は流し、最後にまとめて出す。
# 終了コード: 0 = すべて実行して合格 / 1 = 失敗あり / 2 = 失敗は無いが未実行がある / 64 = 引数の誤り
set -uo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

groups=()
for a in "$@"; do
  case "$a" in
    backend | frontend | lint | all) groups+=("$a") ;;
    -h | --help) sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '不明な引数: %s（backend|frontend|lint|all）\n' "$a" >&2; exit 64 ;;
  esac
done
[[ ${#groups[@]} -gt 0 ]] || groups=(all)
wants() { local g; for g in "${groups[@]}"; do [[ "$g" == all || "$g" == "$1" ]] && return 0; done; return 1; }

# 空の配列で初期化する（`declare -a` だけだと、bash 5.2 で `${#failed[@]}` が set -u に引っかかる）
passed=() failed=() skipped=()
log="$(mktemp -t shoporder-verify.XXXXXX)"
trap 'rm -f "$log"' EXIT

record() { # 段の名前, 終了コード
  if [[ "$2" -eq 0 ]]; then passed+=("$1"); else failed+=("$1"); printf -- '--- %s の出力の末尾 ---\n' "$1"; tail -n 25 "$log"; fi
}

if wants backend; then
  go_bin="${GO:-go}"
  url="${TEST_DATABASE_URL:-}"
  host="$(printf '%s' "$url" | sed -E 's#^[a-z+]+://([^@/]*@)?(\[[^]]*\]|[^:/?]*).*#\2#')"
  if [[ -z "$url" ]]; then
    skipped+=("backend: TEST_DATABASE_URL が未設定")
  elif ! command -v "$go_bin" >/dev/null 2>&1; then
    skipped+=("backend: $go_bin が無い（Go を入れる。版は backend/go.mod）")
  elif [[ "$host" != localhost && "$host" != 127.0.0.1 && "$host" != "[::1]" && ( -z "$host" || "${VERIFY_ALLOW_REMOTE_DB:-}" != "$host" ) ]]; then
    skipped+=("backend: TEST_DATABASE_URL のホストが localhost ではない（テスト用のサーバー以外へは流さない。使い捨てなら VERIFY_ALLOW_REMOTE_DB にそのホスト名を入れる）")
  else
    (
      cd backend
      unformatted="$(gofmt -l .)"
      if [[ -n "$unformatted" ]]; then printf 'gofmt で整えていないファイル:\n%s\n' "$unformatted"; exit 1; fi
      "$go_bin" vet ./... && "$go_bin" test -race -count=1 -v ./...
    ) >"$log" 2>&1
    code=$?
    if [[ $code -eq 0 ]] && grep -qE '^[[:space:]]*--- SKIP' "$log"; then
      printf 'スキップされたテストがある（DB の設定などを確かめる）\n' >>"$log"; code=1
    fi
    record backend "$code"
  fi
fi

if wants frontend; then
  # Compose の frontend は node_modules を空のフォルダーとしてホストに作る。中身（vitest）があるかで見る
  if [[ ! -x frontend/node_modules/.bin/vitest ]]; then
    skipped+=("frontend: frontend/node_modules に依存が入っていない（npm ci を、スクラッチのコピーで行う）")
  else
    ( cd frontend && CI=true npm test && npm run build && npm run typecheck ) >"$log" 2>&1
    record frontend $?
  fi
fi

if wants lint; then
  ( scripts/check-versions.sh && docker compose --env-file /dev/null config --quiet ) >"$log" 2>&1
  record lint $?
fi

printf '\n== 結果 ==\n'
for x in "${passed[@]:-}"; do [[ -n "$x" ]] && printf '合格    %s\n' "$x"; done
for x in "${failed[@]:-}"; do [[ -n "$x" ]] && printf '失敗    %s\n' "$x"; done
for x in "${skipped[@]:-}"; do [[ -n "$x" ]] && printf '未実行  %s\n' "$x"; done
[[ ${#failed[@]} -eq 0 ]] || exit 1
[[ ${#skipped[@]} -eq 0 ]] || exit 2
exit 0
