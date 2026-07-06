import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Shell } from './shell';

export const metadata: Metadata = {
  title: 'SAOS — Soto Accounting Operating System',
  description: 'Internal operations: dashboards, alerts, sessions, delivery.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
