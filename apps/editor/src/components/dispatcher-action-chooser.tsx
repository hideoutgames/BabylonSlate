import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import type { DispatcherDropAction } from "../lib/class-members";

const ACTIONS: ReadonlyArray<{ action: DispatcherDropAction; label: string; eventGraphOnly?: boolean }> = [
  { action: "call", label: "Call" },
  { action: "bind", label: "Bind" },
  { action: "unbind", label: "Unbind" },
  { action: "unbindAll", label: "Unbind All" },
  { action: "event", label: "Event", eventGraphOnly: true },
  { action: "assign", label: "Assign", eventGraphOnly: true },
];

export type DispatcherActionChooserProps = {
  open: boolean;
  dispatcherName: string;
  /** Event Dispatchers the choice applies to; with several, each gets the chosen node. */
  dispatcherCount?: number;
  /** Event and Assign add a custom event, which only the Event Graph holds. */
  inEventGraph?: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (action: DispatcherDropAction) => void;
};

/** Unreal's dispatcher drop menu: Call, Bind, Unbind, Unbind All, Event or Assign. */
export function DispatcherActionChooser({
  open,
  dispatcherName,
  dispatcherCount = 1,
  inEventGraph = true,
  onOpenChange,
  onChoose,
}: DispatcherActionChooserProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dispatcher-action-chooser">
        <DialogHeader>
          <DialogTitle>{dispatcherName}</DialogTitle>
          <DialogDescription>
            {dispatcherCount > 1
              ? "Add a node for each Event Dispatcher to the graph."
              : "Add a node for this Event Dispatcher to the graph."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton={false} className="flex-wrap">
          {ACTIONS.filter((entry) => inEventGraph || !entry.eventGraphOnly).map((entry) => (
            <Button
              key={entry.action}
              type="button"
              variant="outline"
              data-testid={`dispatcher-action-${entry.action}`}
              onClick={() => onChoose(entry.action)}
            >
              {entry.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
