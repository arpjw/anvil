import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { Nav } from '@/components/Nav';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Anvil Cloud',
  description: 'AI coding agent in the cloud.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const configured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const content = (
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body
          className="min-h-full"
          style={{ backgroundColor: '#0a0a0a', color: '#f0f0f0' }}
        >
          <Nav configured={configured} />
          <div className="pt-[52px] min-h-screen">{children}</div>
        </body>
      </html>
  );
  return configured ? <ClerkProvider>{content}</ClerkProvider> : content;
}
