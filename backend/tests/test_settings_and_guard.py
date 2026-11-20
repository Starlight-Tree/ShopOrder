import os
import subprocess
import sys

import pytest

from app import settings


def test_providers_default_to_mock_and_reject_unknown_values(monkeypatch):
    for name in settings.PROVIDERS:
        monkeypatch.delenv(name, raising=False)
    assert settings.provider("PAYMENT_PROVIDER") == "mock"
    assert settings.provider("CHAT_MODEL") == "mock"
    monkeypatch.setenv("PAYMENT_PROVIDER", "stripe")  # まだ許していない本物は、起動の設定ミスとして拒否する
    with pytest.raises(RuntimeError):
        settings.provider("PAYMENT_PROVIDER")
    monkeypatch.setenv("CHAT_MODEL", "gemini")
    assert settings.provider("CHAT_MODEL") == "gemini"


def test_database_url_is_required(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError):
        settings.database_url()


def test_demo_data_needs_an_explicit_allow(monkeypatch):
    monkeypatch.delenv("DEMO_DATA", raising=False)
    with pytest.raises(SystemExit):
        settings.require_demo_data_allowed()
    monkeypatch.setenv("DEMO_DATA", "allow")
    settings.require_demo_data_allowed()


def test_seed_refuses_to_run_without_demo_data_allow():
    """環境変数なしの子プロセスで、seed が拒否される（本番の DB に誤って入れない）。"""
    env = {k: v for k, v in os.environ.items() if k not in ("DEMO_DATA", "DATABASE_URL")}
    result = subprocess.run([sys.executable, "-m", "app.seed_demo"], env=env, capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), ".."))
    assert result.returncode != 0
    assert "DEMO_DATA=allow" in (result.stdout + result.stderr)
