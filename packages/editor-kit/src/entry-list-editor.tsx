import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { FieldGroup } from "@babylonslate/ui/components/field";

export type EntryListItemRenderArgs<T> = {
  item: T;
  index: number;
  onChange: (value: T) => void;
};

export type EntryListEditorProps<T> = {
  items: readonly T[];
  onChange: (items: T[]) => void;
  onCreate: () => T;
  renderItem: (args: EntryListItemRenderArgs<T>) => ReactNode;
  title?: string;
  addLabel?: string;
  "data-testid"?: string;
};

function moveItem<T>(items: readonly T[], index: number, delta: number): T[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= items.length) return [...items];
  const next = [...items];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

/** Reorderable typed rows with 44px add/remove/move targets. */
export function EntryListEditor<T>({
  items,
  onChange,
  onCreate,
  renderItem,
  title,
  addLabel = "Add",
  "data-testid": testId,
}: EntryListEditorProps<T>) {
  const rootId = testId ?? "entry-list";

  return (
    <div className="flex flex-col gap-2" data-testid={rootId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {items.map((item, index) => (
        <FieldGroup
          key={index}
          className="rounded-md border border-border p-2"
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              {renderItem({
                item,
                index,
                onChange: (next) => {
                  const rows = [...items];
                  rows[index] = next;
                  onChange(rows);
                },
              })}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Move row ${index + 1} up`}
              data-testid={`${rootId}-${index}-move-up`}
              disabled={index === 0}
              onClick={() => onChange(moveItem(items, index, -1))}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Move row ${index + 1} down`}
              data-testid={`${rootId}-${index}-move-down`}
              disabled={index === items.length - 1}
              onClick={() => onChange(moveItem(items, index, 1))}
            >
              <ChevronDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="touch"
              aria-label={`Remove row ${index + 1}`}
              data-testid={`${rootId}-${index}-remove`}
              onClick={() =>
                onChange(items.filter((_, rowIndex) => rowIndex !== index))
              }
            >
              Remove
            </Button>
          </div>
        </FieldGroup>
      ))}
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="w-fit"
        data-testid={`${rootId}-add`}
        onClick={() => onChange([...items, onCreate()])}
      >
        {addLabel}
      </Button>
    </div>
  );
}
