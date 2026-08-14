import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Button } from "@babylonslate/ui/components/button";
import type { NavBakePhase } from "../lib/nav-bake";

export type NavBakeDialogProps = {
  open: boolean;
  phase: NavBakePhase;
  cancellable?: boolean;
  onCancel?: () => void;
  error?: string | null;
};

const PHASE_COPY: Record<NavBakePhase, string> = {
  showing: "Preparing bake…",
  collecting: "Collecting geometry (main thread, may pause briefly)",
  generating: "Generating navmesh in bake worker…",
  writing: "Writing Scene navmesh chunk…",
};

export function NavBakeDialog({
  open,
  phase,
  cancellable = false,
  onCancel,
  error,
}: NavBakeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        data-testid="nav-bake-dialog"
      >
        <DialogHeader>
          <DialogTitle>Baking navmesh</DialogTitle>
          <DialogDescription>
            Recast generation never runs at Play start. Geometry merge stays on
            the main thread; voxelisation runs in a dedicated worker.
          </DialogDescription>
        </DialogHeader>
        <p
          data-testid="nav-bake-phase"
          className="text-sm text-muted-foreground"
        >
          {error ?? PHASE_COPY[phase]}
        </p>
        {cancellable ? (
          <Button
            type="button"
            variant="outline"
            data-testid="nav-bake-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
