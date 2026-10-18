import { useEffect, useState } from "react";
import {
  NewspaperIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleUserRoundIcon,
  LogInIcon,
  LogOutIcon,
  Settings2Icon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@babylonslate/ui/components/dropdown-menu";
import { HomepageAccountCenter } from "./homepage-account-center";

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
  onEngineSettings?: () => void;
  onChangelog?: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const signedIn = Boolean(onSignOut);
  const status =
    description ?? email ?? (signedIn ? "Signed In" : "Not Signed In");
  useEffect(() => {
    onOpenChange?.(menuOpen || accountOpen);
  }, [menuOpen, accountOpen, onOpenChange]);
  const signOut = onSignOut
    ? () => {
        setBusy(true);
        setError(null);
        void onSignOut()
          .catch((cause: unknown) =>
            setError(
              cause instanceof Error ? cause.message : "Could not sign out.",
            ),
          )
          .finally(() => setBusy(false));
      }
    : undefined;
  return (
    <>
      <DropdownMenu onOpenChange={setMenuOpen}>
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
            <span className="homepage-account-status">{status}</span>
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
            <DropdownMenuItem
              className="homepage-profile-menu-identity"
              data-testid="homepage-account-open"
              onClick={() => setAccountOpen(true)}
            >
              <ProfileAvatar
                imageUrl={imageUrl}
                className="homepage-profile-menu-avatar"
              />
              <span className="homepage-profile-menu-text">
                <span className="homepage-profile-menu-name">{name}</span>
                <span className="homepage-profile-menu-email">Manage Account</span>
              </span>
              <ChevronRightIcon className="homepage-profile-menu-chevron" />
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {(onEngineSettings || onChangelog) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {onEngineSettings && (
                  <DropdownMenuItem onClick={onEngineSettings}>
                    <Settings2Icon />
                    Engine Settings
                  </DropdownMenuItem>
                )}
                {onChangelog && (
                  <DropdownMenuItem onClick={onChangelog}>
                    <NewspaperIcon />
                    Changelog
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
                {signOut && (
                  <DropdownMenuItem disabled={busy} onClick={signOut}>
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
      <HomepageAccountCenter
        open={accountOpen}
        onOpenChange={setAccountOpen}
        name={name}
        status={status}
        imageUrl={imageUrl}
        busy={busy}
        onSignIn={onSignIn}
        onSignOut={signOut}
        signOutLabel={signOutLabel}
        onManageAccount={onManageAccount}
      />
    </>
  );
}
