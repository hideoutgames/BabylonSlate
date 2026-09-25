import { useState, type ReactNode } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { ListRowActions } from "./list-row-actions";

export type NamedListItemRenderArgs = {
  value: string;
  index: number;
  onChange: (value: string) => void;
};

export interface NamedListEditorProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  title?: string;
  /** Accessible row name, numbered per row. */
  itemLabel?: string;
  addPlaceholder?: string;
  addLabel?: string;
  /** When set, Add is a button only — used for asset-pick rows. */
  onAdd?: () => void;
  renderItem?: (args: NamedListItemRenderArgs) => ReactNode;
  "data-testid"?: string;
}

const ROW_CONTROL =
  "min-h-[var(--chrome-row,28px)] pointer-coarse:min-h-[var(--touch-target,44px)]";

function moveItem(values: readonly string[], index: number, delta: number): string[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= values.length) return [...values];
  const next = [...values];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

/** Reorderable named string rows with a compact up / down / trash cluster. */
export function NamedListEditor({
  values,
  onChange,
  title,
  itemLabel = "Name",
  addPlaceholder = "name",
  addLabel = "Add",
  onAdd,
  renderItem,
  "data-testid": testId,
}: NamedListEditorProps) {
  const [draft, setDraft] = useState("");
  const rootId = testId ?? "named-list";
  const addDraft = () => {
    const name = draft.trim();
    if (!name) return;
    onChange([...values, name]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1" data-testid={rootId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {values.map((value, index) => (
        <div key={`${value}-${index}`} className="px-1 py-0.5">
          <div className="flex flex-nowrap items-center gap-1">
            {renderItem ? (
              <div className="min-w-0 flex-1">
                {renderItem({
                  value,
                  index,
                  onChange: (next) => {
                    const rows = [...values];
                    rows[index] = next;
                    onChange(rows);
                  },
                })}
              </div>
            ) : (
              <Input
                id={`${rootId}-${index}-value`}
                aria-label={`${itemLabel} ${index + 1}`}
                className={`${ROW_CONTROL} min-w-0 flex-1`}
                value={value}
                onChange={(event) => {
                  const rows = [...values];
                  rows[index] = event.target.value;
                  onChange(rows);
                }}
                data-testid={`${rootId}-${index}-value`}
              />
            )}
            <ListRowActions
              index={index}
              count={values.length}
              testIdPrefix={rootId}
              touchAdaptive
              onMove={(delta) => onChange(moveItem(values, index, delta))}
              onRemove={() =>
                onChange(values.filter((_, rowIndex) => rowIndex !== index))
              }
            />
          </div>
        </div>
      ))}
      {onAdd ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={`${ROW_CONTROL} ml-1 w-fit`}
          data-testid={`${rootId}-add`}
          onClick={onAdd}
        >
          {addLabel}
        </Button>
      ) : (
        <div className="flex gap-1 px-1 py-0.5">
          <Input
            id={`${rootId}-add-value`}
            aria-label={addLabel}
            className={`${ROW_CONTROL} min-w-0 flex-1`}
            value={draft}
            placeholder={addPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addDraft();
            }}
            data-testid={`${rootId}-add-value`}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={ROW_CONTROL}
            data-testid={`${rootId}-add`}
            onClick={addDraft}
          >
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
