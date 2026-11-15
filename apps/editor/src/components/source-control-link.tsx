import { lazy, Suspense } from "react";
import { TriangleAlertIcon } from "lucide-react";
import type { DeviceSignInHost } from "@haptic/source-control/device-flow";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";

/** The use-at-your-own-risk warning shown before every link; nothing is stored unless Accept is chosen. */
export function LinkHostWarningDialog({
  label,
  open,
  onDecline,
  onAccept,
}: {
  label: string;
  open: boolean;
  onDecline: () => void;
  onAccept: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onDecline(); }}>
      <AlertDialogContent data-testid="source-control-link-warning">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-(--warning)/15 text-(--warning)">
            <TriangleAlertIcon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Link {label}?</AlertDialogTitle>
          <AlertDialogDescription render={<div className="flex flex-col gap-2" />}>
            <p>Haptic will clone, pull, commit, push and lock files in your repositories from this device.</p>
            <p>
              You use this integration at your own risk. Haptic is not responsible for lost work, overwritten files or
              other problems that result from using it.
            </p>
            <p>Keep backups of important projects.</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="source-control-link-decline">Decline</AlertDialogCancel>
          <AlertDialogAction data-testid="source-control-link-accept" onClick={onAccept}>
            Accept
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Device sign-in and the credential store load only once a link is accepted.
const SourceControlSignInDialog = lazy(() => import("./source-control-sign-in-dialog"));

/** Sign In To GitHub / GitLab, loaded on first use. */
export function HostSignInDialog(props: { host: DeviceSignInHost; onDone: (linked: boolean) => void }) {
  return (
    <Suspense fallback={null}>
      <SourceControlSignInDialog {...props} />
    </Suspense>
  );
}
