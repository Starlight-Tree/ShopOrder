#!/usr/bin/env bash
# Python と Node の版が、各ファイルで揃っているかを確かめる。基準は .python-version と .node-version。
#
#   scripts/check-versions.sh
#
# 見るもの:
#   Python  backend/Dockerfile の FROM python:<版>-slim、開発コンテナの feature（.devcontainer/devcontainer.json）、CI の python-version-file、CLAUDE.md の記述
#   Node    docker-compose.yml の frontend の image node:<版>-slim、開発コンテナの feature、frontend/package.json の engines、CI の node-version-file、CLAUDE.md の記述
# 終了コード: 0 = 揃っている、1 = 食い違いあり。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

py="$(tr -d '[:space:]' <.python-version)"
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

check "Python $py: backend/Dockerfile" backend/Dockerfile "FROM python:${py}-slim"
check "Python $py: 開発コンテナの feature" .devcontainer/devcontainer.json "features/python:1\": { \"version\": \"${py}\" }"
check "Python $py: CI が .python-version を読む" .github/workflows/ci.yml "python-version-file: .python-version"
check "Python $py: CLAUDE.md" CLAUDE.md "Python ${py}"

check "Node $node: docker-compose.yml の frontend" docker-compose.yml "image: node:${node}-slim"
check "Node $node: 開発コンテナの feature" .devcontainer/devcontainer.json "features/node:2\": { \"version\": \"${node}\" }"
check "Node $node: frontend/package.json の engines" frontend/package.json "^${node}.0.0"
check "Node $node: CI が .node-version を読む" .github/workflows/ci.yml "node-version-file: .node-version"
check "Node $node: CLAUDE.md" CLAUDE.md "Node ${node}"

# CI に版の数字を直接書かない（書くと、このスクリプトが見ない場所で食い違う）
if grep -nE '^\s*(python|node)-version:' .github/workflows/ci.yml >/dev/null; then
  expect "CI に python-version / node-version の直書きがある（*-version-file にする）" 1
else
  expect "CI に版の直書きが無い" 0
fi

exit "$status"
