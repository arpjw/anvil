import { SignedIn, SignedOut, RedirectToSignIn } from '@clerk/nextjs';
import { BillingSettings } from './BillingSettings';

export const dynamic = 'force-dynamic';

export default function BillingSettingsPage() {
  return (
    <>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
      <SignedIn>
        <BillingSettings />
      </SignedIn>
    </>
  );
}
