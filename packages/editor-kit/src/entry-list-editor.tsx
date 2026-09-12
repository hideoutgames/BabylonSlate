import type { ReactNode } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { FieldGroup } from "@babylonslate/ui/components/field";
import { cn } from "@babylonslate/ui/lib/utils";
import { ListRowActions } from "./list-row-actions";

export type EntryListItemRenderArgs<T> = {
  item: T;
  index: number;
  onChange: (value: T) => void;
};

export type EntryListEditorProps<T> = {
  items: readonly T[];
  onChange: (items: T[]) => void;
  renderItem: (args: EntryListItemRenderArgs<T>) => ReactNode;
  /** Full-width identity above compact controls and row actions. */
  renderItemHeader?: (args: EntryListItemRenderArgs<T>) => ReactNode;
  title?: string;
  minItems?: number;
  maxItems?: number;
  addLabel?: string;
  /** Count copy next to Add (`1 item` / `2 items`). Map uses entry/entries. */
  countNoun?: { one: string; other: string };
  "data-testid"?: string;
} & (
  { onCreate: () => T; onAdd?: never } | { onCreate?: never; onAdd: () => void }
);

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
  onAdd,
  renderItem,
  renderItemHeader,
  title,
  minItems = 0,
  maxItems = Number.POSITIVE_INFINITY,
  addLabel = "Add",
  countNoun = { one: "item", other: "items" },
  "data-testid": testId,
}: EntryListEditorProps<T>) {
  const rootId = testId ?? "entry-list";
  const countLabel = `${items.length} ${
    items.length === 1 ? countNoun.one : countNoun.other
  }`;

  return (
    <div className="flex flex-col gap-1" data-testid={rootId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {items.map((item, index) => {
        const args: EntryListItemRenderArgs<T> = {
          item,
          index,
          onChange: (next) => {
            const rows = [...items];
            rows[index] = next;
            onChange(rows);
          },
        };
        return (
          <FieldGroup
            key={index}
            data-testid={`${rootId}-${index}-row`}
            className="rounded-md border border-border px-1 py-0.5 gap-1"
          >
            {renderItemHeader?.(args)}
            <div
              className={cn(
                "flex items-center gap-1",
                renderItemHeader ? "flex-wrap" : "flex-nowrap",
              )}
            >
              <div
                className={cn("min-w-0 flex-1", renderItemHeader && "basis-32")}
              >
                {renderItem(args)}
              </div>
              <ListRowActions
                index={index}
                count={items.length}
                removeDisabled={items.length <= minItems}
                testIdPrefix={rootId}
                touchAdaptive={!!renderItemHeader}
                onMove={(delta) => onChange(moveItem(items, index, delta))}
                onRemove={() =>
                  onChange(items.filter((_, rowIndex) => rowIndex !== index))
                }
              />
            </div>
          </FieldGroup>
        );
      })}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size={renderItemHeader ? "sm" : "touch"}
          className={cn("w-fit", renderItemHeader && "pointer-coarse:min-h-11")}
          data-testid={`${rootId}-add`}
          disabled={items.length >= maxItems}
          onClick={() => {
            if (onAdd) onAdd();
            else if (onCreate) onChange([...items, onCreate()]);
          }}
        >
          {addLabel}
        </Button>
        <span
          className="text-xs text-muted-foreground"
          data-testid={`${rootId}-count`}
        >
          {countLabel}
        </span>
      </div>
    </div>
  );
}
