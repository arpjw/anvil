import { SignedIn, SignedOut, RedirectToSignIn } from '@clerk/nextjs';
import { SessionDetailView } from './SessionDetailView';

export const dynamic = 'force-dynamic';

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
      <SignedIn>
        <SessionDetailView sessionId={id} />
      </SignedIn>
    </>
  );
}
