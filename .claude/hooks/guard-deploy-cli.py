#!/usr/bin/env python3
"""PreToolUse(Bash) の小さなガード: wrangler・infisical・prisma の書き込み系を、実行前に確認（ask）へ回す。

  - wrangler: 読み取り・ローカルの許可リスト（dev / whoami / types / tail / deployments list / versions list・view /
    secret list / d1 list・info・migrations list / d1 execute --local / kv key list・get / r2 bucket list / r2 object get /
    --version・--help）以外はすべて確認。deploy・secret put・delete・rollback・login なども、ここに入る。
  - infisical: 値が出る・書き込む操作（secrets の表示・set・delete・folders・export・login・init など）を確認。
    `infisical run -- <コマンド>` は、秘密が環境変数に入った状態で <コマンド> が動くため、<コマンド> を調べる。
    環境変数や値を表示しうるもの（env・printenv・cat・echo・python -c など）は確認。wrangler・prisma は、上と同じ規則で調べる。
    通常のスクリプト・モジュール（`python -m …`・`python script.py`）と `infisical --version` は確認しない。
  - prisma: migrate deploy / reset / dev / resolve、db push / execute を確認。

確認の理由には、コマンドの種類だけを出す（引数・接続文字列の値は出さない）。`bash -c` / `sh -c` の中身も同じ規則で調べる。
`deny` ではなく `ask` にしているのは、ユーザーが明示して頼んだときに実行できるようにするため（例: 検証用の画面 Worker の配備）。
guard-cloud-cli.py（gcloud・gh など）と guard-git-write.py（git・PR コメント）は別の役割で、ここは重ねない。

限界: コマンド文字列の解析なので、別名・スクリプト経由・シェルの変数展開は防げない。誤操作と、取り込んだ文書に
埋め込まれた指示への網で、完全な防御ではない（権限の deny と併用する）。
"""

from __future__ import annotations

import json
import re
import shlex
import sys

SEPARATORS = re.compile(r"&&|\|\||;|\||\n")
RUNNERS = {"npx", "pnpm", "pnpx", "bunx", "yarn", "npm", "dlx", "exec", "x", "run"}
SHELLS = {"bash", "sh", "zsh"}

# wrangler: 確認なしにしてよい（読み取り・ローカル）。サブコマンド列の先頭から一致を見る
WRANGLER_SAFE = [
    ("dev",),
    ("whoami",),
    ("types",),
    ("tail",),
    ("check",),
    ("docs",),
    ("deployments", "list"),
    ("deployments", "status"),
    ("versions", "list"),
    ("versions", "view"),
    ("secret", "list"),
    ("d1", "list"),
    ("d1", "info"),
    ("d1", "migrations", "list"),
    ("kv", "key", "list"),
    ("kv", "key", "get"),
    ("kv", "namespace", "list"),
    ("r2", "bucket", "list"),
    ("r2", "object", "get"),
]
INFISICAL_SAFE_FIRST = {"--version", "-v", "version", "--help", "-h", "help"}
# `infisical run -- <cmd>` の <cmd> が、環境変数（秘密）や値を表示・外へ出しうるもの
SECRET_DUMPERS = {
    "env", "printenv", "export", "set", "declare", "typeset", "cat", "head", "tail", "less", "more", "sed", "awk", "gawk",
    "grep", "egrep", "rg", "echo", "printf", "xargs", "tee", "od", "xxd", "hexdump", "strings", "base64", "cut", "tr",
    "sort", "jq", "find", "curl", "wget", "nc", "ncat", "ssh", "scp", "cp", "mv",
}  # fmt: skip
INLINE_CODE_FLAGS = {"-c", "-e", "-E", "-p", "-r", "--eval", "--print", "-"}
INTERPRETERS = re.compile(r"(python[0-9.]*|node|nodejs|ruby|perl|php|deno|bun|tsx)")
# 他のコマンドを包んで実行する語（`time env` のように、中身を調べずに通さない）
WRAPPERS = {"time", "nice", "nohup", "timeout", "stdbuf", "command", "builtin", "exec", "sudo", "setsid", "ionice", "caffeinate"}
# docker の操作のうち、秘密の入った環境の値を表示しうるもの（`docker compose up -d` は通す）
DOCKER_EXPOSING = {("config",), ("exec",), ("run",), ("inspect",), ("compose", "config"), ("compose", "exec"), ("compose", "run")}
PRISMA_ASK = [
    ("migrate", "deploy"),
    ("migrate", "reset"),
    ("migrate", "dev"),
    ("migrate", "resolve"),
    ("db", "push"),
    ("db", "execute"),
]

Decision = tuple[str, str]  # ("ask", 理由)


def split_outside_quotes(command: str) -> list[str]:
    """&& || ; | 改行で分ける。引用符（' "）の中は分けない（`bash -c 'env | head'` を 1 つに保つ）。"""
    parts: list[str] = []
    buf: list[str] = []
    quote = ""
    i = 0
    while i < len(command):
        ch = command[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < len(command):
                buf.append(command[i + 1])
                i += 1
            elif ch == quote:
                quote = ""
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch == "\\" and i + 1 < len(command):
            buf.append(ch)
            buf.append(command[i + 1])
            i += 1
        else:
            m = SEPARATORS.match(command, i)
            if m:
                parts.append("".join(buf))
                buf = []
                i = m.end()
                continue
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts


def segments(command: str) -> list[list[str]]:
    out: list[list[str]] = []
    for part in split_outside_quotes(command):
        try:
            tokens = shlex.split(part, posix=True)
        except ValueError:
            tokens = part.split()
        while tokens and (
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]) or tokens[0] in {"command", "env", "sudo"}
        ):
            tokens = tokens[1:]
        if tokens:
            out.append(tokens)
    return out


def positional(tokens: list[str]) -> list[str]:
    """オプション（- で始まる語）を除いた語の列。値つきオプションの値は区別しない（保守的に確認側へ倒れる）。"""
    return [t for t in tokens if not t.startswith("-")]


def match_prefix(words: list[str], prefixes: list[tuple[str, ...]]) -> bool:
    return any(tuple(words[: len(p)]) == p for p in prefixes)


def tool_and_rest(tokens: list[str]) -> tuple[str, list[str]]:
    """`npx wrangler …` / `pnpm exec wrangler …` のような実行ラッパーを外して、(ツール名, 残りの引数) を返す。"""
    i = 0
    while (
        i < len(tokens)
        and (tokens[i] in RUNNERS or tokens[i].startswith("-"))
        and tokens[i] not in {"wrangler", "infisical", "prisma"}
    ):
        i += 1
    if i >= len(tokens):
        return "", []
    name = tokens[i].rsplit("/", 1)[-1]
    name = re.sub(r"@[\w.^~-]+$", "", name)  # wrangler@4.1 → wrangler
    return name, tokens[i + 1 :]


def infisical_inner(rest: list[str]) -> list[str] | None:
    """`infisical run … -- <cmd>`（または `--command <cmd>`）の <cmd> を語の列で返す。無ければ None。"""
    if "--" in rest:
        return rest[rest.index("--") + 1 :]
    for i, a in enumerate(rest):
        if a.startswith("--command="):
            value = a.split("=", 1)[1]
        elif a == "--command" and i + 1 < len(rest):
            value = rest[i + 1]
        else:
            continue
        try:
            return shlex.split(value)
        except ValueError:
            return value.split()
    return None


def secret_exposure(inner: list[str], depth: int = 0) -> str | None:
    """秘密の入った環境で動かすコマンドが、値を表示しうるなら、その理由（コマンド名）を返す。"""
    if not inner:
        return "コマンドが指定されていません"
    name = inner[0].rsplit("/", 1)[-1]
    if name in SECRET_DUMPERS:
        return name
    if INTERPRETERS.fullmatch(name):
        args = inner[1:]
        if not args or any(a in INLINE_CODE_FLAGS for a in args[:2]):
            return f"{name}（インラインのコード）"
    if name in WRAPPERS and depth < 3:
        rest = [a for a in inner[1:] if not a.startswith("-") and not a.isdigit()]  # timeout 5 / nice -n 10 の数値と、オプションを飛ばす
        return secret_exposure(rest, depth + 1) if rest else f"{name}（実行するコマンドが判別できない）"
    if name == "docker":
        words = [a for a in inner[1:] if not a.startswith("-")]
        for n in (2, 1):
            if tuple(words[:n]) in DOCKER_EXPOSING:
                return "docker " + " ".join(words[:n])
    if name in SHELLS:
        if "-c" in inner and depth < 3:
            idx = inner.index("-c")
            if idx + 1 < len(inner):
                for tokens in segments(inner[idx + 1]):
                    reason = secret_exposure(tokens, depth + 1)
                    if reason:
                        return reason
                return None
        return f"{name}（シェル）"
    return None


def decide_tokens(tokens: list[str], depth: int = 0) -> Decision | None:
    if tokens and tokens[0].rsplit("/", 1)[-1] in SHELLS and depth < 3 and "-c" in tokens:
        idx = tokens.index("-c")
        if idx + 1 < len(tokens):
            return decide(tokens[idx + 1], depth + 1)
        return None
    tool, rest = tool_and_rest(tokens)
    if tool == "wrangler":
        if any(a in {"--version", "-v", "--help", "-h"} for a in rest) and not positional(rest):
            return None
        words = positional(rest)
        if not words:
            return None
        if match_prefix(words, WRANGLER_SAFE):
            return None
        if words[:2] == ["d1", "execute"] and "--local" in rest:
            return None
        return "ask", f"wrangler {words[0]} は、配備・Secret・データの書き込みになりうるため確認します"
    if tool == "infisical":
        if not rest:
            return None
        if "run" in (rest[: rest.index("--")] if "--" in rest else rest):
            inner = infisical_inner(rest)
            if inner is None:
                return "ask", "infisical run の実行コマンドを判別できないため確認します"
            reason = secret_exposure(inner)
            if reason:
                return "ask", f"infisical run -- {reason} は、環境変数（秘密）を表示・外へ出しうるため確認します"
            return decide_tokens(inner, depth + 1) if depth < 3 else None
        first = next((a for a in rest if not a.startswith("-") or a in INFISICAL_SAFE_FIRST), rest[0])
        if first in INFISICAL_SAFE_FIRST:
            return None
        return (
            "ask",
            f"infisical {first} は、値を表示する・書き込む・ログインする操作になりうるため確認します（書き込みはユーザーの操作）",
        )
    if tool == "prisma":
        words = positional(rest)
        if match_prefix(words, PRISMA_ASK):
            return "ask", f"prisma {' '.join(words[:2])} は、データベースを変更するため確認します"
    return None


def decide(command: str, depth: int = 0) -> Decision | None:
    for tokens in segments(command):
        result = decide_tokens(tokens, depth)
        if result:
            return result
    return None


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    command = (event.get("tool_input") or {}).get("command") or ""
    if event.get("tool_name") != "Bash" or not command:
        return 0
    result = decide(command)
    if result:
        decision, reason = result
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": decision,
                        "permissionDecisionReason": f"guard-deploy-cli: {reason}",
                    }
                },
                ensure_ascii=False,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
