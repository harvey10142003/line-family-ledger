const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Docker 部署用 standalone 輸出
  output: 'standalone',
  // monorepo：讓 file tracing 從 repo 根算，standalone 才會帶對 node_modules
  outputFileTracingRoot: path.join(__dirname, '..'),
  // LIFF 同源：把 /api/* 反代到後端服務，前端 fetch 相對路徑即可，免 CORS
  async rewrites() {
    const apiBase = process.env.API_PROXY_TARGET || 'https://line-family-ledger.zeabur.app';
    return [{ source: '/api/:path*', destination: `${apiBase}/api/:path*` }];
  },
};

module.exports = nextConfig;
