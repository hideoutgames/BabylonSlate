import { useState } from "react";
import {
  AppWindowIcon,
  CircleUserRoundIcon,
  CreditCardIcon,
  LogInIcon,
  LogOutIcon,
  Settings2Icon,
  UserRoundCogIcon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@babylonslate/ui/components/dropdown-menu";

function ProfileAvatar({
  imageUrl,
  className,
}: {
  imageUrl?: string;
  className: string;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  return imageUrl && failedImage !== imageUrl ? (
    <img
      className={className}
      src={imageUrl}
      alt=""
      onError={() => setFailedImage(imageUrl)}
    />
  ) : (
    <CircleUserRoundIcon className={className} aria-hidden="true" />
  );
}

export function HomepageProfileMenu({
  disabled,
  name = "Guest",
  email,
  imageUrl,
  onSignIn,
  onSignOut,
  onManageAccount,
  onSubscription,
  onApplicationSettings,
  onEngineSettings,
  onOpenChange,
}: {
  disabled?: boolean;
  name?: string;
  email?: string;
  imageUrl?: string;
  onSignIn?: () => void;
  onSignOut?: () => Promise<void>;
  onManageAccount?: () => void;
  onSubscription: () => void;
  onApplicationSettings?: () => void;
  onEngineSettings?: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = Boolean(onSignOut);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        disabled={disabled || busy}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="homepage-account"
            aria-label="Profile"
            data-testid="homepage-account"
          />
        }
      >
        <ProfileAvatar
          imageUrl={imageUrl}
          className="homepage-profile-avatar"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="homepage-theme homepage-profile-menu"
        data-testid="homepage-profile-menu"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="homepage-profile-menu-identity">
            <ProfileAvatar
              imageUrl={imageUrl}
              className="homepage-profile-menu-avatar"
            />
            <span className="homepage-profile-menu-text">
              <span className="homepage-profile-menu-name">{name}</span>
              <span className="homepage-profile-menu-email">
                {email ?? (signedIn ? "Signed In" : "Not Signed In")}
              </span>
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {onManageAccount && (
            <DropdownMenuItem onClick={onManageAccount}>
              <UserRoundCogIcon />
              Account Settings
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onSubscription}>
            <CreditCardIcon />
            Manage Subscription
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {(onApplicationSettings || onEngineSettings) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onApplicationSettings && (
                <DropdownMenuItem onClick={onApplicationSettings}>
                  <AppWindowIcon />
                  Application Settings
                </DropdownMenuItem>
              )}
              {onEngineSettings && (
                <DropdownMenuItem onClick={onEngineSettings}>
                  <Settings2Icon />
                  Engine Settings
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        )}
        {(onSignIn || onSignOut) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onSignIn && (
                <DropdownMenuItem onClick={onSignIn}>
                  <LogInIcon />
                  Sign In
                </DropdownMenuItem>
              )}
              {onSignOut && (
                <DropdownMenuItem
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void onSignOut()
                      .catch((cause: unknown) =>
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Could not sign out.",
                        ),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  <LogOutIcon />
                  Sign Out
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        )}
        {error && (
          <p role="alert" className="p-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
