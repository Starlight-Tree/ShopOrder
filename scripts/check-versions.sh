#!/usr/bin/env bash
# Go と Node の版が、各ファイルで揃っているかを確かめる。基準は backend/go.mod の go 行と .node-version。
#
#   scripts/check-versions.sh
#
# 見るもの:
#   Go    backend/Dockerfile の FROM golang:<版>、CI の go-version-file、CLAUDE.md の記述
#   Node  docker-compose.yml の frontend の image node:<版>-slim、開発コンテナの feature（.devcontainer/devcontainer.json）、frontend/package.json の engines、CI の node-version-file、CLAUDE.md の記述
# 終了コード: 0 = 揃っている、1 = 食い違いあり。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

go="$(awk '/^go [0-9]/ {print $2; exit}' backend/go.mod)"
node="$(tr -d '[:space:]' <.node-version)"
status=0

expect() { # 説明, 見つかったか(0/1)
  if [[ "$2" -eq 0 ]]; then
    printf 'ok    %s\n' "$1"
  else
    printf 'ずれ  %s\n' "$1" >&2
    status=1
  fi
}

check() { # 説明, ファイル, 固定文字列
  if grep -qF -- "$3" "$2"; then expect "$1" 0; else expect "$1（$2 に「$3」が無い）" 1; fi
}

check "Go $go: backend/Dockerfile" backend/Dockerfile "FROM golang:${go} "
check "Go $go: CI が backend/go.mod を読む" .github/workflows/ci.yml "go-version-file: backend/go.mod"
check "Go $go: CLAUDE.md" CLAUDE.md "Go ${go}"

check "Node $node: docker-compose.yml の frontend" docker-compose.yml "image: node:${node}-slim"
check "Node $node: 開発コンテナの feature" .devcontainer/devcontainer.json "features/node:2\": { \"version\": \"${node}\" }"
check "Node $node: frontend/package.json の engines" frontend/package.json "^${node}.0.0"
check "Node $node: CI が .node-version を読む" .github/workflows/ci.yml "node-version-file: .node-version"
check "Node $node: CLAUDE.md" CLAUDE.md "Node ${node}"

# CI に版の数字を直接書かない（書くと、このスクリプトが見ない場所で食い違う）
if grep -nE '^\s*(go|node)-version:' .github/workflows/ci.yml >/dev/null; then
  expect "CI に go-version / node-version の直書きがある（*-version-file にする）" 1
else
  expect "CI に版の直書きが無い" 0
fi

exit "$status"
