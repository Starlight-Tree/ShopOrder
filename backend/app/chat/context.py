"""1 ターン（1 回の発話への応答）の文脈。利用者・店・スレッドは、セッション（スレッド）から決めた値で、ツールの引数からは決めない。"""

from dataclasses import dataclass


@dataclass
class TurnContext:
    thread_id: str  # uuid 文字列
    user_id: int  # スレッドの持ち主（API が毎回、セッションの利用者と照合してから作る）
    store_id: int  # スレッドで固定した店
    user_message_id: int  # このターンを始めた、利用者の発話の ID（監査の結び付けと、ツール呼び出しの ID に使う）
    tool_calls: int = 0  # このターンで実行を試みたツールの数（定義に無い名前・引数の誤りも数える）
    writes: int = 0  # このターンの書き込みの試行（カートの下書き・提案）
