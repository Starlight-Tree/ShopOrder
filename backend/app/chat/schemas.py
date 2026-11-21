"""チャット API の入出力の形（docs/api.md「チャット（P3）」）。共有の schemas.py には足さず、ここに置く。"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.chat import config
from app.schemas import StoreRef


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ThreadCreate(_Body):
    store_id: int = Field(ge=1)  # 会話に固定する店（あとから変えない。ツールの引数からは決めない）


class MessageBody(_Body):
    content: str = Field(min_length=1, max_length=config.MESSAGE_MAX_CHARS)

    @field_validator("content")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("blank")
        return value.strip()


class Thread(BaseModel):
    id: str
    store: StoreRef
    created_at: str


class ChatMessageOut(BaseModel):
    id: int
    role: str  # user / assistant
    content: str
    cards: list[dict[str, Any]]  # サーバーがツールの結果から作ったカード（assistant のみ）。確認カードは、期限が切れていることがある（確定の API が検証する）
    created_at: str


class ThreadDetail(Thread):
    messages: list[ChatMessageOut]
