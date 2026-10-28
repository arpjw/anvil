import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { clerkMiddleware } from '@clerk/nextjs/server';

const authenticated = clerkMiddleware();
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY) return authenticated(request, event);
  const path = request.nextUrl.pathname;
  if (path === '/' || path === '/demo' || path.startsWith('/_next/') || path === '/favicon.ico') return NextResponse.next();
  return NextResponse.json({ error: { code: 'auth_not_configured', message: 'Configure Clerk before using live sessions.' } }, { status: 503 });
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
