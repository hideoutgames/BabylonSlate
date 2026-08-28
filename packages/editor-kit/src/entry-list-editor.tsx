import type { ReactNode } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { FieldGroup } from "@babylonslate/ui/components/field";
import { ListRowActions } from "./list-row-actions";

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

/** Reorderable typed rows with a compact up / down / trash cluster. */
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
    <div className="flex flex-col gap-1" data-testid={rootId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {items.map((item, index) => (
        <FieldGroup
          key={index}
          className="rounded-md border border-border px-1 py-0.5"
        >
          <div className="flex flex-nowrap items-center gap-1">
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
            <ListRowActions
              index={index}
              count={items.length}
              testIdPrefix={rootId}
              onMove={(delta) => onChange(moveItem(items, index, delta))}
              onRemove={() =>
                onChange(items.filter((_, rowIndex) => rowIndex !== index))
              }
            />
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
