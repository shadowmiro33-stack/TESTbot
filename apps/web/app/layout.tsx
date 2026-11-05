import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'AUTOHANDS — AI QA Control Center', description: 'URL과 계정만으로 분석부터 테스트, 증빙 리포트까지 자동화하는 AI QA 플랫폼' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ko"><body>{children}</body></html>; }
