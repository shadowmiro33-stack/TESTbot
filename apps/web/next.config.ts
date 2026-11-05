import type { NextConfig } from 'next';

/**
 * 대시보드는 같은 출처의 /api/* 로만 호출하고, Next 서버가 API 서버로 프록시합니다.
 * - 브라우저 → API 직접 호출(CORS)이 필요 없고, 인증 쿠키가 1st-party 로 동작합니다.
 * - API 주소가 클라이언트 번들에 박히지 않습니다. (서버 측 API_INTERNAL_URL 로 지정)
 * 별도 도메인의 API 를 브라우저가 직접 부르려면 NEXT_PUBLIC_API_URL 을 지정하세요.
 */
const apiInternal = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@autohands/shared'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiInternal}/api/:path*` },
      { source: '/health', destination: `${apiInternal}/health` }
    ];
  }
};
export default nextConfig;
