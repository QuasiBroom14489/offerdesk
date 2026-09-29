import { ClerkProvider, Show, SignIn, UserButton, useClerk } from '@clerk/react';
import { type ReactNode, useEffect } from 'react';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/** Hosted builds sign in with Clerk (ADR 0005). A local build has no key and no sign-in. */
export const HOSTED = !!PUBLISHABLE_KEY;

/** Fired by the API client when the server says the session is gone. */
export const UNAUTHORIZED_EVENT = 'offerdesk:unauthorized';

export function AuthGate({ children }: { children: ReactNode }) {
  if (!PUBLISHABLE_KEY) return <>{children}</>;
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <Show when="signed-in" fallback={<SignInPage />}>
        <ReturnToSignInOn401 />
        {children}
      </Show>
    </ClerkProvider>
  );
}

function SignInPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4">
      <div className="flex flex-col items-center gap-6">
        <p className="text-lg font-medium">OfferDesk</p>
        <SignIn />
      </div>
    </main>
  );
}

function ReturnToSignInOn401() {
  const clerk = useClerk();
  useEffect(() => {
    const onUnauthorized = () => void clerk.signOut();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [clerk]);
  return null;
}

/** The account menu for the top bar; nothing when running locally. */
export function AccountButton() {
  return HOSTED ? <UserButton /> : null;
}
