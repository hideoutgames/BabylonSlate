import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";

export type MemberAccessChooserProps = {
  open: boolean;
  memberName: string;
  onOpenChange: (open: boolean) => void;
  onChoose: (access: "get" | "set") => void;
};

/** Small Get/Set chooser after dropping a variable onto the graph. */
export function MemberAccessChooser({
  open,
  memberName,
  onOpenChange,
  onChoose,
}: MemberAccessChooserProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="member-access-chooser">
        <DialogHeader>
          <DialogTitle>{memberName}</DialogTitle>
          <DialogDescription>
            Add a Get or Set node to the graph.
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
