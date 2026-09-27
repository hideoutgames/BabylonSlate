import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";
import type { TextureUsageNotification } from "../lib/use-particle-texture-usage";

/**
 * Status callouts for **Set Usage To Particle** fixes, shown where the fix was
 * clicked: what changed, with **Undo** (the previous Usage, saved the same
 * way) and **Dismiss**. A failed save or Undo keeps the callout and says why.
 */
export function TextureUsageNotifications({
  notifications,
  className,
}: {
  notifications: readonly TextureUsageNotification[];
  className?: string;
}) {
  if (notifications.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {notifications.map((notification) => (
        <Alert
          key={notification.textureGuid}
          role="status"
          data-testid={`texture-usage-notification-${notification.textureGuid}`}
        >
          {notification.failed ? <TriangleAlertIcon /> : <CircleCheckIcon />}
          <AlertDescription className="flex flex-col items-start gap-2">
            <div>{notification.message}</div>
            <div className="flex flex-wrap gap-1">
              {notification.undo ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="pointer-coarse:min-h-11"
                  disabled={notification.undoing}
                  onClick={notification.undo}
                  data-testid={`texture-usage-undo-${notification.textureGuid}`}
                >
                  Undo
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="pointer-coarse:min-h-11"
                onClick={notification.dismiss}
              >
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
