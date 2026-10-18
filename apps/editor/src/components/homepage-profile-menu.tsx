import { useState } from "react";
import {
  AppWindowIcon,
  NewspaperIcon,
  ChevronsUpDownIcon,
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
  description,
  imageUrl,
  onSignIn,
  onSignOut,
  signOutLabel = "Sign Out",
  onManageAccount,
  onSubscription,
  onApplicationSettings,
  onEngineSettings,
  onChangelog,
  onOpenChange,
}: {
  disabled?: boolean;
  name?: string;
  email?: string;
  description?: string;
  imageUrl?: string;
  onSignIn?: () => void;
  onSignOut?: () => Promise<void>;
  signOutLabel?: string;
  onManageAccount?: () => void;
  onSubscription: () => void;
  onApplicationSettings?: () => void;
  onEngineSettings?: () => void;
  onChangelog?: () => void;
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
            size="sm"
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
        <span className="homepage-account-text">
          <span className="homepage-account-name">{name}</span>
          <span className="homepage-account-status">
            {description ?? email ?? (signedIn ? "Signed In" : "Not Signed In")}
          </span>
        </span>
        <ChevronsUpDownIcon className="homepage-account-chevron" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
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
                {description ?? email ?? (signedIn ? "Signed In" : "Not Signed In")}
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
        {onChangelog && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onChangelog}>
                <NewspaperIcon />
                Changelog
              </DropdownMenuItem>
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
                  {signOutLabel}
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
