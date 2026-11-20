#!/usr/bin/env python3
"""PreToolUse フック: クラウド CLI（gcloud など）と GitHub CLI（gh）の危険な呼び出しを、実行前に止める。

開発コンテナの gcloud には、ユーザー自身のアカウントでログインし、gh には、読み取り専用の細粒度トークンを置く想定。
認証情報があるので、誤操作や、取り込んだ文書に埋め込まれた指示による破壊的な操作を、ここで防ぐ。

  終了コード 2  … 拒否（理由を標準エラーへ。Claude Code はこの呼び出しを実行せず、理由をモデルに返す）
  JSON を標準出力 … 確認を強制する（permissionDecision: "ask"）
  何も出さず 0   … この検査では判断しない（通常の権限ルールに任せる）

方針:
  - 読み取り（list / describe / get / read / logs / view ...）は通す。
  - 認証情報の取得・ID の切り替え・IAM や課金の変更・削除は拒否する。
  - それ以外の gcloud / gh などの操作（deploy / create / update ...）は確認を強制する。
  - これらの CLI に関係の無いコマンドは、何もしない。

コマンド文字列は、シェルの構文（引用符・改行・; & | ( )・リダイレクト・ヒアドキュメント・コマンド置換・
算術式・case・${...}）を近似的に読んで、1 つずつの単純なコマンドに分けてから調べる。ラッパー（sudo / env /
xargs ...）、`bash -c`、`eval`、`find -exec`、シェルへ渡す文字列（ヒアドキュメント・パイプ・/dev/stdin）の中身も
調べる。知らないラッパー・実行役（taskset / fakeroot / tmux ...）は、引数に CLI の名前が単独で出たら、そこから
調べる（mkdir / mv / rm / ls / apt-get など、ファイルやパッケージを扱うだけで引数を実行しないプログラムは除く）。
引数や環境変数の値が CLI で始まるコマンドライン（git -c alias.x=!gh ... / flock -c 'gh ...'）も調べる。
sed の s/// と y/// の中の文章は、コマンドとして調べない。
語は、ブレース展開（{gh,run}・{gh,"run"}）・${x:-既定値}・グロブのプログラム名（/usr/bin/g?）・$(which gh) の置換、
同じコマンドの中で代入した変数（g=gh; $g ...、g+=h、for c in gh gcloud; do $c ...）を展開した姿でも調べる。
引用符で切れる変数名（"$g"oud）、未設定の変数が空になる形（g${x}h）、置換の出力がそのままコマンドになる形
（$(echo gh run delete 1)）、VAR=値 cmd の VAR を引き継ぐ子のシェル（g=gh bash -c '$g ...'）、bash -c の後ろの語
（exec "$@"）、sudo -i / su が標準入力から読むコマンド、知らない起動役の中のシェル・複合コマンド・git credential も調べる。
中身を検査できないスクリプトをシェルへ流す形（curl ... | sh、bash <(curl ...)）は、確認にする。
入れ子が深すぎる（MAX_DEPTH）・長く、決まった作業量（MAX_STEPS）で読み切れないものは、拒否にする。
変数の値やブレース展開の候補が上限（MAX_VALUES / MAX_VARIANTS / BRACE_LIMIT）を超えたら、黙って落とさず、確認にする。

これはセキュリティ境界ではない（コマンド文字列の検査なので、実行時に決まる変数・コマンドの出力に隠した操作、
ファイルに書いたスクリプトの中身、パスの難読化までは追えない）。gcloud は日常の ID を閲覧専用にするなどの設定と
GCP 側の保護、gh はトークンの権限（読み取り専用）と組み合わせて使う。異常終了・タイムアウトは、フックの設定の
onFailure: "block" で拒否にする。
"""

from __future__ import annotations

import fnmatch
import json
import os
import posixpath
import re
import sys
from collections.abc import Callable

MAX_DEPTH = 5  # bash -c や $(...) の入れ子を追う深さ

CLIS = {"gcloud", "gsutil", "bq", "terraform", "tofu", "kubectl", "gh"}
CLI_WORD = re.compile(r"\b(gcloud|gsutil|bq|terraform|tofu|kubectl|gh)\b")
# 標準入力のスクリプトを実行するシェル（-c の文字列も調べる）。su / script は -c の文字列だけ調べる
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "mksh", "rbash"}
C_ONLY_SHELLS = {"su", "script", "sg", "newgrp"}
SOURCERS = {"source", "."}
# シェルが標準入力のスクリプトを読む、デバイスのパス
STDIN_PATHS = {"/dev/stdin", "/dev/fd/0", "/proc/self/fd/0", "/proc/self/fd/0/"}
# CLI の名前を引数に取るだけで、実行はしないプログラム（調べない）
LOOKUP_PROGRAMS = {
    "which", "type", "whereis", "whatis", "man", "apropos", "hash", "help", "info", "locate", "command",
    "apt", "apt-get", "aptitude", "dpkg", "brew", "snap", "yum", "dnf", "apk", "pacman", "conda", "cargo", "gem",
    "pip", "pip3",
    # ファイルを作る・動かす・消すだけで、引数を実行しない（sudo mkdir -p /opt/terraform / sudo mv gh /usr/local/bin/ ...）
    "mkdir", "rmdir", "chmod", "chown", "chgrp", "install", "mv", "cp", "rm", "ln", "ls", "touch", "stat", "file",
    "readlink", "realpath", "dirname", "basename", "du",
    "[", "[[", "test",  # [ "$TOOL" = gh ] / [ -x /usr/bin/gh ]
}
# sed -i 's/gcloud auth login/.../' の s/// と y///。中の文章は実行されない（先頭が s/ の「パス付きのコマンド行」に見えてしまう）
SED_SUBSTITUTION = re.compile(r"^[sy]([^\w\s\\]).*\1", re.DOTALL)
# 引数の文字列が、CLI で始まるコマンドラインか（`gh run delete 1`、`!gh ...`、`--command=gh ...`、`VAR=gh ...`）
_CLI_NAMES = r"(?:gcloud|gsutil|bq|terraform|tofu|kubectl|gh)"
_CMDLINE_PREFIX = re.compile(r"^(?:--?[A-Za-z][\w-]*=|[A-Za-z_][\w.\-]*=)+")
_CMDLINE = re.compile(r"^\s*(?:\S+/)?" + _CLI_NAMES + r"\s")
# git credential ...（保存された認証情報の取り出し）と、git-credential-* のヘルパーの呼び出し（引数が続く形）
_GIT_CREDENTIAL = re.compile(r"^\s*(?:\S+/)?(?:git(?:\s+-\S+(?:=\S+)?)*\s+credential\b|git-credential\S*\s)")
_GLUED_SHORT = re.compile(r"^-[A-Za-z]{1,3}(?=(?:\S+/)?" + _CLI_NAMES + r"\s)")
INTERPRETER = re.compile(
    r"^(python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|awk|gawk|mawk|nawk|lua|luajit|tclsh[\d.]*|wish|expect|julia|Rscript)$"
)
# 引数のスクリプト・タスクの中でコマンドを呼びうるランナー（中身までは追えないので、CLI の名前が見えたら確認する）
RUNNERS = {"uv", "uvx", "npx", "pnpm", "yarn", "npm", "poetry", "pipx", "make", "just", "tox", "nox"}
# 標準入力（ヒアドキュメント・ヒアストリング）で受け取ったコマンドを、後で実行するもの
SCHEDULERS = {"at", "batch"}
# 他のコマンドを起動するラッパー: 名前 -> (値を取るオプション, 先頭で飛ばす位置引数の数)
WRAPPERS: dict[str, tuple[set[str], int]] = {
    "sudo": (
        {"-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group", "--host", "--prompt",
         "--close-from", "--chdir", "--chroot", "--command-timeout", "--other-user", "--role", "--type"},
        0,
    ),
    "doas": ({"-u", "-C"}, 0),
    "env": ({"-u", "-C", "-S", "-a", "-P", "--unset", "--chdir", "--split-string", "--argv0"}, 0),
    "time": ({"-f", "-o", "--format", "--output"}, 0),
    "timeout": ({"-s", "-k", "--signal", "--kill-after"}, 1),
    "nohup": (set(), 0),
    "nice": ({"-n", "--adjustment"}, 0),
    "ionice": ({"-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"}, 0),
    "command": (set(), 0),
    "builtin": (set(), 0),
    "exec": ({"-a"}, 0),
    # -i / -l / --replace / --eof / --max-lines の値は、-i{} のように続けて書く形だけ（別の引数にはならない）
    "xargs": (
        {"-I", "-d", "-a", "-E", "-L", "-n", "-P", "-s", "--delimiter", "--arg-file", "--max-args", "--max-procs",
         "--max-chars", "--process-slot-var"},
        0,
    ),
    "parallel": ({"-j", "-n", "-N", "-a", "-P", "-S", "-L", "-l", "--jobs", "--arg-file", "--sshlogin"}, 0),
    "watch": ({"-n", "--interval"}, 0),  # -d / --differences の値は、続けて書く形だけ
    "stdbuf": ({"-i", "-o", "-e", "--input", "--output", "--error"}, 0),
    "setsid": (set(), 0),
    "flock": ({"-w", "-E", "--timeout", "--conflict-exit-code"}, 1),
    "busybox": (set(), 0),
    "taskset": ({"-c"}, 0),
    "strace": ({"-e", "-o", "-p", "-s", "-u"}, 0),
    "unbuffer": (set(), 0),
}
# コマンドの先頭に来うる予約語（if / while / do ... の直後のコマンドを見落とさないよう飛ばす）
RESERVED = {
    "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "select",
    "function", "{", "}", "!", "coproc",
}
ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\+?=")
ASSIGNING_BUILTINS = {"export", "declare", "typeset", "readonly", "local"}

# シェルの演算子（長いものを先に）。REDIRECTS は直後の語を対象として取り、それ以外は単純コマンドを区切る
OPERATORS = [
    "<<<", "<<-", "&>>", ";;&", "<<", ">>", ">&", "<&", "&>", ">|", "<>", "&&", "||", "|&", ";;", ";&", "<(", ">(",
    ";", "&", "|", "(", ")", "<", ">",
]
REDIRECTS = {"<", ">", ">>", ">&", "<&", "&>", "&>>", ">|", "<>"}
PIPES = {"|", "|&"}
CONTINUING = {"|", "|&", "&&", "||"}  # 直後の改行で、コマンドが続く

# 認証情報の置き場・トークンの取得・ID の切り替え。これらを含む操作は拒否する
CREDENTIAL_TEXT = re.compile(
    r"\.config/gcloud|application_default_credentials|credentials\.db|access_tokens\.db"
    r"|legacy_credentials|\.gcloud-token|print-access-token|print-identity-token"
    r"|\.config/gh(?![\w-])|\.gh-config|\bGH_CONFIG_DIR\b|\bCLOUDSDK_CONFIG\b|\.git-credentials"
)
# 認証情報のディレクトリ（~ や $HOME を展開し、// ・ /./ ・ .. を畳み、* や ? を含む指定も照合する）
HOME_DIRS = {os.path.expanduser("~"), "/home/vscode"}
PROTECTED_DIRS = [h + "/" + d for h in sorted(HOME_DIRS) for d in (".config/gcloud", ".config/gh", ".gh-config")]
PROTECTED_FILES = ("hosts.yml", "config.yml", "credentials.db", "access_tokens.db", "legacy_credentials")
PROTECTED_PATHS = PROTECTED_DIRS + [d + "/" + f for d in PROTECTED_DIRS for f in PROTECTED_FILES]
# 認証・ID を変える環境変数（gh の GH_PAGER / GH_EDITOR / GH_BROWSER は、任意のコマンドを起動させられるので含める）
IDENTITY_ENV = re.compile(
    r"^(CLOUDSDK_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_OAUTH_ACCESS_TOKEN"
    r"|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_CONFIG_DIR"
    r"|GH_DEBUG|GH_PAGER|GH_EDITOR|GH_BROWSER)$"
)
# gh が、専用の変数が無いときに代わりに使う環境変数（任意のコマンドを起動させられる）。CLI の呼び出しに付けたら拒否する
LAUNCHER_ENV = re.compile(r"^(BROWSER|PAGER|EDITOR|VISUAL)$")
# 通信の経路や、信頼する証明書を変える環境変数（トークンを別の経路へ流せる）。CLI の呼び出しに付けたら拒否する
ROUTING_ENV = re.compile(
    r"^(?i:https?_proxy|all_proxy|ssl_cert_file|ssl_cert_dir|curl_ca_bundle|requests_ca_bundle"
    r"|node_extra_ca_certs|sslkeylogfile)$"
)
IDENTITY_FLAGS = ("--impersonate-service-account", "--account", "--access-token-file", "--credential-file-override")
# 文章（コミットメッセージなど）に書いただけで拒否しないよう、検査から外すプログラム
TEXT_ONLY = {"echo", "printf"}
GREP_PROGRAMS = {"grep", "egrep", "fgrep", "rg", "ag", "ack", "zgrep"}
# 認証情報のディレクトリを含む上位のディレクトリを渡されると、まとめて読む・写す・開くプログラム
PARENT_SENSITIVE = GREP_PROGRAMS | {"find", "cp", "mv", "tar", "zip", "rsync", "scp", "cd", "pushd"}

DESTRUCTIVE = {
    "delete", "destroy", "undelete", "purge", "wipe", "disable", "remove", "rm", "rb", "reset",
    "set-iam-policy", "add-iam-policy-binding", "remove-iam-policy-binding", "set-iam", "set-iam-policy-binding",
}
SENSITIVE_GROUPS = {"iam", "billing", "organizations", "projects", "resource-manager", "kms"}
READ_VERBS = {
    "list", "describe", "get", "read", "tail", "log", "logs", "get-iam-policy", "get-value", "info",
    "version", "help", "show", "ls", "cat", "stat", "du", "head", "plan", "validate", "fmt", "output", "graph",
    "top", "explain", "api-resources", "cluster-info",
}
# 書き込みを表す動詞（リソース名に get-user のような読み取りらしい語があっても、先に出た書き込みの動詞を採る）
WRITE_VERBS = {
    "deploy", "create", "update", "patch", "stop", "start", "restart", "resume", "suspend", "add", "set", "import",
    "export", "submit", "run", "execute", "invoke", "call", "copy", "cp", "move", "mv", "rename", "resize", "attach",
    "detach", "apply", "replace", "enable", "revoke", "sign", "upload", "push", "publish", "cancel", "approve",
    "promote", "rollback", "migrate", "bind", "unbind", "link", "unlink", "clone", "tag", "untag", "write", "ssh",
    "scp", "connect", "tunnel", "login", "init", "install", "uninstall", "reload", "restore", "failover",
    "get-credentials",  # gcloud container clusters get-credentials は、kubeconfig を書き換える
}
WRITE_PREFIXES = ("set-", "add-", "update-", "create-", "delete-", "remove-", "enable-", "disable-", "import-")
# get- で始まる動詞のうち、値（キー・認証文字列・トークン・パスワード）を表示するもの。get-credentials は別（kubeconfig の書き換え）
SECRET_GETTER = re.compile(r"get-(?:key-string|auth-string|[\w-]*(?:token|password|secret)[\w-]*)")
RELEASE_TRACKS = {"alpha", "beta"}
VALUE_FLAGS = {
    "--project", "--region", "--zone", "--location", "--format", "--filter", "--limit", "--sort-by",
    "--page-size", "--configuration", "--billing-project", "--verbosity", "--service", "--freshness", "--order",
    "--trace-token", "--flatten", "--flags-file", "--universe-domain",  # gcloud の、値を取る共通のフラグ
}
# 値を取らない共通のフラグ（これらと VALUE_FLAGS 以外の --フラグ が先頭にあると、次の語が値かどうか分からない）
BOOLEAN_FLAGS = {
    "--quiet", "--help", "--version", "--log-http", "--no-log-http", "--user-output-enabled",
    "--no-user-output-enabled", "--uri", "--async", "--no-async", "--dry-run", "--no-dry-run",
}
# kubectl で、別の利用者になる・資格情報を直接渡すフラグ（拒否）と、接続先・資格情報の取り出し先を変えるフラグ（確認）
KUBECTL_IDENTITY_FLAGS = {"--as", "--as-group", "--as-uid", "--token"}
KUBECTL_TARGET_FLAGS = {"--server", "-s", "--kubeconfig", "--user", "--cluster", "--certificate-authority",
                        "--client-certificate", "--client-key", "--insecure-skip-tls-verify"}
# kubectl の、値を取る共通のフラグ（-n kube-system get pods の kube-system を、グループと取り違えない）
KUBECTL_VALUE_FLAGS = {
    "-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "-o", "--output",
    "-l", "--selector", "-c", "--container", "--field-selector", "--as", "--as-group", "--as-uid", "--token",
    "--tail", "--since", "--request-timeout", "--sort-by", "--template", "-L", "--label-columns",
    "--certificate-authority", "--client-certificate", "--client-key",
}


class Finding:
    def __init__(self, level: str, reason: str) -> None:
        self.level, self.reason = level, reason


CREDENTIAL_DENY = Finding(
    "deny", "認証情報（~/.config/gcloud、~/.config/gh、gh の設定ディレクトリ、トークンの出力）には触れません。"
)
GIT_CREDENTIAL_DENY = Finding(
    "deny", "git credential（保存された認証情報の取り出し）は許可していません。push / pull はそのまま使えます。"
)


# --- 字句解析（シェルの構文の近似）---


class Word:
    """引用符を外した 1 つの語。subs は、引用符の中・バッククォートの中のコマンド置換の中身。"""

    __slots__ = ("text", "subs", "quoted", "mask")

    def __init__(self, text: str, subs: list[str], quoted: bool, mask: str = "") -> None:
        self.text, self.subs, self.quoted = text, subs, quoted
        self.mask = mask  # text と同じ長さ。1 は、引用符や \ の中で書いた文字（ブレース展開されない）


class Heredoc:
    __slots__ = ("delim", "quoted", "strip_tabs", "body")

    def __init__(self, delim: str, quoted: bool, strip_tabs: bool) -> None:
        self.delim, self.quoted, self.strip_tabs, self.body = delim, quoted, strip_tabs, ""

    def read(self, text: str, i: int) -> int:
        """区切り行までを本文として読み、次の位置を返す（終端が無ければ末尾まで）。"""
        lines: list[str] = []
        n = len(text)
        while i < n:
            j = text.find("\n", i)
            line = text[i:] if j < 0 else text[i:j]
            i = n if j < 0 else j + 1
            if line.strip() == self.delim:
                break
            lines.append(line)
        self.body = "\n".join(lines)
        return i


_ANSI_ESCAPES = {
    "n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "v": "\v",
    "\\": "\\", "'": "'", '"': '"', "?": "?",
}


def _ansi_escape(text: str, i: int) -> tuple[str, int]:
    """$'...' の中の、text[i] == '\\' から始まるエスケープを解釈して (文字, 次の位置) を返す。"""
    c = text[i + 1 : i + 2]
    if c in _ANSI_ESCAPES:
        return _ANSI_ESCAPES[c], i + 2
    if c == "x":
        m = re.match(r"[0-9A-Fa-f]{1,2}", text[i + 2 :])
        if m:
            return chr(int(m.group(), 16)), i + 2 + len(m.group())
    if c and c in "01234567":
        m = re.match(r"[0-7]{1,3}", text[i + 1 :])
        if m:
            return chr(int(m.group(), 8) & 0xFF), i + 1 + len(m.group())
    if c in ("u", "U"):
        m = re.match(r"[0-9A-Fa-f]{1,%d}" % (4 if c == "u" else 8), text[i + 2 :])
        if m:
            try:
                return chr(int(m.group(), 16)), i + 2 + len(m.group())
            except (ValueError, OverflowError):
                pass
    return "\\" + c, i + 2


def _skip_backtick(text: str, i: int) -> int:
    """text[i] == '`' に対応する閉じの次の位置を返す（閉じが無ければ末尾）。"""
    j, n = i + 1, len(text)
    while j < n:
        if text[j] == "\\":
            j += 2
        elif text[j] == "`":
            return j + 1
        else:
            j += 1
    return n


def _backtick_inner(text: str, i: int, end: int) -> str:
    """text[i] == '`' から end（閉じの次）までの中身。入れ子のバッククォート（\\`）のエスケープを外す。"""
    closed = end - 1 > i and text[end - 1 : end] == "`"
    body = text[i + 1 : end - 1] if closed else text[i + 1 : end]
    return re.sub(r"\\([$`\\])", r"\1", body)


MAX_NESTING = 40  # $( ... ) と引用符の入れ子を読む深さ（病的な入力で再帰が深くならないように）
MAX_STEPS = 3_000_000  # 1 回の検査で読む文字数の上限。超えたら検査をやめる（フックの timeout 前に、拒否にする）
_steps = [MAX_STEPS]
_PAREN_CACHE: dict[tuple[str, int], int] = {}


class TooComplex(Exception):
    """入れ子が深く・長く、決まった時間で検査できない。"""


def _tick(count: int = 1) -> None:
    _steps[0] -= count
    if _steps[0] < 0:
        raise TooComplex("too complex")


def _skip_double_quote(text: str, i: int, level: int = 0) -> int:
    """text[i] は開きの '"' の次。閉じの次の位置を返す（閉じが無ければ末尾）。"""
    n = len(text)
    if level > MAX_NESTING:
        return n
    while i < n:
        _tick()
        c = text[i]
        if c == "\\":
            i += 2
        elif c == '"':
            return i + 1
        elif c == "$" and text[i + 1 : i + 2] == "(":
            i = _match_paren(text, i + 1, level + 1)
        elif c == "`":
            i = _skip_backtick(text, i)
        else:
            i += 1
    return n


def _match_paren(text: str, i: int, level: int = 0) -> int:
    """text[i] == '(' に対応する ')' の次の位置を返す（閉じが無ければ末尾）。

    中身は字句解析器と同じ規則（引用符・コメント・ヒアドキュメント・case の ) など）で読む。
    """
    if level > MAX_NESTING:
        return len(text)
    cached = _PAREN_CACHE.get((text, i))
    if cached is not None:
        return cached
    lexer = _Lexer(text, start=i + 1, level=level + 1, stop_at_close=True)
    lexer.run()
    _PAREN_CACHE[(text, i)] = lexer.end
    return lexer.end


def _inner(text: str, start: int, end: int) -> str:
    """text[start:end]（閉じを含む）から、閉じの 1 文字を除いた中身を返す。"""
    return text[start : end - 1] if end - 1 >= start and text[end - 1 : end] in (")", "`") else text[start:end]


def substitutions_in(text: str, level: int = 0) -> list[str]:
    """文章（引用符なしのヒアドキュメントの本文など）の中の $(...) とバッククォートの中身を返す。"""
    found: list[str] = []
    i, n = 0, len(text)
    while i < n:
        _tick()
        c = text[i]
        if c == "\\":
            i += 2
        elif c == "$" and text[i + 1 : i + 2] == "(":
            end = _match_paren(text, i + 1, level)
            found.append(_inner(text, i + 2, end))
            i = end
        elif c == "`":
            end = _skip_backtick(text, i)
            found.append(_backtick_inner(text, i, end))
            i = end
        else:
            i += 1
    return found


def _arith_end(text: str, i: int, close: str) -> int:
    """算術式の本文の開始位置 i から、閉じ（close は "))" か "]"）の次の位置を返す。見つからなければ -1。"""
    depth, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if close == "]":
            if c == "[":
                depth += 1
            elif c == "]":
                if depth == 0:
                    return i + 1
                depth -= 1
        elif c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                return i + 2 if text[i + 1 : i + 2] == ")" else -1
            depth -= 1
        i += 1
    return -1


# 算術式なら、演算子を挟まずに識別子や数が並ぶことはない（並ぶなら、コマンドの入れ子）
_ADJACENT_OPERANDS = re.compile(r"[A-Za-z_0-9\])]\s+[A-Za-z_$]")


def _plausible_arithmetic(inner: str, allow_semicolon: bool = False) -> bool:
    if "\n" in inner or (";" in inner and not allow_semicolon):
        return False
    return not _ADJACENT_OPERANDS.search(re.sub(r"\$\([^()]*\)|`[^`]*`", "0", inner))


class _Case:
    """case 文の読み取りの状態。state: word（対象）→ in → pattern ⇄ body。"""

    __slots__ = ("state", "depth", "fresh")

    def __init__(self) -> None:
        self.state, self.depth, self.fresh = "word", 0, False


_TAIL_VARIABLE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)$")
_ARRAY_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=")
_FD_VARIABLE = re.compile(r"\{[A-Za-z_][A-Za-z0-9_]*\}")
_COMMAND_WORDS = {"then", "do", "else", "elif", "if", "while", "until", "!", "{", "time"}


class _Lexer:
    def __init__(self, text: str, start: int = 0, level: int = 0, stop_at_close: bool = False) -> None:
        self.text, self.n = text, len(text)
        self.start, self.level, self.stop_at_close = start, level, stop_at_close
        self.end = self.n  # stop_at_close のとき、対応する ) の次の位置
        self.stopped = False
        self.depth = 0  # ( の入れ子の深さ
        self.braces = 0  # ${ の入れ子の深さ（bash は ${ の入れ子だけを数える。普通の { は数えない）
        self.cases: list[_Case] = []
        self.toks: list[Word | Heredoc | str] = []
        self.buf: list[str] = []
        self.mask: list[str] = []  # buf の各要素と同じ長さの 0/1 の列（1 は引用符の中の文字）
        self.subs: list[str] = []
        self.has = False
        self.quoted = False
        self.want: str | None = None  # 直前の演算子が << / <<- のとき、次の語は区切りの語
        self.pending: list[Heredoc] = []

    def add(self, s: str, quoted: bool = False) -> None:
        self.buf.append(s)
        self.mask.append(("1" if quoted else "0") * len(s))
        self.has = True
        if quoted:
            self.quoted = True

    def end_variable(self) -> None:
        """語の末尾が $name なら ${name} にする。"$g"oud の引用符は、変数名の終わり（$goud ではない）。"""
        if not self.buf or len(self.buf) > 512:
            return
        joined = "".join(self.buf)
        m = _TAIL_VARIABLE.search(joined)
        if m is None:
            return
        mask = "".join(self.mask)
        braced = "${" + m.group(1) + "}"
        self.buf = [joined[: m.start()], braced]
        self.mask = [mask[: m.start()], mask[m.start()] * len(braced)]

    def at_command_position(self) -> bool:
        """直前が、コマンドの先頭になりうる位置か（先頭・区切り・予約語の後）。"""
        if not self.toks:
            return True
        last = self.toks[-1]
        if isinstance(last, Word):
            return last.text in _COMMAND_WORDS and not last.quoted
        if isinstance(last, Heredoc):
            return False
        return last not in REDIRECTS and last not in ("<<<", "<<", "<<-")

    def track_case(self, word: str, quoted: bool, command_position: bool) -> None:
        """case 文の状態を進める（パターンの ) を、入れ子の閉じと取り違えないため）。"""
        if self.cases:
            top = self.cases[-1]
            if top.state == "word":
                top.state = "in"
                return
            if top.state == "in":
                if word == "in" and not quoted:
                    top.state, top.depth, top.fresh = "pattern", self.depth, True
                return
            if top.state == "pattern":
                top.fresh = False
        if command_position and not quoted:
            if word == "case":
                self.cases.append(_Case())
            elif word == "esac" and self.cases:
                self.cases.pop()

    def flush(self) -> None:
        if self.has:
            word = "".join(self.buf)
            if self.want is not None:
                heredoc = Heredoc(word, self.quoted, self.want == "<<-")
                self.toks.append(heredoc)
                self.pending.append(heredoc)
                self.want = None
            else:
                self.track_case(word, self.quoted, self.at_command_position())
                self.toks.append(Word(word, self.subs, self.quoted, "".join(self.mask)))
        self.buf, self.mask, self.subs, self.has, self.quoted = [], [], [], False, False

    def double_quote(self, i: int) -> int:
        text, n = self.text, self.n
        j = i + 1
        while j < n:
            d = text[j]
            if d == "\\":
                nxt = text[j + 1 : j + 2]
                if nxt == "\n":
                    j += 2
                elif nxt in ("$", "`", '"', "\\"):
                    self.add(nxt, quoted=True)
                    j += 2
                else:
                    self.add(d, quoted=True)
                    j += 1
            elif d == '"':
                break
            elif d == "$" and text[j + 1 : j + 2] == "(":
                end = _match_paren(text, j + 1, self.level)
                self.subs.append(_inner(text, j + 2, end))
                self.add(text[j:end], quoted=True)
                j = end
            elif d == "`":
                end = _skip_backtick(text, j)
                self.subs.append(_backtick_inner(text, j, end))
                self.add(text[j:end], quoted=True)
                j = end
            else:
                self.add(d, quoted=True)
                j += 1
        self.has = self.quoted = True
        self.end_variable()  # "$g"oud
        return min(j + 1, n)

    def ansi_quote(self, i: int) -> int:
        text, n = self.text, self.n
        j = i + 2
        while j < n and text[j] != "'":
            if text[j] == "\\" and j + 1 < n:
                char, j = _ansi_escape(text, j)
                self.add(char, quoted=True)
            else:
                self.add(text[j], quoted=True)
                j += 1
        self.has = self.quoted = True
        self.end_variable()
        return min(j + 1, n)

    def operator(self, i: int) -> int:
        text = self.text
        # 2>/dev/null の 2 は、ファイル記述子の番号であって語ではない。{fd}>file の {fd} も同じ
        if text[i] in "<>" and self.has and not self.quoted and (
            "".join(self.buf).isdigit() or _FD_VARIABLE.fullmatch("".join(self.buf))
        ):
            self.buf, self.mask, self.subs, self.has = [], [], [], False
        elif text[i] == "(" and self.has and not self.quoted and _ARRAY_ASSIGNMENT.fullmatch("".join(self.buf)):
            end = _match_paren(text, i, self.level)  # a=(x y) は配列の代入。中の語はコマンドではない
            self.subs.extend(substitutions_in(text[i + 1 : end - 1], self.level))
            self.add(text[i:end])
            return end
        else:
            self.flush()
        op = next(o for o in OPERATORS if text.startswith(o, i))
        if op in (";;", ";&", ";;&") and self.cases and self.cases[-1].state == "body":
            self.cases[-1].state, self.cases[-1].fresh = "pattern", True
        if op in ("(", "<(", ">("):
            top = self.cases[-1] if self.cases else None
            if top is not None and top.state == "pattern" and top.fresh and op == "(" and self.depth == top.depth:
                top.fresh = False  # case のパターンの先頭の ( は、入れ子ではない
            else:
                self.depth += 1
        elif op == ")":
            top = self.cases[-1] if self.cases else None
            if top is not None and top.state == "pattern" and self.depth == top.depth:
                top.state = "body"  # パターンの終わり
            elif self.depth == 0 and self.stop_at_close:
                self.end = i + 1
                self.stopped = True
                self.toks.append(op)
                return self.n
            else:
                self.depth = max(0, self.depth - 1)
        self.toks.append(op)
        self.want = op if op in ("<<", "<<-") else None
        return i + len(op)

    def arithmetic(self, i: int) -> int | None:
        """text[i] が $(( ... )) / $[ ... ] / (( ... )) の始まりなら、全体を 1 語として読み、次の位置を返す。"""
        text = self.text
        if text.startswith("$((", i):
            inner_start, close, allow = i + 3, "))", False
        elif text.startswith("$[", i):
            inner_start, close, allow = i + 2, "]", False
        elif text.startswith("((", i) and not self.has and (
            self.at_command_position()
            or (isinstance(self.toks[-1], Word) and self.toks[-1].text == "for" and not self.toks[-1].quoted)
        ):
            inner_start, close = i + 2, "))"
            allow = bool(self.toks) and isinstance(self.toks[-1], Word) and self.toks[-1].text == "for"
        else:
            return None
        end = _arith_end(text, inner_start, close)
        if end < 0:
            return None
        inner = text[inner_start : end - len(close)]
        if not _plausible_arithmetic(inner, allow):
            return None
        self.subs.append(inner)  # 中のコマンド置換や認証情報のパスも調べる（算術式は 1 語として読むが、見落とさない）
        # 空白や ; & | が残ると、コマンドが 1 つの文字列で渡されたと取り違える。\x01 は \w でも空白でもない
        self.add(re.sub(r"[\s;&|]", "\x01", text[i:end]))
        return end

    def run(self) -> list[Word | Heredoc | str]:
        text, n = self.text, self.n
        i = self.start
        while i < n:
            _tick()
            c = text[i]
            if c in " \t\r":
                if self.braces > 0:  # ${x:-gh run delete 1} の空白は、語を区切らない（展開した後で分かれる）
                    self.add(c)
                else:
                    self.flush()
                i += 1
            elif c == "\n":
                self.flush()
                self.toks.append("\n")
                self.want = None
                i += 1
                for heredoc in self.pending:
                    i = heredoc.read(text, i)
                self.pending = []
            elif c == "#" and not self.has and self.braces == 0:  # 語の先頭の # は、行末までコメント
                j = text.find("\n", i)
                i = n if j < 0 else j
            elif c == "\\":
                nxt = text[i + 1 : i + 2]
                if nxt != "\n":  # 行継続（\ + 改行）は無かったことにする
                    self.end_variable()
                    self.add(nxt, quoted=True)
                i += 2
            elif c == "'":
                self.end_variable()
                j = text.find("'", i + 1)
                end = n if j < 0 else j
                self.add(text[i + 1 : end], quoted=True)
                i = min(end + 1, n)
            elif c == '"':
                self.end_variable()
                i = self.double_quote(i)
            elif c == "$" and text[i + 1 : i + 2] == "'":
                self.end_variable()
                i = self.ansi_quote(i)
            elif c == "$" and text[i + 1 : i + 2] == '"':
                i += 1
            elif c == "`":
                end = _skip_backtick(text, i)
                self.subs.append(_backtick_inner(text, i, end))
                self.add(text[i:end])
                i = end
            elif c in "$(" and (jumped := self.arithmetic(i)) is not None:
                i = jumped
            elif c == "$" and text[i + 1 : i + 2] == "(":
                # $( ... ) は、引用符の中・バッククォートと同じく 1 語として読む（$(which gh) run のような語も扱える）
                end = _match_paren(text, i + 1, self.level)
                self.subs.append(_inner(text, i + 2, end))
                self.add(text[i:end])
                i = end
            elif c == "$" and text[i + 1 : i + 2] == "{":  # ${ ... } の中の # は、コメントではない
                self.braces += 1
                self.add("${")
                i += 2
            elif c == "}" and self.braces > 0:
                self.braces -= 1
                self.add(c)
                i += 1
            elif c in ";&|()<>":
                i = self.operator(i)
            else:
                self.add(c)
                i += 1
        if not self.stopped:
            self.end = n
        self.flush()
        return self.toks


class Unit:
    """1 つの単純コマンド。words はリダイレクトを除いた語、targets はリダイレクトの対象。"""

    def __init__(self, before: str) -> None:
        self.before = before  # 直前の区切り（"" は先頭）
        self.after = ""  # 直後の区切り
        self.words: list[str] = []
        self.dynamic: list[bool] = []  # words の各語に、実行時に決まる部分（コマンド置換）があるか
        self.plain: list[bool] = []  # words の各語が、引用符も \ も含まないか（変数の値を、空白で分ける語）
        self.masks: list[str] = []  # words の各語の、引用符の位置（Word.mask）
        self.subs: list[str] = []
        self.targets: list[str] = []
        self.heredocs: list[Heredoc] = []
        self.herestrings: list[str] = []

    def has_content(self) -> bool:
        return bool(self.words or self.targets or self.heredocs or self.herestrings or self.subs)


def build_units(toks: list[Word | Heredoc | str]) -> list[Unit]:
    units: list[Unit] = []
    cur = Unit("")
    pending: str | None = None  # 直前の演算子が、直後の語を取る種類のとき、その演算子
    for tok in toks:
        if isinstance(tok, str):
            pending = None
            if tok in REDIRECTS or tok in ("<<<", "<<", "<<-"):
                pending = tok
                continue
            if tok == "\n" and not cur.has_content() and cur.before in CONTINUING:
                continue
            if cur.has_content():
                cur.after = tok
                units.append(cur)
            cur = Unit(tok)
        elif isinstance(tok, Heredoc):
            cur.heredocs.append(tok)
            pending = None
        else:
            cur.subs.extend(tok.subs)
            if pending in REDIRECTS:
                cur.targets.append(tok.text)
            elif pending == "<<<":
                cur.herestrings.append(tok.text)
            else:
                cur.words.append(tok.text)
                cur.dynamic.append(bool(tok.subs))
                cur.plain.append(not tok.quoted)
                cur.masks.append(tok.mask)
            pending = None
    if cur.has_content():
        units.append(cur)
    return units


def tokenize(text: str) -> list[Word | Heredoc | str]:
    return _Lexer(text).run()


# --- コマンドの特定 ---


ENV_LONG_OPTIONS = (
    "--ignore-environment", "--null", "--unset", "--chdir", "--split-string", "--argv0", "--debug", "--block-signal",
    "--default-signal", "--ignore-signal", "--list-signal-handling", "--help", "--version",
)


def env_long(name: str) -> str:
    """GNU env は、長いオプション名を、他と紛れない先頭だけで書ける（--ignore-env / --uns=VAR / --un VAR）。"""
    if name in ENV_LONG_OPTIONS or len(name) <= 2:
        return name
    hits = [option for option in ENV_LONG_OPTIONS if option.startswith(name)]
    return hits[0] if len(hits) == 1 else name


def resolve_program(words: list[str]) -> tuple[int | None, list[str], list[str]]:
    """環境変数の代入・予約語・ラッパー（sudo / env / timeout ...）を飛ばして、実際のプログラムの位置を返す。

    ほかに、ラッパーが引数で受け取るコマンド文字列（env -S ...）と、通ったラッパーの名前を返す。
    """
    scripts: list[str] = []
    wrappers: list[str] = []
    n = len(words)
    i = 0
    while i < n:
        word = words[i]
        base = os.path.basename(word)
        if word == "function":  # function name { ...; } の name を飛ばす
            i += 2
            continue
        if word == "coproc" and i + 2 < n and words[i + 2] in {"{", "("}:  # coproc NAME { ...; } の NAME を飛ばす
            i += 2
            continue
        if ASSIGNMENT.match(word) or word in RESERVED:
            i += 1
            continue
        if base not in WRAPPERS:
            return i, scripts, wrappers
        wrappers.append(base)
        value_flags, positional_count = WRAPPERS[base]
        i += 1
        if base == "flock":  # flock [opts] FILE -c 'cmd' / flock -c 'cmd' FILE / flock FILE cmd...
            k, seen_file = i, False
            while k < n:
                w = words[k]
                if w == "--":
                    break
                if w in value_flags:
                    k += 2
                    continue
                if w.startswith("--command="):
                    scripts.append(w.partition("=")[2])
                    return None, scripts, wrappers
                if (w == "--command" or re.fullmatch(r"-[A-Za-z]*c", w)) and k + 1 < n:
                    scripts.append(words[k + 1])
                    return None, scripts, wrappers
                if w.startswith("-") and len(w) > 1:
                    k += 1
                    continue
                if seen_file:
                    break
                seen_file = True
                k += 1
        while i < n:
            w = words[i]
            if w == "--":
                i += 1
                break
            if len(w) < 2 or not w.startswith("-"):
                break
            if base == "command" and re.fullmatch(r"-[pvV]+", w) and ("v" in w or "V" in w):
                return None, scripts, wrappers  # command -v gh は、場所を調べるだけ
            if w.startswith("--"):
                name, eq, value = w.partition("=")
                if base == "env":
                    name = env_long(name)
                if name in value_flags and not eq:
                    value = words[i + 1] if i + 1 < n else ""
                    i += 1
                if base == "env" and name == "--split-string":
                    scripts.append("env " + value.replace("\\_", " "))  # -S の中の -i / -u も、env のオプション
            else:
                body = w[1:]
                for k, ch in enumerate(body):
                    if "-" + ch not in value_flags:
                        continue
                    glued = body[k + 1 :]
                    if glued:
                        value = glued.lstrip("=")
                    else:
                        value = words[i + 1] if i + 1 < n else ""
                        i += 1
                    if base == "env" and ch == "S":
                        scripts.append("env " + value.replace("\\_", " "))
                    break
            i += 1
        skipped = 0
        while skipped < positional_count and i < n and not words[i].startswith("-"):
            i += 1
            skipped += 1
    return None, scripts, wrappers


def shell_script(args: list[str]) -> tuple[int | None, bool]:
    """シェルの引数から、-c のスクリプトの位置を取り出す。戻り値は (args の位置または None, 標準入力から読むか)。

    -c は -lc / -ec のように、他のオプションと束ねて書ける。-o / -O は値を取る。
    """
    i, n = 0, len(args)
    has_c = has_s = False
    while i < n:
        a = args[i]
        if a == "--":
            i += 1
            break
        if a.startswith("--"):
            i += 2 if a in {"--rcfile", "--init-file"} else 1
            continue
        if a == "-":  # 標準入力から読む
            has_s = True
            i += 1
            continue
        if len(a) > 1 and a[0] in "-+":
            body = a[1:]
            if a[0] == "-":
                has_c = has_c or "c" in body
                has_s = has_s or "s" in body
            i += 2 if body[-1] in "oO" else 1
            continue
        break
    if has_c:
        return (i if i < n else None), False
    return None, (i >= n or has_s or args[i] in STDIN_PATHS)


def c_option_script(args: list[str]) -> int | None:
    """su -c 'cmd' user / script -qc 'cmd' file の、-c のコマンド文字列の位置。"""
    for k, a in enumerate(args):
        is_c = a in {"--command", "--session-command"} or (
            a.startswith("-") and not a.startswith("--") and "c" in a[1:]
        )
        if is_c and k + 1 < len(args):
            return k + 1
    return None


def positionals(args: list[str], value_flags: set[str] | None = None) -> list[str]:
    flags = VALUE_FLAGS if value_flags is None else value_flags
    result: list[str] = []
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg.startswith("-"):
            if "=" not in arg and arg in flags:
                skip = True
            continue
        result.append(arg)
    return result


def unknown_flag_before_group(args: list[str]) -> bool:
    """最初の語（グループ）の前に、値を取るか分からない --フラグ があるか（その次の語が、値かもしれない）。"""
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg.startswith("-"):
            if "=" in arg:
                continue
            if arg in VALUE_FLAGS:
                skip = True
            elif arg.startswith("--") and arg not in BOOLEAN_FLAGS:
                return True
            continue
        return False
    return False


def drop_option_values(args: list[str], shorts: set[str], longs: set[str]) -> list[str]:
    """文章を受け取るオプション（-m / --message など）とその値を除いた引数を返す。"""
    kept: list[str] = []
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg.startswith("--") and len(arg) > 2:
            name, eq, _ = arg.partition("=")
            if name[2:] in longs:
                skip = not eq
                continue
        elif arg.startswith("-") and len(arg) > 1:
            body = arg[1:]
            hit = next((k for k, ch in enumerate(body) if ch in shorts), None)
            if hit is not None:
                skip = hit == len(body) - 1  # 値が次の引数のとき
                continue
        kept.append(arg)
    return kept


def strip_grep_pattern(args: list[str]) -> list[str]:
    """grep / rg の引数から、検索パターンを除く（パターンはファイルではなく、文章）。"""
    value_short = set("efmABCdDgtTjM")
    value_long = {"file", "max-count", "after-context", "before-context", "context", "directories", "devices",
                  "include", "exclude", "exclude-dir", "glob", "type", "type-not"}
    kept: list[tuple[str, bool]] = []  # (引数, 位置引数か)
    has_pattern_option = False
    skip: str | None = None  # 次の引数の扱い: "keep"（残す値）/ "drop"（パターンなので捨てる）
    options_ended = False  # -- の後ろは、- で始まっていても位置引数（grep -v -- -x FILE の -x はパターン、FILE はファイル）
    for arg in args:
        if skip is not None:
            if skip == "keep":
                kept.append((arg, False))
            skip = None
            continue
        if options_ended:
            kept.append((arg, True))
        elif arg == "--":
            options_ended = True
            kept.append((arg, False))
        elif arg.startswith("--") and len(arg) > 2:
            name, eq, _ = arg.partition("=")
            name = name[2:]
            if name == "regexp":
                has_pattern_option = True
                skip = None if eq else "drop"
                continue
            if name == "file":
                has_pattern_option = True
            if name in value_long and not eq:
                skip = "keep"
            kept.append((arg, False))
        elif arg.startswith("-") and len(arg) > 1:
            body = arg[1:]
            hit = next((k for k, ch in enumerate(body) if ch in value_short), None)
            if hit is None:
                kept.append((arg, False))
                continue
            ch, glued = body[hit], hit < len(body) - 1
            if ch in "ef":
                has_pattern_option = True
            if ch == "e":  # -e の値はパターン（ファイル名ではない）
                skip = None if glued else "drop"
                continue
            kept.append((arg, False))
            skip = None if glued else "keep"
        else:
            kept.append((arg, True))
    result: list[str] = []
    dropped = has_pattern_option
    for arg, is_positional in kept:
        if is_positional and not dropped:
            dropped = True  # 最初の位置引数が、検索パターン
            continue
        result.append(arg)
    return result


# --- gh（GitHub CLI）---
# グループごとの「読み取りだけ」のサブコマンド。ここに無いサブコマンドは確認を強制する
GH_READ = {
    "run": {"list", "view", "watch"},
    "workflow": {"list", "view"},
    "pr": {"list", "view", "status", "diff", "checks"},
    "issue": {"list", "view", "status"},
    "repo": {"view", "list", "autolink"},
    "release": {"list", "view"},
    "ruleset": {"list", "view", "check"},
    "cache": {"list"},
    "label": {"list"},
    "secret": {"list"},
    "variable": {"list", "get"},
    "gist": {"list", "view"},
    "project": {"list", "view", "item-list", "field-list"},
    "org": {"list"},
    "ssh-key": {"list"},
    "gpg-key": {"list"},
    "alias": {"list"},
    "extension": {"list", "search", "browse"},
    "codespace": {"list", "view"},
}
# 3 階層の、読み取りだけのコマンド（グループ, サブグループ, 動詞）
GH_READ3 = {
    ("repo", "deploy-key", "list"), ("repo", "autolink", "list"), ("repo", "autolink", "view"),
    ("repo", "gitignore", "list"), ("repo", "gitignore", "view"), ("repo", "license", "list"),
    ("repo", "license", "view"),
}
# 読み取りだけの入口（サブコマンドは見ない）
GH_READ_GROUPS = {"status", "version", "help", "browse", "completion", "search"}
# 読み取り以外は拒否するグループ。コードの実行（extension / alias / codespace）、設定・認証情報・秘密の書き換え
GH_DENY_GROUPS = {"extension", "codespace", "alias", "config", "secret", "variable", "ssh-key", "gpg-key"}
# 組み込みの別名
GH_ALIASES = {"cs": "codespace", "ext": "extension", "extensions": "extension", "rs": "ruleset"}
# 削除・アーカイブ系の動詞（item-delete / delete-asset のように、ハイフンでつながったものを含む）
GH_DESTRUCTIVE = re.compile(r"(?:^|-)(?:delete|remove|archive|transfer|destroy)(?:-|$)")
# 3 階層のコマンド（gh repo deploy-key delete など）を持つグループ
GH_NESTED_GROUPS = {"repo", "project", "release", "codespace", "extension"}
# 値を取るフラグ（グループ・サブコマンドの位置を数えるときに、その値を飛ばす）
GH_VALUE_FLAGS = {
    "-R", "--repo", "-q", "--jq", "-t", "--template", "--json", "-L", "--limit", "-b", "--branch", "-w", "--workflow",
    "-e", "--event", "-u", "--user", "-s", "--status", "-c", "--commit", "-j", "--job", "-X", "--method",
    "-H", "--header", "-f", "-F", "--field", "--raw-field", "--input", "--cache", "-p", "--preview",
}
GH_SHORT_VALUE = {f[1] for f in GH_VALUE_FLAGS if len(f) == 2}
# gh api のフラグのうち、値を取るもの
GH_API_SHORT_VALUE = {"X", "f", "F", "H", "q", "t", "p"}
GH_API_LONG_VALUE = {
    "--method", "--field", "--raw-field", "--header", "--input", "--jq", "--template", "--preview", "--cache",
    "--hostname",
}
GH_API_FIELD_FLAGS = {"-f", "-F", "--field", "--raw-field"}
# 文章を受け取るオプション（認証情報の置き場の検査から外す）
GH_TEXT_SHORT = {"S", "b", "t", "n"}
GH_TEXT_LONG = {"search", "body", "title", "subject", "notes", "comment"}


def gh_positionals(args: list[str]) -> list[tuple[int, str]]:
    """フラグとその値を除いた語を、(args の位置, 語) で返す。"""
    words: list[tuple[int, str]] = []
    skip = False
    for index, arg in enumerate(args):
        if skip:
            skip = False
            continue
        if arg.startswith("--"):
            if "=" not in arg and arg in GH_VALUE_FLAGS:
                skip = True
        elif arg.startswith("-") and len(arg) > 1:
            body = arg[1:]
            hit = next((k for k, ch in enumerate(body) if ch in GH_SHORT_VALUE), None)
            if hit is not None and hit == len(body) - 1:
                skip = True
        else:
            words.append((index, arg))
    return words


def graphql_code(query: str) -> str:
    """GraphQL の文書から、文字列リテラルとコメントを除く（その中の mutation という語は、書き込みではない）。"""
    # 1 回の走査で読む（コメントの中の " は文字列の始まりではなく、文字列の中の # はコメントではない）
    return re.sub(
        r'#[^\r\n]*|"""(?:\\"""|[\s\S])*?"""|"(?:\\.|[^"\\])*"',
        lambda m: "" if m.group(0).startswith("#") else '""',
        query,
    )


def classify_gh_api(rest: list[str]) -> Finding | None:
    """gh api: GET（と読み取りの GraphQL）だけ通す。書き込みは確認、削除・任意の URL・HTTP の詳細出力は拒否する。"""
    method: str | None = None
    has_fields = has_input = False
    fields: list[str] = []
    headers: list[str] = []
    endpoint: str | None = None
    n = len(rest)
    i = 0
    while i < n:
        arg = rest[i]
        name: str | None = None
        value = ""
        if arg == "--verbose" or arg.startswith("--verbose="):
            return Finding("deny", "gh api --verbose（HTTP の詳細出力）は、認証ヘッダを含みうるので使えません。")
        if arg.startswith("--") and len(arg) > 2:
            flag, eq, inline = arg.partition("=")
            if flag in GH_API_LONG_VALUE:
                name = flag
                if eq:
                    value = inline
                else:
                    value = rest[i + 1] if i + 1 < n else ""
                    i += 1
        elif arg.startswith("-") and len(arg) > 1:
            body = arg[1:]  # -i のような真偽値のフラグは、-iXDELETE のように値を取るフラグと束ねて書ける
            for k, ch in enumerate(body):
                if ch not in GH_API_SHORT_VALUE:
                    continue
                name = "-" + ch
                glued = body[k + 1 :]
                if glued:
                    value = glued[1:] if glued.startswith("=") else glued  # -XDELETE / -X=DELETE
                else:
                    value = rest[i + 1] if i + 1 < n else ""
                    i += 1
                break
        elif endpoint is None:
            endpoint = arg
        i += 1

        if name in {"-X", "--method"}:
            method = value.upper()
        elif name in GH_API_FIELD_FLAGS:
            has_fields = True
            fields.append(value)
        elif name in {"-H", "--header"}:
            headers.append(value)
        elif name == "--input":
            has_input = True

    if any(re.search(r"(?i)method-override|x-http-method", h) for h in headers):
        return Finding("ask", "gh api の HTTP メソッドを上書きするヘッダがあります。内容を確認してください。")

    if endpoint is None:
        return None
    if re.match(r"(?i)https?://", endpoint):
        return Finding("deny", "gh api に URL は指定できません（認証つきで任意のホストへ送りうるため）。パスで指定してください。")
    path = endpoint.split("?", 1)[0].strip().removeprefix("./").strip("/").lower()
    if path == "graphql":
        queries = [v.partition("=")[2] for v in fields if v.partition("=")[0] == "query"]
        if any(re.search(r"\bmutation\b", graphql_code(q), re.I) for q in queries):
            return Finding("deny", "GraphQL の mutation（書き込み）は許可していません。必要ならユーザーが実行します。")
        dynamic = any(re.search(r"\$\(|`", q) or re.fullmatch(r"\$\{?\w+\}?", q) for q in queries)
        if has_input or dynamic or any(q.startswith("@") for q in queries):
            return Finding("ask", "GraphQL のクエリを、ファイルやコマンドの出力から読んでいます。内容を確認してください。")
        return None
    if method == "DELETE":
        return Finding("deny", "gh api の DELETE は許可していません。必要ならユーザーが実行します。")
    if method and method != "GET":
        return Finding("ask", f"gh api の書き込み（{method}）です。内容を確認してください。")
    if method is None and (has_fields or has_input):
        return Finding("ask", "gh api にフィールド（-f / -F / --input）があるので、POST になります。内容を確認してください。")
    return None


def classify_gh(args: list[str]) -> Finding | None:
    for arg in args:
        if arg == "--hostname" or arg.startswith("--hostname="):
            return Finding("deny", "gh の --hostname は、トークンを別のホストへ送りうるので使えません。")
    positional = gh_positionals(args)
    words = [w for _, w in positional]
    if not words:
        return None  # gh --version など
    group = GH_ALIASES.get(words[0], words[0])
    sub = words[1] if len(words) > 1 else ""
    if sub == "ls":
        sub = "list"
    if group == "api":
        return classify_gh_api(args[positional[0][0] + 1 :])
    if group == "auth":
        # gh auth status は、引数なし（と --active）だけ通す。-t / --show-token（トークンの表示）、-h（ホストの指定）、
        # --json などは、-at のように他のフラグと束ねて書けるので、許可するものだけを数える
        extra = [a for a in args if a not in {"auth", "status", "-a", "--active"}]
        if sub == "status" and not extra:
            return None
        return Finding(
            "deny", "gh auth の操作（ログイン・トークンの取得・切り替え）は私には許可していません。必要ならユーザーが実行します。"
        )
    if group in GH_READ_GROUPS:
        return None
    scope = words[:2]
    if group in GH_NESTED_GROUPS and (sub not in GH_READ.get(group, ()) or sub == "autolink"):
        scope = words[:3]
    if any(GH_DESTRUCTIVE.search(w) for w in scope):
        return Finding("deny", f"gh の削除・アーカイブ系の操作（gh {group} {sub}）は許可していません。必要ならユーザーが実行します。")
    if sub in GH_READ.get(group, ()) and sub != "autolink":
        return None
    if len(words) > 2 and (group, sub, words[2]) in GH_READ3:
        return None
    if group == "repo" and sub == "set-default" and "--view" in args:
        return None
    if group in GH_DENY_GROUPS:
        return Finding(
            "deny", f"gh {group} {sub} は、コードの実行や、設定・認証情報・秘密の書き換えにつながるため許可していません。"
        )
    return Finding("ask", f"gh の書き込み系、または未知の操作の可能性があります。内容を確認してください: gh {group} {sub}".rstrip())


def git_subcommand_index(args: list[str]) -> int | None:
    """git のグローバルオプション（-C / -c ...）を飛ばして、最初のサブコマンドの位置を返す。"""
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}:
            i += 2
        elif arg.startswith("-"):
            i += 1
        else:
            return i
    return None


def git_subcommand(args: list[str]) -> str | None:
    """git のグローバルオプション（-C / -c ...）を飛ばして、最初のサブコマンドを返す。"""
    at = git_subcommand_index(args)
    return args[at] if at is not None else None


def takes_value(cli: str, flag: str) -> bool:
    """この CLI のフラグが、次の引数を値として取るか（--help が値かどうかを見分けるのに使う）。"""
    if "=" in flag or not flag.startswith("-"):
        return False
    if cli == "gh":
        return (
            flag in GH_VALUE_FLAGS or flag in GH_API_LONG_VALUE
            or (flag.startswith("--") and flag[2:] in GH_TEXT_LONG)
            or (len(flag) == 2 and flag[1] in GH_SHORT_VALUE | GH_API_SHORT_VALUE | GH_TEXT_SHORT)
        )
    return flag in (KUBECTL_VALUE_FLAGS if cli == "kubectl" else VALUE_FLAGS)


def wants_help(cli: str, args: list[str]) -> bool:
    """--help / -h が、ヘルプの要求か（直前のフラグの値として渡された --help は、ヘルプではない）。"""
    short_help = cli in {"gcloud", "kubectl", "terraform", "tofu"}
    if cli == "gh":  # gh auth / gh config では、-h は --hostname / --host の短縮形（ヘルプではない）
        words = [w for _, w in gh_positionals(args)]
        short_help = bool(words) and words[0] not in {"auth", "config"}
    for k, arg in enumerate(args):
        if arg == "--":  # kubectl exec pod -- psql -h host の -h は、リモートのコマンドのオプション
            break
        if arg == "--help" or (arg == "-h" and short_help):
            if k == 0 or not takes_value(cli, args[k - 1]):
                return True
    return False


def verb_kind(pos: list[str]) -> str | None:
    """gcloud の語のうち、グループの後で最初に出る動詞が、読み取り（"read"）か書き込み（"write"）か。"""
    for word in pos[1:]:
        if word in DESTRUCTIVE or word in WRITE_VERBS or word.startswith(WRITE_PREFIXES):
            return "write"
        if word in READ_VERBS or word.startswith(("list", "describe", "get-", "search")):
            return "read"
    return None


def classify_cli(cli: str, args: list[str]) -> Finding | None:
    for arg in args:
        name = arg.split("=", 1)[0]
        if name in IDENTITY_FLAGS:
            return Finding("deny", f"ID を切り替えるフラグ（{name}）は使えません。ID の切り替えは、ユーザーが行います。")
    if wants_help(cli, args):
        return None  # ヘルプの表示は、何も実行しない
    if cli == "gh":
        return classify_gh(args)
    pos = positionals(args, KUBECTL_VALUE_FLAGS if cli == "kubectl" else None)
    if pos and pos[0] in RELEASE_TRACKS and len(pos) > 1:
        pos = pos[1:]  # gcloud beta run ... は、beta を飛ばして見る
    if not pos:
        return None
    group, verbs = pos[0], set(pos)

    if cli == "gcloud":
        if group == "auth":
            if pos[:2] == ["auth", "list"]:
                return None
            # 許すのは、引数なしのログイン起動（承認はユーザーがブラウザーで行うので、毎回確認も挟む）と、全員のログアウトだけ。
            # --no-launch-browser や --account などの付いた形、トークンの取得・切り替えは、これまでどおり拒否する
            if args == ["auth", "login"]:
                return Finding("ask", "gcloud auth login を起動します。ブラウザーでのアカウントの選択と承認は、ユーザーが行います。")
            if args == ["auth", "revoke", "--all"]:
                return None
            return Finding(
                "deny", "gcloud auth の操作（ログイン・トークンの取得・切り替え）は私には許可していません。必要ならユーザーが実行します。"
            )
        if group == "config":
            ok = pos[1:2] and pos[1] in {"list", "get-value", "get"} or pos[1:3] in (["configurations", "list"], ["configurations", "describe"])
            return None if ok else Finding("deny", "gcloud config の変更（アカウント・プロジェクト・なりすましの設定）は許可していません。")
        if (group in {"help", "topic"} or (group in {"version", "info", "feedback"} and len(pos) == 1)) and (
            not unknown_flag_before_group(args)
        ):
            return None  # gcloud --trace-token help run services delete x の help は、フラグの値かもしれない
        if group == "components":
            return None if pos[1:2] == ["list"] else Finding("ask", "gcloud components の変更は確認が必要です。")
        if "secrets" in verbs and "access" in verbs:
            return Finding("deny", "Secret Manager の値の取得は許可していません。")
        if "keys" in verbs and "create" in verbs:
            return Finding("deny", "サービスアカウントキーの作成は許可していません。")
        if any(SECRET_GETTER.fullmatch(v) for v in verbs):  # api-keys get-key-string / redis instances get-auth-string
            return Finding("deny", "キー・認証文字列の値を表示する操作は許可していません。必要ならユーザーが実行します。")
    elif cli == "gsutil":
        if group in {"rm", "rb", "rsync", "acl", "iam", "defacl", "setmeta"}:
            return Finding("deny", f"gsutil {group} は許可していません。必要ならユーザーが実行します。")
        return None if group in {"ls", "cat", "stat", "du", "version", "help", "hash"} else Finding("ask", "gsutil の書き込み系は確認が必要です。")
    elif cli == "bq":
        if group in {"rm", "mk", "update", "cp", "load", "insert"}:
            return Finding("deny" if group == "rm" else "ask", f"bq {group} は確認が必要です。")
        return None if group in {"ls", "show", "head", "version", "help", "info"} else Finding("ask", "bq の操作は確認が必要です。")
    elif cli in {"terraform", "tofu"}:
        if group == "destroy":
            return Finding("deny", "terraform destroy は許可していません。必要ならユーザーが実行します。")
        if (group in {"state", "workspace"} and pos[1:2] in (["list"], ["show"])) or (group == "providers" and len(pos) == 1):
            return None  # 状態・ワークスペース・プロバイダーの一覧（読み取り）
        return None if group in {"plan", "validate", "fmt", "show", "version", "output", "graph"} else Finding(
            "ask", f"{cli} {group} は確認が必要です。"
        )
    elif cli == "kubectl":
        for arg in args:
            if arg == "--":
                break
            flag = arg.split("=", 1)[0]
            if flag in KUBECTL_IDENTITY_FLAGS:
                return Finding("deny", f"ID を切り替えるフラグ（{flag}）は使えません。ID の切り替えは、ユーザーが行います。")
            if flag in KUBECTL_TARGET_FLAGS:
                return Finding("ask", f"接続先や資格情報を変えるフラグ（{flag}）です。内容を確認してください。")
        if group in {"delete", "drain", "replace"}:
            return Finding("deny", f"kubectl {group} は許可していません。必要ならユーザーが実行します。")
        if group in {"get", "describe"} and any(
            re.search(r"(?:^|/)secrets?(?:\.[\w.]+)?(?:/|$)", part)  # secrets / Secret/x / secrets.v1 / --raw /api/v1/.../secrets
            for p in pos[1:]
            for part in p.lower().split(",")
        ):
            return Finding("ask", "kubectl で Secret の値を読み出す操作です。内容を確認してください。")
        if (group == "config" and pos[1:2] in (["current-context"], ["get-contexts"])) or (
            group == "rollout" and pos[1:2] in (["status"], ["history"])
        ) or (group == "auth" and pos[1:2] == ["can-i"]):
            return None  # 現在の設定・ロールアウトの状態・権限の確認（読み取り）
        return None if group in {"get", "describe", "logs", "top", "version", "explain", "api-resources", "cluster-info"} else Finding(
            "ask", f"kubectl {group} は確認が必要です。"
        )

    # gcloud の一般則
    if verbs & DESTRUCTIVE:
        return Finding("deny", f"破壊的・権限変更の操作（{', '.join(sorted(verbs & DESTRUCTIVE))}）は許可していません。必要ならユーザーが実行します。")
    kind = verb_kind(pos)
    if cli == "gcloud" and group in SENSITIVE_GROUPS:
        return None if kind == "read" else Finding("deny", f"gcloud {group} の変更は許可していません。必要ならユーザーが実行します。")
    if kind == "read":
        return None
    return Finding("ask", f"{cli} の書き込み系の可能性がある操作です。内容を確認してください: {cli} {' '.join(pos[:4])}")


# --- 解析 ---


def text_arguments(args: list[str]) -> list[str]:
    """echo / printf の引数のうち、先頭のオプション（-e / -n）を除いた文章。"""
    k = 0
    while k < len(args) and re.fullmatch(r"-[neE]+", args[k]):
        k += 1
    return args[k:]


def produced_texts(unit: Unit) -> list[str]:
    """このコマンドが標準出力へ流す文章（echo / printf の引数、ヒアドキュメント、ヒアストリング）。"""
    texts = [t.replace("\\n", "\n") for t in [h.body for h in unit.heredocs] + list(unit.herestrings)]
    index, _, _ = resolve_program(unit.words)
    if index is not None and os.path.basename(unit.words[index]) in TEXT_ONLY:
        args = [printf_unescape(a) for a in text_arguments(unit.words[index + 1 :])]
        texts += args
        if len(args) > 1:
            texts.append(" ".join(args))
    return texts


IDENTITY_DROP = Finding(
    "deny",
    "日常の ID を固定している環境変数を外す・引き継がない実行（env -u / env -i / unset / sudo / su -l など）は"
    "許可していません。書き込みが必要なら、ユーザーが実行します。",
)


def env_changes(words: list[str]) -> tuple[list[str], bool]:
    """env / exec のオプションで、外される環境変数の名前と、環境全体を空にするか（env -i / env - / exec -c）。"""
    names: list[str] = []
    clears = False
    n = len(words)
    for k, word in enumerate(words):
        base = os.path.basename(word)
        if base not in {"env", "exec"}:
            continue
        i = k + 1
        while i < n:
            w = words[i]
            if w == "--":
                break
            if w == "-" and base == "env":
                clears = True
            elif w.startswith("--"):
                name, eq, value = w.partition("=")
                name = env_long(name) if base == "env" else name
                if base == "env" and name == "--ignore-environment":
                    clears = True
                elif base == "env" and name == "--unset":
                    names.append(value if eq else (words[i + 1] if i + 1 < n else ""))
                    i += 0 if eq else 1
                elif base == "env" and name in {"--chdir", "--split-string", "--argv0"} and not eq:
                    i += 1
            elif w.startswith("-") and len(w) > 1:
                body = w[1:]
                for pos, ch in enumerate(body):
                    glued = body[pos + 1 :]
                    if (base == "env" and ch == "i") or (base == "exec" and ch == "c"):
                        clears = True
                    elif base == "env" and ch == "u":
                        names.append(glued if glued else (words[i + 1] if i + 1 < n else ""))
                        i += 0 if glued else 1
                        break
                    elif (base == "env" and ch in "CSaP") or (base == "exec" and ch == "a"):
                        i += 0 if glued else 1
                        break
            elif not ASSIGNMENT.match(w):
                break
            i += 1
    return names, clears


# python3 -m で、標準入力のコードを実行するモジュール
STDIN_EXEC_MODULES = {"code", "codeop", "pdb", "ipdb", "runpy", "idlelib", "IPython", "ipython"}
STDIN_SCRIPT_FLAGS = {"-", "-u", "-B", "-I", "-E", "-s", "-S"}  # インタープリタが標準入力のスクリプトを読む（引数が無い）形
OPAQUE_STDIN = Finding(
    "ask", "標準入力から読むスクリプトの出どころ（他のコマンドの出力）を検査できません。内容を確認してください。"
)


def passes_text_through(stage: Unit) -> bool:
    """この段が持つ文章（echo / printf の引数・ヒアドキュメント・ヒアストリング）を、そのまま出力に流すか。
    echo / printf / cat / tee と、コマンドが無い（ヒアドキュメントだけ）ものは流す。base64 -d <<< ... のような変換は、流さない。"""
    words, _, _ = split_ifs(stage)
    index, _, _ = resolve_program(words)
    name = os.path.basename(words[index]) if index is not None else ""
    return index is None or name in TEXT_ONLY or name in {"cat", "tee"}


def stdin_source(unit: Unit, units: list[Unit], idx: int) -> str:
    """このコマンドが標準入力で受け取る文章の出どころ。

    "literal"（ヒアドキュメント・echo / printf の文章）、"opaque"（ほかのコマンドの出力。中身は検査できない）、
    "none"（パイプで受け取らない）。tee と、引数の無い cat は、入力をそのまま流すだけなので飛ばす。
    """
    if unit.heredocs or unit.herestrings:
        return "literal"
    j = idx
    while j > 0 and units[j].before in PIPES:
        j -= 1
        stage = units[j]
        words, _, _ = split_ifs(stage)
        index, _, _ = resolve_program(words)
        name = os.path.basename(words[index]) if index is not None else ""
        if produced_texts(stage):
            # echo / printf / cat / tee は、文章をそのまま流す。base64 -d <<< ... のような変換は、流す中身が違う
            return "literal" if passes_text_through(stage) else "opaque"
        if name == "tee" or (name == "cat" and all(w.startswith("-") for w in words[index + 1 :])):
            continue
        return "opaque"
    return "none"


def drop_arg_pairs(args: list[str], options: set[str]) -> list[str]:
    """--arg NAME VALUE のように、名前と値の 2 つを取るオプションを、引数ごと除く。"""
    kept: list[str] = []
    skip = 0
    for arg in args:
        if skip:
            skip -= 1
            continue
        if arg in options:
            skip = 2
            continue
        kept.append(arg)
    return kept


def printf_unescape(text: str) -> str:
    """printf / echo -e のエスケープ（\\n \\t \\xHH \\0NNN など）を解釈する。"""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        if text[i] == "\\" and i + 1 < n:
            char, i = _ansi_escape(text, i)
            out.append(char)
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


_IFS = re.compile(r"\$\{IFS(?:[:%#/^,@\[][^}]*)?\}|\$IFS(?![A-Za-z0-9_])")


def split_ifs_full(unit: Unit) -> tuple[list[str], list[bool], list[bool], list[str]]:
    """${IFS} / $IFS / ${IFS:0:1} でつないだ語を、空白で区切られた語として分ける（words と同じ並びの dynamic・plain・
    引用符の位置も返す）。"""
    n = len(unit.words)
    flags = unit.dynamic if len(unit.dynamic) == n else [False] * n
    plains = unit.plain if len(unit.plain) == n else [False] * n
    quotes = unit.masks if len(unit.masks) == n else [""] * n
    words: list[str] = []
    dynamic: list[bool] = []
    plain: list[bool] = []
    masks: list[str] = []
    for word, flag, is_plain, mask in zip(unit.words, flags, plains, quotes):
        spans: list[tuple[int, int]] = []
        if "IFS" in word:
            pos = 0
            for m in _IFS.finditer(word):
                if m.start() > pos:
                    spans.append((pos, m.start()))
                pos = m.end()
            if pos < len(word):
                spans.append((pos, len(word)))
        if len(spans) > 1 or (spans and spans[0] != (0, len(word))):
            for a, b in spans:
                words.append(word[a:b])
                dynamic.append(flag)
                plain.append(is_plain)
                masks.append(mask[a:b] if len(mask) == len(word) else "")
        else:
            words.append(word)
            dynamic.append(flag)
            plain.append(is_plain)
            masks.append(mask)
    return words, dynamic, plain, masks


def split_ifs(unit: Unit) -> tuple[list[str], list[bool], list[bool]]:
    """split_ifs_full の、words・dynamic・plain だけ。"""
    words, dynamic, plain, _ = split_ifs_full(unit)
    return words, dynamic, plain


BRACE_LIMIT = 64  # 1 つの語のブレース展開で作る語の上限
MAX_WORDS = 512  # 展開後の 1 コマンドの語数の上限
MAX_VALUES = 32  # 1 つの変数について覚える代入値の数
MAX_VARIANTS = 64  # 1 コマンドで試す、変数の値の組み合わせの数
# 上の上限で候補を切り捨てたら、黙って落とさず、確認にする（最後の代入・後ろの語に、実行されるものがありうる）
_capped: list[str] = []
# ${name} ${name:-既定値} ${name:+値} ${name:オフセット:長さ}、${1} ${@}、$name。
# グループ: 1 名前 / 2 演算子（- = +）/ 3 既定値・代替値 / 4・5 オフセット・長さ / 6 素の名前
_PARAM = re.compile(
    r"\$(?:\{([A-Za-z_]\w*|\d+|[@*])(?::?([-=+])([^}$`]*)|:(\d+)(?::(\d+))?)?\}|([A-Za-z_]\w*|[@*0-9]))"
)
_BRACE_MARKS = str.maketrans({"{": "\x02", "}": "\x03", ",": "\x04"})
_BRACE_UNMARKS = str.maketrans({"\x02": "{", "\x03": "}", "\x04": ","})


def _param_name(m: re.Match[str]) -> str:
    return m.group(1) or m.group(6)


def _param_value(m: re.Match[str], value: str) -> str:
    """変数が設定されているときの展開。${g:0:2} は部分文字列、${x:+alt} は alt、それ以外は値そのもの。"""
    if m.group(2) == "+" and m.group(3) is not None:
        return m.group(3)
    if m.group(4) is not None:
        start = int(m.group(4))
        return value[start : start + int(m.group(5))] if m.group(5) is not None else value[start:]
    return value


# 空白で分ける（$(which gh) のコマンド置換は、中の空白で分けない）
_WORD_SPLIT = re.compile(r"(?:\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\S)+")


def brace_expand(word: str, mask: str = "") -> list[str]:
    """語の {a,b} / pre{a,b}post / 入れ子を展開する。カンマの無い {} と ${...} は、そのまま。
    mask（語と同じ長さの 0/1）の 1 の文字は引用符の中なので、{ } , として働かない（{gh,"run"} の "run" は展開される）。"""
    out: list[str] = []
    if len(mask) == len(word):
        word = "".join(ch.translate(_BRACE_MARKS) if q == "1" else ch for ch, q in zip(word, mask))

    def walk(current: str) -> None:
        if len(out) >= BRACE_LIMIT:
            if "capped" not in _capped:
                _capped.append("capped")
            return
        i, n = 0, len(current)
        while i < n:
            if current[i] == "{" and (i == 0 or current[i - 1] != "$"):
                depth, commas, j = 0, [], i
                while j < n:
                    c = current[j]
                    if c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                        if depth == 0:
                            break
                    elif c == "," and depth == 1:
                        commas.append(j)
                    j += 1
                if j < n and commas:
                    bounds = [i] + commas + [j]
                    for a, b in zip(bounds, bounds[1:]):
                        walk(current[:i] + current[a + 1 : b] + current[j + 1 :])
                    return
            i += 1
        out.append(current)

    walk(word)
    return [piece.translate(_BRACE_UNMARKS) for piece in (out[:BRACE_LIMIT] or [word])]


def resolve_params(value: str, variables: dict[str, list[str]]) -> str:
    """値の中の $name を、覚えている最後の代入値で置き換える（知らない名前は、そのまま）。"""
    return _PARAM.sub(lambda m: (variables.get(_param_name(m)) or [m.group(0)])[-1], value)


def persistent_assignments(unit: Unit) -> list[str]:
    """このコマンドが、後のコマンドにも残る形で代入する変数名（NAME=値 / export NAME=値。VAR=値 cmd は含まない）。"""
    words, _, _ = split_ifs(unit)
    index, _, _ = resolve_program(words)
    if index is None:
        assigned = words
    elif os.path.basename(words[index]) in ASSIGNING_BUILTINS:
        assigned = words[index + 1 :]
    else:
        return []
    return [m.group(1) for w in assigned if (m := ASSIGNMENT.match(w))]


def collect_variables(units: list[Unit], inherited: dict[str, list[str]]) -> dict[str, list[str]]:
    """このスクリプトで代入された変数（name=値 / export name=値 / for name in 値...）の候補。後で $name を展開して調べる。"""
    variables = {k: list(v) for k, v in inherited.items()}

    def add(name: str, value: str) -> None:
        values = variables.setdefault(name, [])
        if value in values:
            return
        if len(values) < MAX_VALUES:
            values.append(value)
        elif "capped" not in _capped:
            _capped.append("capped")

    def resolved(value: str) -> str:
        return resolve_params(value, variables)

    for unit in units:
        words, _, _ = split_ifs(unit)
        if len(words) >= 4 and words[0] in {"for", "select"} and words[2] == "in" and re.fullmatch(r"[A-Za-z_]\w*", words[1]):
            for value in words[3:]:
                add(words[1], resolved(value))
            continue
        index, _, _ = resolve_program(words)
        if index is None:
            assigned = words
        elif os.path.basename(words[index]) in ASSIGNING_BUILTINS:
            assigned = words[index + 1 :]
        else:
            continue  # VAR=値 cmd の VAR は、そのコマンドの環境だけに入る（同じコマンドの引数の $VAR には効かない）
        for word in assigned:
            m = ASSIGNMENT.match(word)
            if m:
                value = resolved(word[m.end() :])
                if word[m.end() - 2] == "+":  # g+=h は、今の値の後ろに足す
                    for previous in list(variables.get(m.group(1), [])) or [""]:
                        add(m.group(1), previous + value)
                else:
                    add(m.group(1), value)
    return variables


def expand_words(unit: Unit, variables: dict[str, list[str]]) -> list[tuple[list[str], list[bool]]]:
    """このコマンドの語を、実行時の姿の候補に展開する（IFS・ブレース・${x:-既定値}・代入済みの変数）。"""
    words, dynamic, plain, masks = split_ifs_full(unit)

    def braced(w: str, p: bool, mask: str) -> bool:
        if "{" not in w or "," not in w:
            return False
        if len(mask) == len(w):  # 引用符の外の { と , があるか
            return any(c == "{" and q == "0" for c, q in zip(w, mask)) and any(
                c == "," and q == "0" for c, q in zip(w, mask)
            )
        return p

    unexpanded: list[tuple[list[str], list[bool]]] = []  # 展開しない姿も調べる（見える範囲は落とさない）
    if any(braced(w, p, m) for w, p, m in zip(words, plain, masks)):
        unexpanded.append((words, dynamic))
        out_w: list[str] = []
        out_d: list[bool] = []
        out_p: list[bool] = []
        for w, d, p, m in zip(words, dynamic, plain, masks):
            for piece in brace_expand(w, m) if braced(w, p, m) else [w]:
                out_w.append(piece)
                out_d.append(d)
                out_p.append(p)
        if len(out_w) > MAX_WORDS and "capped" not in _capped:
            _capped.append("capped")
        words, dynamic, plain = out_w[:MAX_WORDS], out_d[:MAX_WORDS], out_p[:MAX_WORDS]
    if not any("$" in w for w in words):
        return [(words, dynamic)] + unexpanded
    known: list[str] = []
    for w in words:
        for m in _PARAM.finditer(w):
            name = _param_name(m)
            if variables.get(name) and name not in known:
                known.append(name)
    combos: list[dict[str, str]] = [{}]
    for name in known:
        combos = [{**c, name: v} for c in combos for v in variables[name]]
        if len(combos) > MAX_VARIANTS:
            if "capped" not in _capped:
                _capped.append("capped")
            combos = combos[:MAX_VARIANTS]
    results: list[tuple[list[str], list[bool]]] = []
    for combo in combos:
        def replace(m: re.Match[str]) -> str:
            name = _param_name(m)
            if name in combo:
                return _param_value(m, combo[name])
            return m.group(3) if m.group(3) is not None else m.group(0)

        new_words: list[str] = []
        new_dynamic: list[bool] = []
        for w, d, p in zip(words, dynamic, plain):
            expanded = _PARAM.sub(replace, w) if "$" in w else w
            parts = _WORD_SPLIT.findall(expanded) if (p and expanded != w) else [expanded]
            new_words += parts
            new_dynamic += [d] * len(parts)
        results.append((new_words[:MAX_WORDS], new_dynamic[:MAX_WORDS]))
    results.append((words, dynamic))  # 変数を展開しない姿も調べる（変数の値が実行時に違っても、見える範囲は落とさない）
    # 未設定の変数は空になる（g${x}h run delete 1 が gh run delete 1 になる）。知らない変数を空にした姿も調べる
    if any(_param_name(m) not in variables for w in words for m in _PARAM.finditer(w)):
        emptied: list[str] = []
        emptied_dynamic: list[bool] = []
        for w, d, p in zip(words, dynamic, plain):
            text = _PARAM.sub(
                lambda m: m.group(0)
                if _param_name(m) in variables
                else ("" if m.group(2) == "+" else (m.group(3) or "")),
                w,
            )
            parts = _WORD_SPLIT.findall(text) if (p and text != w) else [text]
            emptied += parts
            emptied_dynamic += [d] * len(parts)
        results.append((emptied[:MAX_WORDS], emptied_dynamic[:MAX_WORDS]))
    return results + unexpanded


# シェルが後で評価する値（PROMPT_COMMAND はコマンド、PS0 / PS1 / PS2 / PS4 は中の $(...)）。代入した時点で調べる
EVALUATED_ENV = re.compile(r"^(PROMPT_COMMAND|PS[0124])$")
# 引数の文字列の先頭にある、「この後ろをコマンドとして実行する」印（vim の !、psql の \!、sqlite3 の .shell、
# gdb の shell、git の ext:: トランスポート、less の LESSOPEN の | など）
_MARKER = re.compile(r"^(?:!+|\|+-?|ext::|\.shell\s+|\.system\s+|\\!\s*|:!\s*|(?:shell|system|exec|spawn|popen)\s+)\s*")


def embedded_command(arg: str) -> str | None:
    """引数が、CLI で始まるコマンドライン（git -c alias.x=!gh ... / --command='gh ...' / VAR='gh ...'）なら、その文字列。

    「この後ろを実行する」印（!, \\!, .shell, ext:: ...）の後ろは、CLI で始まっていなくても（sh -c "gh ..." など）、
    CLI の名前が見えれば返す。
    """
    value = arg.replace("${IFS}", " ")
    match = _CMDLINE_PREFIX.match(value)
    if match:
        value = value[match.end() :]
    marked = False
    while True:
        marker = _MARKER.match(value)
        if not marker:
            break
        value, marked = value[marker.end() :], True
    glued = _GLUED_SHORT.match(value)
    if glued:
        value = value[glued.end() :]
    if _CMDLINE.match(value) or _GIT_CREDENTIAL.match(value):
        return value
    return value if marked and CLI_WORD.search(value) else None


def xargs_inputs(prefix: list[str], produced: str) -> list[list[str]]:
    """xargs が、標準入力の文章を CLI の引数に分ける方法の候補（全体・1 行ずつ・-n N 語ずつ・-L N 行ずつ）。"""
    words = produced.split()
    lines = [line.split() for line in produced.splitlines() if line.split()]
    groups = [words] + lines
    size = line_count = 0
    for k, word in enumerate(prefix):
        following = prefix[k + 1] if k + 1 < len(prefix) else ""
        m = re.fullmatch(r"-n(\d+)|--max-args=(\d+)|-[Ll](\d+)|--max-lines=(\d+)", word)
        if m:
            size = int(m.group(1) or m.group(2) or 0) or size
            line_count = int(m.group(3) or m.group(4) or 0) or line_count
        elif word in {"-n", "--max-args"} and following.isdigit():
            size = int(following)
        elif word in {"-L", "-l", "--max-lines"} and following.isdigit():
            line_count = int(following)
    if size > 0:
        groups += [words[k : k + size] for k in range(0, len(words), size)]
    if line_count > 0:
        groups += [[w for line in lines[k : k + line_count] for w in line] for k in range(0, len(lines), line_count)]
    return groups[:200]


def normalized_path(word: str) -> str | None:
    """絶対パス・~・$HOME で始まる語を、展開して正規化する（// ・ /./ ・ .. を畳む）。パスでなければ None。"""
    w = word
    for ref in ("${HOME}", "$HOME"):
        if w.startswith(ref):
            w = "~" + w[len(ref):]
    if not (w.startswith("/") or w.startswith("~")):
        return None
    path = posixpath.normpath(os.path.expanduser(w))
    if path.startswith("//"):  # normpath は、先頭のちょうど 2 つの / だけを畳まない（POSIX では実装定義）。Linux では / と同じ
        path = "/" + path.lstrip("/")
    # /proc/self/root は、自分のルートディレクトリを指す別名（重ねて書いても同じ）
    return re.sub(r"^(?:/proc/(?:self|thread-self)/root)+(?=/|$)", "", path) or "/"


def _glob_components(pattern: list[str], path: list[str]) -> bool:
    """グロブの各成分を、パスの先頭から成分ごとに照合する（* や ? は、先頭が . の名前に一致しない）。"""
    if len(pattern) > len(path):
        return False
    for pat, name in zip(pattern, path):
        if name.startswith(".") and not pat.startswith("."):
            return False
        if not fnmatch.fnmatchcase(name, pat):
            return False
    return True


def touches_protected_path(word: str) -> bool:
    """語が、認証情報のディレクトリ・ファイルを指すか（~ / $HOME の展開、パスの正規化、グロブも照合）。"""
    w = normalized_path(word)
    if w is None:
        return False
    if any(ch in w for ch in "*?["):
        parts = w.split("/")
        # グロブが認証情報のディレクトリ以下（またはそのもの）に一致しうるか。~/* の * は、.config に一致しない
        for d in PROTECTED_DIRS:
            d_parts = d.split("/")
            if len(parts) >= len(d_parts) and _glob_components(parts[: len(d_parts)], d_parts):
                return True
        return False
    return any(w == d or w.startswith(d + "/") for d in PROTECTED_DIRS)


def covers_protected_dirs(program: str, word: str) -> bool:
    """コピー・検索・移動の対象が、認証情報のディレクトリを含む上位のディレクトリ（~/.config など）か。"""
    w = normalized_path(word)
    if w is None:
        return False
    config_dirs = {h + "/.config" for h in HOME_DIRS}
    if any(ch in w for ch in "*?["):  # grep -r x ~/.c* のような、~/.config に一致しうるグロブ
        parts = w.split("/")
        return any(_glob_components(parts, c.split("/")) for c in config_dirs)
    if program in {"cd", "pushd"}:  # cd ~ は普通に使う。~/.config から相対パスで開くのを防ぐ
        return w in config_dirs
    return w in config_dirs | HOME_DIRS | {"/", "/home"}


def credential_hit(words: list[str]) -> str | None:
    """認証情報の検査に当たった最初の語（無ければ None）。理由に出す用で、CREDENTIAL_DENY の条件と同じ。"""
    for word in words:
        m = CREDENTIAL_TEXT.search(word)
        if m:
            return m.group(0)  # 語全体ではなく、一致した部分だけ（引数の値を理由に写さない）
        if touches_protected_path(word):
            return word  # パスとして解決できた語（~ の展開、./ や .. の正規化、グロブ）
    return None


def credential_deny(hit: str) -> Finding:
    """CREDENTIAL_DENY の文に、一致した語と次の行動を添える。語は改行を畳み、長ければ切る。"""
    shown = " ".join(hit.split())
    if len(shown) > 60:
        shown = shown[:57] + "..."
    return Finding(
        "deny",
        f"{CREDENTIAL_DENY.reason}一致した語: {shown}。"
        "認証情報が要らない確認なら、この語を命令から外してください。"
        "認証情報が要る操作は、別の書き方で試さず、ユーザーに伝えてください。",
    )


def drop_api_fields(args: list[str]) -> list[str]:
    """gh api の -f / --raw-field の値（文章）を除く。-F / --field は、key=@ファイル の @ 以降だけ残す。"""
    if "api" not in args:
        return args
    kept: list[str] = []
    skip: str | None = None  # 次の引数の扱い: "raw"（捨てる）/ "field"（@ だけ残す）
    for arg in args:
        if skip is not None:
            value = arg.partition("=")[2]
            if skip == "field" and value.startswith("@"):
                kept.append(value[1:])
            skip = None
            continue
        name, eq, inline = arg.partition("=")
        if arg in {"-f", "--raw-field"}:
            skip = "raw"
        elif arg in {"-F", "--field"}:
            skip = "field"
        elif name == "--raw-field" and eq:
            continue
        elif name == "--field" and eq:
            if inline.partition("=")[2].startswith("@"):
                kept.append(inline.partition("=")[2][1:])
        elif re.fullmatch(r"-f.+", arg):
            continue
        elif re.fullmatch(r"-F.+", arg):
            if arg[2:].partition("=")[2].startswith("@"):
                kept.append(arg[2:].partition("=")[2][1:])
        else:
            kept.append(arg)
    return kept


def credential_words(program: str, args: list[str]) -> list[str]:
    """認証情報の置き場の検査にかける引数。文章（検索パターン・コミットメッセージ）は除く。"""
    if program in TEXT_ONLY:
        return []
    if program in GREP_PROGRAMS:
        return strip_grep_pattern(args)
    if program == "git":
        sub = git_subcommand(args)
        at = git_subcommand_index(args)
        head, tail = (args[: at + 1], args[at + 1 :]) if at is not None else ([], args)
        if sub == "grep":
            return head + strip_grep_pattern(tail)
        # -S は、log / diff / show では値を取る（-S <文字列>）。commit / tag などでは、続けて書く署名の鍵の指定
        pickaxe = sub in {"log", "diff", "show", "whatchanged", "blame"}
        return head + drop_option_values(tail, {"m", "S", "G"} if pickaxe else {"m"}, {"message", "grep"})
    if program == "gh":
        if "search" in args:
            return []
        return drop_api_fields(drop_option_values(args, GH_TEXT_SHORT, GH_TEXT_LONG))
    if program in {"pytest", "py.test"} or "pytest" in args[:4]:
        return drop_option_values(args, {"k", "m"}, set())  # -k / -m の値は、テストの選択式（文章）
    return args


def chdir_operands(wrapper_words: list[str], program: str, args: list[str]) -> list[str]:
    """env -C DIR / sudo -D DIR / git -C DIR / make -C DIR の DIR。以降の相対パスは、DIR からの読み取りになる。"""
    found: list[str] = []

    def scan(words: list[str], shorts: set[str]) -> None:
        for k, w in enumerate(words):
            name, eq, value = w.partition("=")
            if w in shorts or (name in {"--chdir", "--directory"} and not eq):
                if k + 1 < len(words):
                    found.append(words[k + 1])
            elif eq and name in {"--chdir", "--directory"}:
                found.append(value)
            elif len(w) > 2 and w[:2] in shorts and not w.startswith("--"):
                found.append(w[2:])  # -C/path のように続けて書く形

    scan(wrapper_words, {"-C", "-D"})
    if program in {"git", "make", "gmake"}:
        scan(args, {"-C"})
    return found


def names_cli(arg: str) -> bool:
    """引数が、CLI のプログラムを指すか（gh / /usr/bin/gh / ./gh。infra/terraform や chore/gh は、ただのパス・名前）。"""
    return os.path.basename(arg) in CLIS and ("/" not in arg or arg.startswith(("/", "./", "../", "~", "$")))


def script_runs_cli(script: str, depth: int = 0) -> bool:
    """スクリプトが、CLI（gcloud / gh など）を実行しうるか。名前が文章や、参照系のプログラム（apt-get install gh）の
    引数に出るだけなら False。判断できないとき（深い入れ子・標準入力のシェル・変数に入れた名前）は、名前が見えれば True
    （拒否する側に倒す）。"""
    if depth >= MAX_DEPTH:
        return bool(CLI_WORD.search(script))
    for unit in build_units(tokenize(script)):
        if any(script_runs_cli(s, depth + 1) for s in unit.subs):
            return True
        words = unit.words
        if any(ASSIGNMENT.match(w) and CLI_WORD.search(w) for w in words):
            return True  # c=gh; $c run list のように、変数に入れた名前（展開は、ここでは追わない）
        index, scripts, _ = resolve_program(words)
        if any(script_runs_cli(s, depth + 1) for s in scripts):
            return True
        if index is None:
            continue
        program = os.path.basename(words[index])
        args = words[index + 1 :]
        if program in CLIS:
            return True
        if program in SHELLS:
            position, reads_stdin = shell_script(args)
            if position is not None and script_runs_cli(args[position], depth + 1):
                return True
            if reads_stdin and CLI_WORD.search(script):
                return True
        elif program in C_ONLY_SHELLS:
            position = c_option_script(args)
            if position is not None and script_runs_cli(args[position], depth + 1):
                return True
        elif program == "eval":
            if script_runs_cli(" ".join(args), depth + 1):
                return True
        elif program in SCHEDULERS or program in RUNNERS or INTERPRETER.match(program) or program in SOURCERS:
            if CLI_WORD.search(script):  # 中身までは追えない
                return True
        elif program not in TEXT_ONLY and program not in GREP_PROGRAMS and program not in LOOKUP_PROGRAMS:
            if any(names_cli(a) or embedded_command(a) is not None for a in args):
                return True
    return False


def stdin_script_checks(
    unit: Unit,
    units: list[Unit],
    idx: int,
    text: str,
    reads_stdin_script: bool,
    sub: Callable[[str], None],
    findings: list[Finding],
) -> list[str]:
    """シェルが標準入力・プロセス置換から読むスクリプトを調べる。調べた文章を返す。出どころが分からなければ確認にする。"""
    fed: list[str] = []
    analyzed = False
    if unit.after == "<(" and idx + 1 < len(units) and units[idx + 1].before == "<(":
        texts = produced_texts(units[idx + 1])
        for produced in texts:
            sub(produced)
            fed.append(produced)
        if texts and passes_text_through(units[idx + 1]):
            analyzed = True
        else:  # bash <(curl ...) / sh <(base64 -d <<< ...): 出力は、検査できない
            findings.append(OPAQUE_STDIN)
    if reads_stdin_script:
        for heredoc in unit.heredocs:
            sub(heredoc.body)
            fed.append(heredoc.body)
            analyzed = True
        for string in unit.herestrings:
            sub(string)
            fed.append(string)
            analyzed = True
        j = idx
        while j > 0 and units[j].before in PIPES:
            j -= 1
            texts = produced_texts(units[j])
            for produced in texts:
                sub(produced)
                fed.append(produced)
            analyzed = analyzed or bool(texts)
        if not analyzed and CLI_WORD.search(text):
            findings.append(
                Finding(
                    "ask",
                    "標準入力から読んだスクリプトの中でクラウド CLI（gcloud / gh など）を呼ぶ可能性があります。"
                    "内容を確認してください。",
                )
            )
        elif stdin_source(unit, units, idx) == "opaque":  # curl ... | sh / ... | base64 -d | sh
            findings.append(OPAQUE_STDIN)
    return fed


def analyze_unit(
    unit: Unit,
    units: list[Unit],
    idx: int,
    text: str,
    depth: int,
    findings: list[Finding],
    variables: dict[str, list[str]] | None = None,
) -> None:
    """1 つのコマンドを調べる。語は、実行時の姿の候補（ブレース・${x:-既定値}・代入済みの変数）ごとに調べる。"""
    variables = variables or {}
    for k, (words, word_dynamic) in enumerate(expand_words(unit, variables)):
        analyze_words(unit, units, idx, text, depth, findings, variables, words, word_dynamic, k == 0)


def analyze_words(
    unit: Unit,
    units: list[Unit],
    idx: int,
    text: str,
    depth: int,
    findings: list[Finding],
    variables: dict[str, list[str]],
    words: list[str],
    word_dynamic: list[bool],
    first: bool,
) -> None:
    inherited = variables  # 入れ子のスクリプトが引き継ぐ変数（VAR=値 cmd の VAR を、下で足す）

    def sub(script: str) -> None:
        if depth < MAX_DEPTH:
            findings.extend(analyze(script, depth + 1, inherited))
        else:  # 読めないものは通さない（CLI の名前が見えなくても、git credential などを隠せる）
            findings.append(Finding("deny", "コマンドの入れ子が深すぎて、検査できません。"))

    if first:  # コマンド全体に掛かる検査（語の候補ごとに繰り返さない）
        for script in unit.subs:
            sub(script)
        for heredoc in unit.heredocs:
            if not heredoc.quoted:  # 引用符なしの区切りでは、本文の $(...) とバッククォートが実行される
                for script in substitutions_in(heredoc.body):
                    sub(script)
        hit = credential_hit(unit.targets)
        if hit is not None:
            findings.append(credential_deny(hit))

    index, scripts, wrappers = resolve_program(words)
    for script in scripts:
        sub(script)
    prefix = words if index is None else words[:index]
    for word in prefix:
        m = ASSIGNMENT.match(word)
        if m and IDENTITY_ENV.match(m.group(1)):
            findings.append(Finding("deny", f"認証・ID を変える環境変数（{m.group(1)}）は設定できません。"))
        if m and EVALUATED_ENV.match(m.group(1)):
            sub(word[m.end() :])  # PROMPT_COMMAND / PS4 の値は、後でシェルが評価する
    if index is not None:
        # g=gh bash -c '$g run delete 1' / env X=gh sh -c '$X ...': VAR=値 は、子のシェルの環境に入る
        exported = {m.group(1): [resolve_params(w[m.end() :], variables)] for w in prefix if (m := ASSIGNMENT.match(w))}
        if exported:
            inherited = {**variables, **exported}
    if index is None:
        m = CREDENTIAL_TEXT.search(" ".join(prefix))
        if m:
            findings.append(credential_deny(m.group(0)))
        if scripts:  # env -i -S 'gcloud run services list': -S の中身は、外側の env のオプションの下で動く
            unset_names, clears_env = env_changes(words)
            if (clears_env or any(IDENTITY_ENV.match(name) for name in unset_names)) and any(
                script_runs_cli(script) for script in scripts
            ):
                findings.append(IDENTITY_DROP)
        if first and wrappers and wrappers[-1] in {"sudo", "doas"} and any(
            re.fullmatch(r"-[A-Za-z]*[is][A-Za-z]*", w) or w in {"--login", "--shell"} for w in words
        ):
            # echo 'gh run delete 1' | sudo -i / sudo -s <<< '...': 標準入力のスクリプトを読むシェル（ID も引き継がない）
            fed = stdin_script_checks(unit, units, idx, text, True, sub, findings)
            if any(script_runs_cli(t) for t in fed):
                findings.append(IDENTITY_DROP)
        return

    program_word = words[index]
    program = os.path.basename(program_word)
    args = words[index + 1 :]
    dynamic = word_dynamic[index + 1 :]

    hit = credential_hit([program_word])
    if hit is not None:
        findings.append(credential_deny(hit))  # 下で語を CLI の名前に置き換えて調べる前に、元の語を見ておく

    if program_word.startswith(("$(", "`")):
        # $(which gh) run delete 1 のように、プログラム名がコマンド置換の結果。置換の中に CLI の名前が見えたら、
        # その CLI の呼び出しとして調べる（置換の中身は、上で別に調べている）
        names = sorted(set(CLI_WORD.findall(program_word)))
        runs_cli = any(
            os.path.basename(inner.words[resolve_program(inner.words)[0]]) in CLIS
            for script in substitutions_in(program_word)
            for inner in build_units(tokenize(script))
            if resolve_program(inner.words)[0] is not None
        )
        if runs_cli:  # `gh run list` のように、CLI の出力が、実行するプログラム名になる
            findings.append(
                Finding("ask", "実行するプログラム名が、CLI の出力（コマンド置換）で決まります。内容を確認してください。")
            )
        else:  # $(which gh) のように、場所を調べるだけの置換は、その CLI の呼び出しとして調べる
            for name in names:
                clone = Unit(unit.before)
                clone.words = words[:index] + [name] + words[index + 1 :]
                clone.dynamic = word_dynamic[:index] + [False] + word_dynamic[index + 1 :]
                clone.targets, clone.heredocs, clone.herestrings = unit.targets, unit.heredocs, unit.herestrings
                analyze_unit(clone, units, idx, text, depth, findings, variables)
        # $(echo gh run delete 1) のように、置換の出力が、そのままコマンドラインになる（後ろの語を足して調べる）
        for script in substitutions_in(program_word):
            for inner in build_units(tokenize(script)):
                for produced in produced_texts(inner)[-1:]:
                    sub(" ".join([produced] + words[index + 1 :]))
        if names:
            return
    elif not word_dynamic[index] and re.search(r"[\s;&|]", program_word):
        # watch 'gh run list' のように、コマンドが 1 つの文字列で渡された。結合して読み直しても同じ 1 語に戻るもの
        # （${x:-a b} の空白・全角の空白・置換の中の空白）は、読み直さない（入れ子を掘り続けて、深さの上限に当たる）
        again = build_units(tokenize(" ".join(words[index:])))
        if not (len(again) == 1 and again[0].words[:1] == [program_word]):
            sub(" ".join(words[index:]))
            return

    if re.search(r"[*?\[]", program) and "$" not in program and program not in CLIS:
        # /usr/bin/g? run delete 1 のように、プログラム名がグロブ。CLI の名前に一致するなら、その CLI として調べる
        matched = [name for name in sorted(CLIS) if fnmatch.fnmatchcase(name, program)]
        for name in matched:
            clone = Unit(unit.before)
            clone.words = words[:index] + [name] + words[index + 1 :]
            clone.dynamic = word_dynamic[:index] + [False] + word_dynamic[index + 1 :]
            clone.targets, clone.heredocs, clone.herestrings = unit.targets, unit.heredocs, unit.herestrings
            analyze_unit(clone, units, idx, text, depth, findings, variables)
        if matched:
            return

    def runs_dynamic_text(position: int) -> bool:
        """実行する文字列が、コマンド置換や変数で実行時に決まるか（検査できないので、確認にする）。"""
        return dynamic[position] or bool(re.fullmatch(r"\$\{?\w+\}?", args[position]))

    ask_dynamic = Finding("ask", "実行する文字列が実行時に決まります（コマンド置換・変数）。内容を確認してください。")

    if program in ASSIGNING_BUILTINS:
        for word in args:
            m = ASSIGNMENT.match(word)
            if m and IDENTITY_ENV.match(m.group(1)):
                findings.append(Finding("deny", f"認証・ID を変える環境変数（{m.group(1)}）は設定できません。"))
            if m and EVALUATED_ENV.match(m.group(1)):
                sub(word[m.end() :])

    reads_stdin_script = False
    cli_in_args = False  # 知らないラッパーの引数に、CLI の名前が単独で出た
    inner_scripts: list[str] = []  # 再帰で調べるので、認証情報の置き場の検査からは外す
    exec_words: list[str] = []  # find -exec の後ろ（別のコマンドとして調べる。find の引数としては、コマンドラインに見ない）
    text_args = credential_words(program, args)  # 文章（検索パターン・コミットメッセージ・テストの選択式）を除いた引数
    if program in CLIS:
        exported_names = [
            m.group(1) for word in prefix if (m := ASSIGNMENT.match(word)) and (
                LAUNCHER_ENV.match(m.group(1)) or ROUTING_ENV.match(m.group(1)) or (program == "gh" and m.group(1) == "DEBUG")
            )
        ]
        for name in exported_names + variables.get("\0env", []):  # 後者は、前のコマンドで export / 代入したもの
            findings.append(
                Finding(
                    "deny",
                    f"外部コマンドの起動や通信の経路を変えられる環境変数（{name}）は、{program} には付けられません。",
                )
            )
        finding = classify_cli(program, args)
        if finding:
            findings.append(finding)
        if "xargs" in wrappers:  # echo 'auth token' | xargs gh のように、標準入力の語がこの CLI の引数になる
            j = idx
            while j > 0 and units[j].before in PIPES:
                j -= 1
                for produced in produced_texts(units[j])[-1:]:
                    for group in xargs_inputs(prefix, produced):
                        piped = classify_cli(program, args + group)
                        if piped:
                            findings.append(piped)
    elif program in SHELLS:
        position, reads_stdin_script = shell_script(args)
        if position is not None:
            if runs_dynamic_text(position):
                findings.append(ask_dynamic)
            sub(args[position])
            inner_scripts.append(args[position])
            rest = args[position + 1 :]
            if rest and re.search(r"\$(?:[@*0-9]|\{[@*0-9])", args[position]):
                # bash -c 'exec "$@"' _ gh run delete 1: スクリプトの後ろの語は、$0 $1 ... になる
                sub(" ".join(rest))
                if len(rest) > 1:
                    sub(" ".join(rest[1:]))
    elif program in C_ONLY_SHELLS:
        position = c_option_script(args)
        if position is not None:
            if runs_dynamic_text(position):
                findings.append(ask_dynamic)
            sub(args[position])
            inner_scripts.append(args[position])
        else:
            reads_stdin_script = True  # su - vscode <<< '...' / sg grp / newgrp: 標準入力のコマンドを読む
    elif program == "eval":
        if any(runs_dynamic_text(k) for k in range(len(args))):
            findings.append(ask_dynamic)
        sub(" ".join(args))
        inner_scripts += args
    elif program in SCHEDULERS:  # at now <<< 'gh run delete 1' / echo 'gh run delete 1' | at now
        payloads = [h.body for h in unit.heredocs] + unit.herestrings
        j = idx
        while j > 0 and units[j].before in PIPES:
            j -= 1
            payloads += produced_texts(units[j])
        for payload in payloads:
            sub(payload)
    elif program in RUNNERS:
        if any(CLI_WORD.search(w) for w in text_args):
            findings.append(Finding("ask", "タスクやスクリプトの中でクラウド CLI（gcloud / gh など）を呼ぶ可能性があります。内容を確認してください。"))
    elif program == "find":
        k = 0
        while k < len(args):
            if args[k] in {"-exec", "-execdir", "-ok", "-okdir"}:
                end = k + 1
                while end < len(args) and args[end] not in {";", "+"}:
                    end += 1
                exec_words += args[k + 1 : end]
                inner = Unit("")
                inner.words = args[k + 1 : end]
                if depth < MAX_DEPTH:
                    analyze_unit(inner, [inner], 0, text, depth + 1, findings, variables)
                k = end
            k += 1
    elif INTERPRETER.match(program):
        fed = [h.body for h in unit.heredocs] + unit.herestrings
        j = idx
        while j > 0 and units[j].before in PIPES:  # echo '...gh...' | python3
            j -= 1
            fed += produced_texts(units[j])
        # python3 hook.py / python3 -m json.tool のように、スクリプトのファイル・モジュールを渡されたら、標準入力はデータ。
        # コードを引数で渡されたとき（-c / -e / -r / -p ...）・- で標準入力から読むとき・標準入力を実行するモジュール・
        # プログラムを引数に書く awk は、標準入力を実行しうるので、スクリプトとして調べる
        code_given = any(
            re.fullmatch(r"-[A-Za-z]*[cdeEnpr][A-Za-z]*", a) or a in {"--eval", "--command", "--print", "-"} for a in args
        )
        module = args[args.index("-m") + 1] if "-m" in args and args.index("-m") + 1 < len(args) else ""
        if (
            any(not a.startswith("-") for a in args)
            and not code_given
            and module not in STDIN_EXEC_MODULES
            and not re.match(r"^(?:awk|gawk|mawk|nawk)$", program)
        ):
            fed = []
        if any(CLI_WORD.search(w) for w in text_args) or any(CLI_WORD.search(t) for t in fed):
            findings.append(Finding("ask", "スクリプトの中でクラウド CLI（gcloud / gh など）を呼んでいます。内容を確認してください。"))
        elif all(a in STDIN_SCRIPT_FLAGS for a in args) and stdin_source(unit, units, idx) == "opaque":
            findings.append(OPAQUE_STDIN)
    elif (
        program not in TEXT_ONLY
        and program not in GREP_PROGRAMS
        and (program not in LOOKUP_PROGRAMS or (program in {"conda", "snap"} and args[:1] == ["run"]))
        and not any(w in {"for", "select", "case"} for w in prefix)  # for t in gh gcloud; do ...: 見出しは、何も実行しない
    ):
        # 知らないラッパー・実行役（taskset / fakeroot / chroot / tmux ...）。引数に CLI の名前が単独で出たら、そこから調べる
        for k, arg in enumerate(text_args):
            name = os.path.basename(arg)
            if names_cli(arg) and (program != "git" or text_args[k - 1 : k] in (["run"], ["-x"], ["--exec"])):
                cli_in_args = True  # git checkout -b chore/gh / git push gh main の gh は、ブランチ・リモートの名前
                found = classify_cli(name, text_args[k + 1 :])
                if found:
                    findings.append(found)
            elif depth < MAX_DEPTH and (
                (name in SHELLS and shell_script(text_args[k + 1 :])[0] is not None)  # fakeroot sh -c '...'
                or (name == "git" and (program != "git" or text_args[k - 1 : k] in (["run"], ["-x"], ["--exec"])))
                or name.startswith("git-credential")
            ):
                launched = Unit("")
                launched.words = text_args[k:]
                analyze_unit(launched, [launched], 0, text, depth + 1, findings, inherited)

    if program not in CLIS and program not in TEXT_ONLY and program not in GREP_PROGRAMS:
        # 引数や環境変数の値が、CLI で始まるコマンドライン（git -c alias.x=!gh ... / flock -c 'gh ...' / VAR='gh ...'）。
        # man -P 'gh ...' のように、参照系のプログラムが渡された文字列を実行することもある
        values = [w.partition("=")[2] for w in prefix if ASSIGNMENT.match(w)]
        scanned_args = [a for a in text_args if a not in inner_scripts and a not in exec_words]
        if program == "sed":  # sed -i 's/gcloud auth login/.../' の中の文章は、コマンドではない
            scanned_args = [a for a in scanned_args if not SED_SUBSTITUTION.match(a)]
        if program in {"jq", "gojq", "yq"}:  # jq --arg c 'gh run delete 1' ...: --arg の値は、ただの文字列
            scanned_args = drop_arg_pairs(scanned_args, {"--arg", "--argjson", "--rawfile", "--slurpfile"})
        for value in values + scanned_args:
            embedded = embedded_command(value)
            if embedded is not None:
                sub(embedded)
            elif CLI_WORD.search(value) and re.search(r"&&|\|\||[;|\n]", value):
                sub(value)  # tmux new-session -d 'cd /tmp && gh run delete 1' / git rebase -x '...; gh ...'

    # シェルへ渡される文章（ヒアドキュメント・ヒアストリング・パイプ・プロセス置換）も調べる
    if program in SOURCERS and args and args[0] in STDIN_PATHS:
        reads_stdin_script = True
    if program in SHELLS or program in SOURCERS or (program in C_ONLY_SHELLS and reads_stdin_script):
        # 標準入力で受け取ったスクリプトも、sudo / su の下では ID を引き継がない（下の IDENTITY_DROP の判定に使う）
        inner_scripts += stdin_script_checks(unit, units, idx, text, reads_stdin_script, sub, findings)

    # 日常の ID（環境変数で固定したなりすまし）を外す・引き継がない実行
    unset_names, clears_env = env_changes(words[: index + 1])  # env - のように、プログラムの位置に来る "-" も含める
    if any(IDENTITY_ENV.match(name) for name in unset_names):
        findings.append(IDENTITY_DROP)
    if program == "unset" or (program in ASSIGNING_BUILTINS and any(a in {"-n", "+x"} for a in args)):
        if any(IDENTITY_ENV.match(a.partition("=")[0]) for a in args if not a.startswith(("-", "+"))):
            findings.append(IDENTITY_DROP)
    if program in CLIS or cli_in_args or any(script_runs_cli(s) for s in inner_scripts):
        resets = clears_env or bool({"sudo", "doas"} & set(wrappers))  # sudo の env_reset は、環境変数を引き継がない
        resets = resets or (program == "su" and any(re.fullmatch(r"-|--login|-[a-z]*l[a-z]*", a) for a in args))
        if resets:
            findings.append(IDENTITY_DROP)

    if program == "git":
        sub_command = git_subcommand(args)
        if sub_command and (sub_command == "credential" or sub_command.startswith("credential-")):
            findings.append(GIT_CREDENTIAL_DENY)
        if any(re.match(r"alias\.[^=]*=.*credential", a) for a in args):  # git -c alias.c=credential c fill
            findings.append(GIT_CREDENTIAL_DENY)
    elif program.startswith("git-credential"):
        findings.append(GIT_CREDENTIAL_DENY)

    scanned = prefix + [program_word] + credential_words(program, [a for a in args if a not in inner_scripts])
    hit = credential_hit(scanned)
    if hit is not None:
        findings.append(credential_deny(hit))
    elif program in PARENT_SENSITIVE:
        covered = scanned[len(prefix) + 1 :]
        if program in {"cp", "mv", "rsync", "scp"} and not any(
            a == "-t" or a.startswith("--target-directory") for a in covered
        ):
            operands = [k for k, w in enumerate(covered) if not w.startswith("-")]
            if len(operands) >= 2:  # 最後の語は書き込み先（~ へのコピーは、認証情報を読まない）
                covered = covered[: operands[-1]] + covered[operands[-1] + 1 :]
        parent = next((w for w in covered if covers_protected_dirs(program, w)), None)
        if parent is not None:
            findings.append(credential_deny(parent))

    # env -C ~/.config cat gh/hosts.yml / git -C ~/.config show ... のように、作業ディレクトリを認証情報の親にして、相対パスで読む
    parent = next(
        (w for w in chdir_operands(words[: index + 1], program, args) if covers_protected_dirs("cd", w)), None
    )
    if parent is not None:
        findings.append(credential_deny(parent))

    # echo ~/.config/gh/hosts.yml | xargs cat のように、標準入力の語が引数になる（CLI の場合は、上で classify している）
    if "xargs" in wrappers and program not in CLIS and program not in TEXT_ONLY:
        j = idx
        while j > 0 and units[j].before in PIPES:
            j -= 1
            for produced in produced_texts(units[j]):
                hit = credential_hit(produced.split())
                if hit is not None:
                    findings.append(credential_deny(hit))


def analyze(text: str, depth: int = 0, variables: dict[str, list[str]] | None = None) -> list[Finding]:
    if depth == 0:
        _steps[0] = MAX_STEPS
        _PAREN_CACHE.clear()
        _capped.clear()
    findings: list[Finding] = []
    units = build_units(tokenize(text))
    known = collect_variables(units, variables or {})
    for idx, unit in enumerate(units):
        analyze_unit(unit, units, idx, text, depth, findings, known)
        for name in persistent_assignments(unit):  # export https_proxy=...; gh run list
            if LAUNCHER_ENV.match(name) or ROUTING_ENV.match(name):
                known.setdefault("\0env", []).append(name)
    if depth == 0 and _capped:
        findings.append(
            Finding("ask", "変数の値やブレース展開の候補が多く、すべては検査できません。内容を確認してください。")
        )
    return findings


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        tool_input = payload.get("tool_input") if isinstance(payload, dict) else None
        if not isinstance(tool_input, dict) or payload.get("tool_name") not in {"Bash", "Monitor"}:
            return 0
        command = tool_input.get("command") or ""
        if not isinstance(command, str):
            raise TypeError("command is not a string")
        findings = analyze(command)
    except Exception:  # noqa: BLE001  入力が読めない・検査に失敗したときは、通さない
        print("ガード: フックの入力を検査できませんでした。実行を止めます。", file=sys.stderr)
        return 2
    if not findings:
        return 0

    denies = [f.reason for f in findings if f.level == "deny"]
    if denies:
        print("ガード（クラウド CLI・gh）: 実行を止めました。\n- " + "\n- ".join(dict.fromkeys(denies)), file=sys.stderr)
        return 2
    asks = list(dict.fromkeys(f.reason for f in findings))
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": "ガード（クラウド CLI・gh）: " + " / ".join(asks),
                }
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
