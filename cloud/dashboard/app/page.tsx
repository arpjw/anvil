import { SignedIn, SignedOut, SignInButton } from '@clerk/nextjs';
import { SessionList } from './_components/SessionList';
import { WaitlistForm } from './_components/WaitlistForm';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <>
      <SignedOut>
        <Hero />
      </SignedOut>
      <SignedIn>
        <SessionList />
      </SignedIn>
    </>
  );
}

function Hero() {
  return (
    <div className="min-h-[calc(100vh-52px)] flex items-center justify-center px-6 py-14">
      <div className="max-w-2xl w-full text-center">
        <h1
          className="text-4xl md:text-5xl font-medium tracking-tight"
          style={{ color: '#f0f0f0', lineHeight: 1.15 }}
        >
          Your codebase. An agent that gets it right.
        </h1>
        <p
          className="mt-6 text-base md:text-lg"
          style={{ color: '#6b7280', lineHeight: 1.6 }}
        >
          Anvil runs in an isolated cloud environment, validates every edit
          with the language server, and opens a PR when it is done.
        </p>
        <div className="mt-10 flex flex-col items-center gap-4">
          <SignInButton mode="modal">
            <button
              className="px-5 py-2.5 rounded-md text-sm font-medium transition-opacity hover:opacity-90"
              style={{
                backgroundColor: '#fbbf24',
                color: '#0a0a0a',
                border: '1px solid #fbbf24',
              }}
            >
              Sign in with GitHub
            </button>
          </SignInButton>
          <div className="w-full max-w-md">
            <WaitlistForm />
          </div>
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-center gap-2">
          <Pill>shadow workspace</Pill>
          <Pill>plan approval</Pill>
          <Pill>diff review</Pill>
        </div>
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="px-3 py-1 text-xs font-mono rounded-full"
      style={{
        backgroundColor: '#111111',
        color: '#6b7280',
        border: '1px solid #1f1f1f',
      }}
    >
      {children}
    </span>
  );
}
