import { useState } from "react";
import { CircleUserRoundIcon, LogOutIcon } from "lucide-react";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import type { NativeHomepageAccount } from "./homepage-account-context";

export function NativeAccountDetails({
  account,
}: {
  account: NativeHomepageAccount;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="homepage-profile-account">
      <div className="homepage-profile-identity">
        <CircleUserRoundIcon aria-hidden="true" />
        <div>
          <h3>{account.session.name || "Your Account"}</h3>
          <p>{account.session.email}</p>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        variant="outline"
        size="touch"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void account.signOut().catch((reason: unknown) => {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not sign out. Please try again.",
            );
            setBusy(false);
          });
        }}
      >
        <LogOutIcon data-icon="inline-start" />
        {busy ? "Signing Out…" : "Sign Out"}
      </Button>
    </div>
  );
}
