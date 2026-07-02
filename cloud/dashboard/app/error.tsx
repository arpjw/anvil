'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app error]', error);
  }, [error]);

  return (
    <div className="min-h-[calc(100vh-52px)] flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <p className="text-sm font-mono mb-2" style={{ color: '#f87171' }}>
          Something broke
        </p>
        <h1 className="text-2xl font-medium mb-4">
          The page hit an unexpected error.
        </h1>
        <p className="text-sm mb-6" style={{ color: '#6b7280' }}>
          {error.message || 'Unknown error'}
          {error.digest ? (
            <span className="block mt-1 font-mono text-xs">
              ref: {error.digest}
            </span>
          ) : null}
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 text-sm rounded font-medium"
          style={{ backgroundColor: '#fbbf24', color: '#0a0a0a' }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
