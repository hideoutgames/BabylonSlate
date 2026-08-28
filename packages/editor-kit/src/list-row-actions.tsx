import { ChevronDownIcon, ChevronUpIcon, Trash2Icon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";

export type ListRowActionsProps = {
  index: number;
  count: number;
  /** Accessible name fragment (`Move {name} up`). Defaults to `row N`. */
  name?: string;
  testIdPrefix: string;
  /** When set, test ids use this instead of the row index. */
  rowId?: string;
  onMove: (delta: number) => void;
  onRemove: () => void;
};

/** Compact up / down / trash cluster matching PinListEditor row actions. */
export function ListRowActions({
  index,
  count,
  name,
  testIdPrefix,
  rowId,
  onMove,
  onRemove,
}: ListRowActionsProps) {
  const label = name ?? `row ${index + 1}`;
  const id = rowId ?? String(index);

  return (
    <div className="flex shrink-0 items-center gap-0 self-center">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={`Move ${label} up`}
        data-testid={`${testIdPrefix}-${id}-move-up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={`Move ${label} down`}
        data-testid={`${testIdPrefix}-${id}-move-down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={`Remove ${label}`}
        data-testid={`${testIdPrefix}-${id}-remove`}
        onClick={onRemove}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
