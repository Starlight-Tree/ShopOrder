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
