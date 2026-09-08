import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  SignIn,
  SignOutButton,
  UserProfile,
  useUser,
} from "@clerk/react";
import {
  CircleUserRoundIcon,
  LogInIcon,
  LogOutIcon,
  Settings2Icon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import type { HomepageAccountView } from "./homepage-account";
import { HomepageClerkProvider } from "./homepage-account-provider";

type AccountProps = {
  view: HomepageAccountView;
  onViewChange: (view: HomepageAccountView) => void;
};

function AccountDetails({ view, onViewChange }: AccountProps) {
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded)
    return (
      <p role="status" className="text-muted-foreground">
        Connecting your account…
      </p>
    );
  if (view === "sign-in" && !isSignedIn)
    return <SignIn routing="hash" withSignUp />;
  if (view === "settings" && isSignedIn) return <UserProfile routing="hash" />;
  return (
    <div className="homepage-profile-account">
      <div className="homepage-profile-identity">
        <CircleUserRoundIcon aria-hidden="true" />
        <div>
          <h3>{isSignedIn ? user.fullName || "Your Account" : "Guest"}</h3>
          <p>
            {isSignedIn
              ? user.primaryEmailAddress?.emailAddress
              : "Sign-in is optional."}
          </p>
        </div>
      </div>
      <div className="homepage-profile-actions">
        {isSignedIn ? (
          <>
            <Button
              variant="outline"
              size="touch"
              onClick={() => onViewChange("settings")}
            >
              <Settings2Icon data-icon="inline-start" />
              Account Settings
            </Button>
            <SignOutButton>
              <Button variant="ghost" size="touch">
                <LogOutIcon data-icon="inline-start" />
                Sign Out
              </Button>
            </SignOutButton>
          </>
        ) : (
          <Button size="touch" onClick={() => onViewChange("sign-in")}>
            <LogInIcon data-icon="inline-start" />
            Sign In
          </Button>
        )}
      </div>
    </div>
  );
}

export default function HomepageClerkAccount({
  publishableKey,
  ...props
}: AccountProps & { publishableKey: string }) {
  return (
    <HomepageClerkProvider publishableKey={publishableKey}>
      <ClerkLoading>
        <p role="status" className="text-muted-foreground">
          Connecting your account…
        </p>
      </ClerkLoading>
      <ClerkFailed>
        <Alert>
          <AlertDescription>
            Sign-in is unavailable right now. Your local projects are ready to
            use.
          </AlertDescription>
        </Alert>
      </ClerkFailed>
      <ClerkLoaded>
        <AccountDetails {...props} />
      </ClerkLoaded>
    </HomepageClerkProvider>
  );
}
