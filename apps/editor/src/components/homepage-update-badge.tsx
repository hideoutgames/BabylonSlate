import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, RotateCwIcon } from "lucide-react";
import { getAppUpdates, type AppUpdateStatus } from "@haptic/vfs";
import { Button, buttonVariants } from "@haptic/ui/components/button";
import { Progress } from "@haptic/ui/components/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@haptic/ui/components/tooltip";
import { cn } from "@haptic/ui/lib/utils";

/**
 * The desktop app's automatic update in the Homepage sidebar: a progress row
 * while it downloads, then Restart to Update, which installs it and starts the
 * new version. Hosts that do not update themselves show nothing.
 */
export function HomepageUpdateBadge() {
  const updates = useMemo(() => getAppUpdates(), []);
  const [status, setStatus] = useState<AppUpdateStatus>({ state: "idle" });
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!updates) return;
    let active = true;
    const unsubscribe = updates.subscribe((next) => setStatus(next));
    void updates.status().then(
      (current) => {
        if (active) setStatus(current);
      },
      () => {
        /* No badge without a status. */
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [updates]);

  if (status.state === "downloading")
    return (
      <Progress
        value={status.percent}
        aria-label="Downloading Update"
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "homepage-sidebar-badge homepage-update-download",
        )}
      >
        <DownloadIcon className="homepage-sidebar-badge-icon" />
        <span className="homepage-sidebar-badge-label">Downloading Update</span>
      </Progress>
    );
  if (status.state !== "ready" || !updates) return null;
  const restart = () => {
    setRestarting(true);
    void updates.restart().then(
      (restarted) => {
        if (!restarted) setRestarting(false);
      },
      () => setRestarting(false),
    );
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            className="homepage-sidebar-badge"
            disabled={restarting}
            onClick={restart}
          />
        }
      >
        <RotateCwIcon className="homepage-sidebar-badge-icon" />
        <span className="homepage-sidebar-badge-label">Restart to Update</span>
      </TooltipTrigger>
      <TooltipContent side="right">Version {status.version}</TooltipContent>
    </Tooltip>
  );
}
