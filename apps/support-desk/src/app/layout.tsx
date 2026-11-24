import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../styles/tokens.css';
import '../styles/base.css';
import { APP_TITLE } from './_components/app-title';

export const metadata: Metadata = {
  title: { default: APP_TITLE, template: `%s · ${APP_TITLE}` },
  // Authenticated tenant data: keep it out of search engines.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
