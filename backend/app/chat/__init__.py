"""チャットで注文を手配する（P3。docs/chat.md）。

AI に渡すのは、カートの下書きと確認カードまで。注文の確定・決済・個人情報の変更のツールは、ここに存在しない（docs/decisions/0003）。
LangGraph・langchain は使わない。素の Python で、ツールを呼ぶ会話のループを書く（agent.py）。差し替え口は ChatModel（model.py）。
"""
