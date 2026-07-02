import { SignedIn, SignedOut, RedirectToSignIn } from '@clerk/nextjs';
import { NewSessionForm } from './NewSessionForm';

export const dynamic = 'force-dynamic';

export default function NewSessionPage() {
  return (
    <>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
      <SignedIn>
        <NewSessionForm />
      </SignedIn>
    </>
  );
}
