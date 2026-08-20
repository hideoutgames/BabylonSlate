import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import type { VariableAccessKind } from "../lib/class-members";

export type MemberAccessChooserProps = {
  open: boolean;
  memberName: string;
  showValidatedGet?: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (access: VariableAccessKind) => void;
};

/** Small Get/Set chooser after dropping a variable onto the graph. */
export function MemberAccessChooser({
  open,
  memberName,
  showValidatedGet = false,
  onOpenChange,
  onChoose,
}: MemberAccessChooserProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="member-access-chooser">
        <DialogHeader>
          <DialogTitle>{memberName}</DialogTitle>
          <DialogDescription>
            {showValidatedGet
              ? "Add a Get, Validated Get, or Set node to the graph."
              : "Add a Get or Set node to the graph."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton={false}>
          <Button
            type="button"
            variant="outline"
            data-testid="member-access-get"
            onClick={() => onChoose("get")}
          >
            Get
          </Button>
          {showValidatedGet ? (
            <Button
              type="button"
              variant="outline"
              data-testid="member-access-validated-get"
              onClick={() => onChoose("validatedGet")}
            >
              Validated Get
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            data-testid="member-access-set"
            onClick={() => onChoose("set")}
          >
            Set
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
