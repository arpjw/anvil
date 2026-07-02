import { auth } from '@clerk/nextjs/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONTROL_PLANE_URL =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? 'http://localhost:3001';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

async function proxy(req: Request, segments: string[]): Promise<Response> {
  const { getToken } = await auth();
  const token = await getToken();

  const targetUrl = new URL(req.url);
  const path = segments.map(encodeURIComponent).join('/');
  const upstreamUrl = `${CONTROL_PLANE_URL}/api/v1/${path}${targetUrl.search}`;

  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const isSSE = headers.get('accept')?.includes('text/event-stream');
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    redirect: 'manual',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body;
    init.duplex = 'half';
  }

  const upstream = await fetch(upstreamUrl, init);

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    responseHeaders.set(key, value);
  }

  if (isSSE || responseHeaders.get('content-type')?.includes('text/event-stream')) {
    responseHeaders.set('Content-Type', 'text/event-stream');
    responseHeaders.set('Cache-Control', 'no-cache, no-transform');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path ?? []);
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path ?? []);
}

export async function PUT(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path ?? []);
}

export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path ?? []);
}

export async function DELETE(
  req: Request,
  ctx: RouteContext,
): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path ?? []);
}
