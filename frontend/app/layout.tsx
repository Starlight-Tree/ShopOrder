import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'オアシス珈琲', template: '%s｜オアシス珈琲' },
  description: '惑星ザーハード、アルカ市のオアシス珈琲。商品の注文と宅配（架空）。',
  other: { 'color-scheme': 'light dark' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
