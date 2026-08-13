import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";

export type NamedListItemRenderArgs = {
  value: string;
  index: number;
  onChange: (value: string) => void;
};

export interface NamedListEditorProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  title?: string;
  addPlaceholder?: string;
  addLabel?: string;
  renderItem?: (args: NamedListItemRenderArgs) => ReactNode;
  "data-testid"?: string;
}

function moveItem(values: readonly string[], index: number, delta: number): string[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= values.length) return [...values];
  const next = [...values];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

/** Reorderable named string rows with 44px add/remove/move targets. */
export function NamedListEditor({
  values,
  onChange,
  title,
  addPlaceholder = "name",
  addLabel = "Add",
  renderItem,
  "data-testid": testId,
}: NamedListEditorProps) {
  const [draft, setDraft] = useState("");
  const rootId = testId ?? "named-list";

  return (
    <div className="flex flex-col gap-2" data-testid={rootId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {values.map((value, index) => (
        <FieldGroup
          key={`${value}-${index}`}
          className="rounded-md border border-border p-2"
        >
          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-32 flex-1">
              {renderItem ? (
                renderItem({
                  value,
                  index,
                  onChange: (next) => {
                    const rows = [...values];
                    rows[index] = next;
                    onChange(rows);
                  },
                })
              ) : (
                <>
                  <FieldLabel htmlFor={`${rootId}-${index}-value`}>
                    Name
                  </FieldLabel>
                  <Input
                    id={`${rootId}-${index}-value`}
                    className="min-h-[var(--touch-target,44px)]"
                    value={value}
                    onChange={(event) => {
                      const rows = [...values];
                      rows[index] = event.target.value;
                      onChange(rows);
                    }}
                    data-testid={`${rootId}-${index}-value`}
                  />
                </>
              )}
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Move row ${index + 1} up`}
              data-testid={`${rootId}-${index}-move-up`}
              disabled={index === 0}
              onClick={() => onChange(moveItem(values, index, -1))}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Move row ${index + 1} down`}
              data-testid={`${rootId}-${index}-move-down`}
              disabled={index === values.length - 1}
              onClick={() => onChange(moveItem(values, index, 1))}
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
                onChange(values.filter((_, rowIndex) => rowIndex !== index))
              }
            >
              Remove
            </Button>
          </div>
        </FieldGroup>
      ))}
      <Field>
        <FieldLabel htmlFor={`${rootId}-add-value`}>{addLabel}</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={`${rootId}-add-value`}
            className="min-h-[var(--touch-target,44px)] min-w-0 flex-1"
            value={draft}
            placeholder={addPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            data-testid={`${rootId}-add-value`}
          />
          <Button
            type="button"
            variant="outline"
            size="touch"
            data-testid={`${rootId}-add`}
            onClick={() => {
              const name = draft.trim();
              if (!name) return;
              onChange([...values, name]);
              setDraft("");
            }}
          >
            {addLabel}
          </Button>
        </div>
      </Field>
    </div>
  );
}
