# 開発コンテナのイメージ。Docker の CLI と Compose（docker compose のプラグイン）、psql、curl・ca-certificates を足す。
# Python と Node は devcontainer.json の features が入れる。git・sudo は、ベースのイメージにある。
# ログイン情報はイメージに含めない（Claude Code は専用の名前付きボリューム。.devcontainer/docker-compose.yml）。
# Debian 13 のパッケージで、ソケットもデーモンも含まない。接続先は DOCKER_HOST（./docker-compose.yml）のプロキシだけ。
# Docker-outside-of-Docker の feature は使わない（ホストのソケットを dev にマウントするため）。
# postgresql-client は、test-db（Postgres 17）を覗くための psql。
FROM mcr.microsoft.com/devcontainers/base:trixie

RUN export DEBIAN_FRONTEND=noninteractive \
    && apt-get update -y \
    && apt-get install -y --no-install-recommends docker-cli docker-compose postgresql-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && docker --version \
    && docker compose version \
    && psql --version

# E2E（frontend/e2e/、Playwright）の Chromium に要るライブラリーとフォント（`playwright install-deps chromium` が入れるものと同じ。
# 一覧の出どころは DocuNavi の .devcontainer/Dockerfile。ヘッドレスなので xvfb は入れない。2026-11-22）。
# Chromium 本体は、ここでは入れない。コンテナの作成後に、frontend で `npx playwright install chromium` を流す（~/.cache/ms-playwright に入る。
# 作り直すと消えるので、そのたびに取得する。約 120 MB）。版は frontend/package.json の @playwright/test（1.64.1）に合う。
RUN export DEBIAN_FRONTEND=noninteractive \
    && apt-get update -y \
    && apt-get install -y --no-install-recommends \
        fonts-noto-color-emoji fonts-unifont fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-freefont-ttf \
        libfontconfig1 libfreetype6 \
        libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 \
        libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
        libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*
