import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Shell } from './shell';
import { AskProvider } from '../components/ask';

export const metadata: Metadata = {
  title: 'SAOS — Soto Accounting Operating System',
  description: 'Internal operations: dashboards, alerts, sessions, delivery.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AskProvider>
          <Shell>{children}</Shell>
        </AskProvider>
      </body>
    </html>
  );
}
