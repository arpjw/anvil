import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <div className="min-h-[calc(100vh-52px)] flex items-center justify-center px-6">
      <div className="text-center">
        <p className="text-sm font-mono mb-2" style={{ color: '#6b7280' }}>
          404
        </p>
        <h1 className="text-2xl font-medium mb-6">Page not found</h1>
        <Link
          href="/"
          className="text-sm underline"
          style={{ color: '#fbbf24' }}
        >
          Return home
        </Link>
      </div>
    </div>
  );
}
