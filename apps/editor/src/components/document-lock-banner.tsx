import { Alert, AlertAction, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import { LockIcon } from "lucide-react";
import {
  formatLockAge,
  type SourceControlService,
} from "../services/source-control-service";

export function DocumentLockBanner({
  path,
  sourceControl,
  authoringReason,
}: {
  path: string;
  sourceControl: SourceControlService;
  authoringReason?: string | null;
}) {
  // One slim line: the running Simulation keeps the panels below in view.
  if (authoringReason) return <div role="status" title={authoringReason} data-testid="document-authoring-lock-banner"
    className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-panel-header px-2 py-1 text-xs text-muted-foreground">
    <LockIcon className="size-3.5 shrink-0" aria-hidden />
    <span className="shrink-0 font-medium text-foreground">Read-Only During Simulation</span>
    <span className="truncate">Navigation, selection and copying still work.</span>
  </div>;
  const banner = sourceControl.bannerFor(path);
  if (!banner) return null;
  if (banner.kind === "theirs") {
    return (
      <Alert data-testid="document-lock-banner" data-lock-banner="theirs">
        <AlertTitle>Locked by {banner.lock.ownerName}</AlertTitle>
        <AlertDescription>
          {formatLockAge(banner.lock.lockedAt)}. Editing anyway may conflict
          with their changes. Coordinate with the lock owner before saving.
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
