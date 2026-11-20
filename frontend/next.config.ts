import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 開発サーバーを 127.0.0.1 や host.docker.internal（開発コンテナのブラウザーから）で開いても、ブラウザーへの資産の配信が止まらないようにする
  allowedDevOrigins: ['127.0.0.1', 'host.docker.internal'],
  // `next dev` が AGENTS.md を自動で作るのを止める
  agentRules: false,
  // 画面の左下に出る開発用のアイコンを出さない
  devIndicators: false,
  // 応答に X-Powered-By: Next.js を付けない
  poweredByHeader: false,
};

export default nextConfig;
