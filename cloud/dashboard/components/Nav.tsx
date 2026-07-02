'use client';

import Link from 'next/link';
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from '@clerk/nextjs';

export function Nav() {
  return (
    <header
      className="fixed top-0 inset-x-0 z-40 h-[52px] flex items-center px-6"
      style={{
        backgroundColor: '#0a0a0a',
        borderBottom: '1px solid #1f1f1f',
      }}
    >
      <Link
        href="/"
        className="font-mono text-[15px] tracking-tight"
        style={{ color: '#fbbf24' }}
      >
        Anvil
      </Link>
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        <SignedOut>
          <SignInButton mode="modal">
            <button
              className="px-3 py-1.5 text-sm rounded-md transition-colors"
              style={{
                backgroundColor: '#161616',
                color: '#f0f0f0',
                border: '1px solid #2a2a2a',
              }}
            >
              Sign in
            </button>
          </SignInButton>
        </SignedOut>
        <SignedIn>
          <Link
            href="/settings/repos"
            className="text-sm"
            style={{ color: '#6b7280' }}
          >
            Repos
          </Link>
          <Link
            href="/settings/billing"
            className="text-sm"
            style={{ color: '#6b7280' }}
          >
            Billing
          </Link>
          <UserButton
            appearance={{
              elements: {
                avatarBox: 'h-7 w-7',
              },
            }}
          />
        </SignedIn>
      </div>
    </header>
  );
}
