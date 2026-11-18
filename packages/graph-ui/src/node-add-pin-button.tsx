import { PlusIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { useGraphEditorContext } from "./graph-editor-context";
import { addPinOf } from "./graph-types";

/**
 * A node's **+ Add Pin** row below its pins, on the side its `__addPin` names (`addPinOf`): one
 * more pin through `GraphEditor.onAddPin`. Not shown read-only or without that host callback. It
 * is not a pin: no handle, never a wire's target. A press neither drags nor selects the node, and
 * Enter or Space activates it.
 */
export function NodeAddPinButton({ nodeId, data }: { nodeId: string; data: Record<string, unknown> }) {
  const { onAddPin } = useGraphEditorContext();
  const addPin = addPinOf(data);
  if (!addPin || !onAddPin) return null;
  const add = () => onAddPin(nodeId);
  return (
    <div
      data-add-pin-side={addPin.side}
      className={cn(
        "flex min-h-[var(--touch-target,44px)] w-full items-center gap-1",
        addPin.side === "out" ? "justify-end" : "justify-start",
      )}
    >
      {addPin.side === "in" ? <span className="size-[var(--graph-pin-hit,44px)] shrink-0" /> : null}
      <Button
        type="button"
        variant="ghost"
        // Node chrome is drawn at twice chrome scale, so the label matches a pin name (16px); the
        // 32px button reaches a 44px hit area through its `after` box without growing the row.
        className={cn(
          "nodrag nokey nopan relative h-8 gap-1.5 px-2 text-base font-normal leading-snug text-muted-foreground",
          "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
        )}
        data-testid="graph-node-add-pin"
        aria-label={addPin.label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          add();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          // Taken here so the canvas neither selects the node nor runs a key command, and the
          // button's own click does not follow.
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) add();
        }}
      >
        <PlusIcon aria-hidden="true" className="size-5" />
        {addPin.label}
      </Button>
      {addPin.side === "out" ? <span className="size-[var(--graph-pin-hit,44px)] shrink-0" /> : null}
    </div>
  );
}
