"""ChatModel（差し替え口）。会話の履歴とツールの定義を受け取り、アシスタントの文かツール呼び出しを返す（docs/decisions/0005）。

- 既定は模擬（CHAT_MODEL=mock。mock_model.py。決定的な規則ベース）。実 API（Gemini）は P6 で、承認を得てから書く。
  設定の選択肢（settings.PROVIDERS）に 'gemini' はあるが、実装が無いので、選ぶと起動時に明確なエラーにする（模擬へ黙って落とさない）。
- モデルは、書き込みの安全を自分で担わない。ツールの検証・上限・出力ガードは、モデルの外（tools.py・guardrails.py・agent.py）が行う。
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from app import settings


@dataclass(frozen=True)
class ToolSpec:
    """モデルに見せるツールの定義。parameters は JSON Schema。"""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class ChatMessage:
    """会話の 1 件。role: system / user / assistant / tool。

    tool: tool_call_id と name が対応する呼び出しを指す。content はモデルが読む文（信頼できないデータの包みつき）、data は構造化した結果。
    assistant: tool_calls を持つことがある。meta は、履歴の補足（例 card_kinds = その発話に付いたカードの種類）。実モデルは使わなくてよい。
    """

    role: Literal["system", "user", "assistant", "tool"]
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None
    name: str | None = None
    data: dict[str, Any] | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ModelReply:
    """text か tool_calls のどちらか（両方もありうる。前置きの文 + ツール呼び出し）。tool_calls が空なら、これが最終の応答。"""

    text: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()


class ChatModel(Protocol):
    name: str

    def reply(self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec]) -> ModelReply: ...


def _selected() -> str:
    return settings.provider("CHAT_MODEL")  # 許さない値は RuntimeError


def get_model() -> ChatModel:
    """設定で選んだモデル。テストは、この関数を差し替えて偽物を渡す（agent は model.get_model() を呼ぶ）。"""
    selected = _selected()
    if selected == "mock":
        from app.chat.mock_model import MockChatModel

        return MockChatModel()
    raise RuntimeError(
        f"CHAT_MODEL={selected} はまだ実装されていません（実 API は P6。ユーザーの承認を得てから実装します）。CHAT_MODEL=mock にしてください"
    )


def check_startup() -> None:
    """起動時の検査。モデルの選択が不正・未実装なら RuntimeError（API を起動しない）。保存期間の設定も確かめる。"""
    from app.chat import config

    get_model()
    config.retention_days()
