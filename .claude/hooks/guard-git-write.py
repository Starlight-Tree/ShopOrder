#!/usr/bin/env python3
"""PreToolUse(Bash) の小さなガード: git commit / git push のフック回避と秘密の混入、gh の PR・issue コメントの投稿。

  - git commit / git push の --no-verify（commit の -n も）→ 拒否
  - git add -A / --all / . / ./（全部のステージ。ルートの CLAUDE.md は、パスを指定すると定める）→ 拒否
  - git push の強制（--force / -f / --force-with-lease / +refspec）→ 確認（公開済みの履歴の書き換え。原則しない）
  - git commit: ステージ済みの差分（-a のときは追跡中の未ステージ分も）の追加行、またはコマンド文字列に、秘密のパターン → 拒否
  - gh pr comment / pr review / issue comment / api（コメント・レビューの書き込み）→ 確認。本文に秘密のパターンがあれば拒否
拒否の理由には、パターン名とファイル名・行番号だけを出す（値は出さない）。

限界: コマンド文字列の解析なので、別名・スクリプト経由・シェルの変数展開は防げない。誤操作と軽い取り込みへの網で、
完全な防御ではない（権限の deny と併用する）。gcloud・gh の書き込み全般のガードは guard-cloud-cli.py の役割で、ここは重ねない。
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from collections.abc import Callable

SECRET_PATTERNS = {
    "Google API キー": re.compile(r"AIza[0-9A-Za-z_-]{35}"),
    "OpenAI 形式のキー": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    "GitHub トークン": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"),
    "Slack トークン": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    "AWS アクセスキー ID": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "秘密鍵": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "JWT": re.compile(r"\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}"),
}
GIT_GLOBAL_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
COMMIT_SHORT_WITH_VALUE = set("mFCctS")  # この文字の後ろは値（-nm "msg" の m 以降は走査しない）
GH_COMMENT_COMMANDS = {("pr", "comment"), ("pr", "review"), ("issue", "comment")}
SEPARATORS = re.compile(r"&&|\|\||;|\||\n")

Decision = tuple[str, str]  # ("deny" | "ask", 理由)


def segments(command: str) -> list[list[str]]:
    out: list[list[str]] = []
    for part in SEPARATORS.split(command):
        try:
            tokens = shlex.split(part, posix=True)
        except ValueError:
            tokens = part.split()
        while tokens and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]) or tokens[0] in {"command", "env", "sudo"}):
            tokens = tokens[1:]
        if tokens:
            out.append(tokens)
    return out


def git_subcommand(tokens: list[str]) -> tuple[str | None, list[str]]:
    i = 1
    while i < len(tokens) and tokens[i].startswith("-"):
        i += 2 if tokens[i] in GIT_GLOBAL_WITH_VALUE else 1
    return (tokens[i], tokens[i + 1 :]) if i < len(tokens) else (None, [])


def has_no_verify(args: list[str], *, short_n: bool) -> bool:
    for arg in args:
        if arg == "--":
            break
        if arg.startswith("--"):
            if arg.startswith("--no-v") and "--no-verify".startswith(arg.split("=")[0]):
                return True
        elif short_n and arg.startswith("-") and len(arg) > 1:
            for char in arg[1:]:
                if char in COMMIT_SHORT_WITH_VALUE:
                    break
                if char == "n":
                    return True
    return False


def secrets_in(text: str) -> list[str]:
    return [name for name, pattern in SECRET_PATTERNS.items() if pattern.search(text)]


def scan_diff(diff: str) -> list[str]:
    """追加行の秘密。『パターン名 ファイル:行』の一覧（値は含めない）。"""
    found: list[str] = []
    path, line = "?", 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            path = raw[4:].removeprefix("b/")
        elif raw.startswith("@@"):
            match = re.search(r"\+(\d+)", raw)
            line = int(match.group(1)) - 1 if match else 0
        elif raw.startswith("+"):
            line += 1
            found += [f"{name} {path}:{line}" for name in secrets_in(raw[1:])]
        elif not raw.startswith("-"):
            line += 1
    return found


def git_diff(cwd: str, *args: str) -> str:
    try:
        return subprocess.run(
            ["git", "diff", "-U0", "--no-color", *args], cwd=cwd, capture_output=True, text=True, timeout=20, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def stages_everything(args: list[str]) -> bool:
    """git add の「全部」指定: -A / --all / . / ./（-Av のように束ねた短いオプションも）。"""
    for arg in args:
        if arg in {".", "./", "--all"}:
            return True
        if arg.startswith("-") and not arg.startswith("--") and "A" in arg[1:]:
            return True
    return False


def is_force_push(args: list[str]) -> bool:
    """git push の強制: --force / -f（束ねた短いオプションも）/ --force-with-lease / --force-if-includes / +refspec。"""
    for arg in args:
        if arg in {"-f", "--force"} or arg.startswith(("--force-with-lease", "--force-if-includes")):
            return True
        if arg.startswith("-") and not arg.startswith("--") and "f" in arg[1:]:
            return True
        if arg.startswith("+") and len(arg) > 1:
            return True
    return False


def check_segment(tokens: list[str], cwd: str, diff_for: Callable[..., str]) -> Decision | None:
    program = os.path.basename(tokens[0])
    if program == "git":
        sub, args = git_subcommand(tokens)
        if sub == "commit":
            if has_no_verify(args, short_n=True):
                return "deny", "git commit の --no-verify（-n）は使いません。フックが落ちた原因を直してください"
            hits = scan_diff(diff_for(cwd, "--staged"))
            if any(a in {"-a", "--all"} or (a.startswith("-") and not a.startswith("--") and "a" in a.split("m")[0]) for a in args):
                hits += scan_diff(diff_for(cwd))
            if hits:
                return "deny", "ステージ済みの差分に秘密のパターンがあります: " + "; ".join(sorted(set(hits))[:5])
        elif sub == "push" and has_no_verify(args, short_n=False):
            return "deny", "git push の --no-verify は使いません"
        elif sub == "push" and is_force_push(args):
            return "ask", "git push の強制は、公開済みの履歴を書き換えます。原則しません。ユーザーが明示して頼んだときだけ、対象と理由を示してから承認を得てください"
        elif sub == "add" and stages_everything(args):
            return "deny", "git add -A / --all / . は使いません。ステージはパスを指定してください（CLAUDE.md）"
    elif program == "gh" and len(tokens) >= 3:
        pair = (tokens[1], tokens[2])
        writes_api = tokens[1] == "api" and any(
            t in {"-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"} for t in tokens[2:]
        ) and any(w in " ".join(tokens) for w in ("comments", "reviews"))
        if pair in GH_COMMENT_COMMANDS or writes_api:
            return "ask", f"{' '.join(tokens[:3])}: コメント・レビューの投稿は外部に公開されます。本文を確かめてから承認してください"
    return None


def decide(command: str, cwd: str = ".", diff_for: Callable[..., str] = git_diff) -> Decision | None:
    leaked = secrets_in(command)
    parts = segments(command)
    decision: Decision | None = None
    for tokens in parts:
        found = check_segment(tokens, cwd, diff_for)
        if found and (decision is None or found[0] == "deny"):
            decision = found
        program = os.path.basename(tokens[0])
        is_commit = program == "git" and git_subcommand(tokens)[0] == "commit"
        is_comment = program == "gh" and tuple(tokens[1:3]) in GH_COMMENT_COMMANDS
        if leaked and (is_commit or is_comment):
            return "deny", "コマンドの本文に秘密のパターンがあります: " + ", ".join(leaked)
    return decision


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    command = (event.get("tool_input") or {}).get("command") or ""
    if event.get("tool_name") != "Bash" or not command:
        return 0
    result = decide(command, event.get("cwd") or ".")
    if result:
        decision, reason = result
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": decision,
                        "permissionDecisionReason": f"guard-git-write: {reason}",
                    }
                },
                ensure_ascii=False,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
