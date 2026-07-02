import { SignedIn, SignedOut, RedirectToSignIn } from '@clerk/nextjs';
import { ReposSettings } from './ReposSettings';

export const dynamic = 'force-dynamic';

export default function ReposSettingsPage() {
  return (
    <>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
      <SignedIn>
        <ReposSettings />
      </SignedIn>
    </>
  );
}
