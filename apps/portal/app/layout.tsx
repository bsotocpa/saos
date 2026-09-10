import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SessionProvider } from '../lib/session';
import { Shell } from './shell';
import { AskProvider } from '../components/ask';

export const metadata: Metadata = {
  title: 'Soto Accounting — Client Portal',
  description: 'Your documents, returns, invoices, and messages — in one secure place.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <AskProvider>
            <Shell>{children}</Shell>
          </AskProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
