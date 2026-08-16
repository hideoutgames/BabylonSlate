import { Alert, AlertAction, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import {
  formatLockAge,
  type SourceControlService,
} from "../services/source-control-service";

export function DocumentLockBanner({
  path,
  sourceControl,
}: {
  path: string;
  sourceControl: SourceControlService;
}) {
  const banner = sourceControl.bannerFor(path);
  if (!banner) return null;
  if (banner.kind === "theirs") {
    return (
      <Alert data-testid="document-lock-banner" data-lock-banner="theirs">
        <AlertTitle>Locked by {banner.lock.ownerName}</AlertTitle>
        <AlertDescription>
          {formatLockAge(banner.lock.lockedAt)}
        </AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-target,44px)]"
            data-testid="document-lock-edit-anyway"
            onClick={() => sourceControl.setEditAnyway(path)}
          >
            Edit Anyway
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <Alert
      variant="destructive"
      data-testid="document-lock-banner"
      data-lock-banner="unlocked"
    >
      <AlertTitle>Unlocked</AlertTitle>
      <AlertDescription>{banner.message}</AlertDescription>
    </Alert>
  );
}
