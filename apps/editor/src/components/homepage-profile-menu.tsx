import { useState } from "react";
import {
  CircleUserRoundIcon,
  LogInIcon,
  LogOutIcon,
  CreditCardIcon,
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

export function HomepageProfileMenu({
  disabled,
  name = "Guest",
  email,
  imageUrl,
  onSignIn,
  onSignOut,
  onSubscription,
  onOpenChange,
}: {
  disabled?: boolean;
  name?: string;
  email?: string;
  imageUrl?: string;
  onSignIn?: () => void;
  onSignOut?: () => Promise<void>;
  onSubscription: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        disabled={disabled || busy}
        render={
          <Button
            variant="ghost"
            size="touch-icon"
            className="homepage-account"
            aria-label="Profile"
            data-testid="homepage-account"
          />
        }
      >
        {imageUrl && failedImage !== imageUrl ? (
          <img
            className="homepage-profile-avatar"
            src={imageUrl}
            alt=""
            onError={() => setFailedImage(imageUrl)}
          />
        ) : (
          <CircleUserRoundIcon />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={10}
        className="homepage-theme homepage-profile-menu"
        data-testid="homepage-profile-menu"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="homepage-profile-menu-name">{name}</span>
            {email && (
              <span className="homepage-profile-menu-email">{email}</span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {onSignIn && (
            <DropdownMenuItem onClick={onSignIn}>
              <LogInIcon />
              Sign In
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onSubscription}>
            <CreditCardIcon />
            Manage Subscription
          </DropdownMenuItem>
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
        {error && (
          <p role="alert" className="p-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
