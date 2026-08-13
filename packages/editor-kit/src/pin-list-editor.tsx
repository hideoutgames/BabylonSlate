import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { NamedListEditor } from "./named-list-editor";
import { TypeColorMark } from "./type-color-mark";
import { PinTypePicker } from "./pin-type-picker";
import {
  pinPickerColorVar,
  type PinPickerType,
} from "./pin-types";

export type PinListRow = {
  id: string;
  name: string;
  type: PinPickerType | string;
  direction?: "in" | "out";
  optional?: boolean;
  defaultValue?: string;
  enumValues?: readonly string[];
};

export type PinListEditorProps = {
  rows: PinListRow[];
  onChange: (rows: PinListRow[]) => void;
  title?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  showDirection?: boolean;
  types?: readonly PinPickerType[];
  testIdPrefix?: string;
  "data-testid"?: string;
};

function patchRow(
  rows: PinListRow[],
  id: string,
  patch: Partial<PinListRow>,
): PinListRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

function moveRow(
  rows: PinListRow[],
  index: number,
  delta: number,
): PinListRow[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= rows.length) return rows;
  const next = [...rows];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

function addPin(
  rows: PinListRow[],
  name: string,
  direction: "in" | "out" | undefined,
): PinListRow[] {
  return [
    ...rows,
    {
      id: `p_${Date.now()}`,
      name,
      type: "float",
      ...(direction ? { direction } : {}),
    },
  ];
}

/** Compact Unreal-like pin rows: color chip, name, type picker, move/remove. */
export function PinListEditor({
  rows,
  onChange,
  title,
  selectedId,
  onSelect,
  showDirection = false,
  types,
  testIdPrefix = "pin",
  "data-testid": testId = "pin-list-editor",
}: PinListEditorProps) {
  const [draftName, setDraftName] = useState("");

  const commitAdd = (direction?: "in" | "out") => {
    const name = draftName.trim();
    if (!name) return;
    onChange(addPin(rows, name, direction));
    setDraftName("");
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {rows.map((row, index) => {
        const selected = selectedId === row.id;
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div
              className={`flex min-h-[var(--chrome-row,28px)] items-center gap-1 rounded-md px-1 ${
                selected ? "bg-accent" : "hover:bg-accent/50"
              }`}
              data-testid={`${testIdPrefix}-row-${row.id}`}
              onClick={() => onSelect?.(row.id)}
            >
              <TypeColorMark colorVar={pinPickerColorVar(row.type)} />
              <Input
                className="h-7 min-h-7 min-w-0 flex-1"
                value={row.name}
                aria-label={`Pin ${index + 1} name`}
                data-testid={`${testIdPrefix}-${row.id}-name`}
                onChange={(event) =>
                  onChange(patchRow(rows, row.id, { name: event.target.value }))
                }
              />
              <PinTypePicker
                value={row.type}
                types={types}
                onChange={(type) => onChange(patchRow(rows, row.id, { type }))}
                data-testid={`${testIdPrefix}-${row.id}-type`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${row.name} up`}
                data-testid={`${testIdPrefix}-${row.id}-move-up`}
                disabled={index === 0}
                onClick={() => onChange(moveRow(rows, index, -1))}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${row.name} down`}
                data-testid={`${testIdPrefix}-${row.id}-move-down`}
                disabled={index === rows.length - 1}
                onClick={() => onChange(moveRow(rows, index, 1))}
              >
                <ChevronDownIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${row.name}`}
                onClick={() =>
                  onChange(rows.filter((entry) => entry.id !== row.id))
                }
              >
                Remove
              </Button>
            </div>
            {selected ? (
              <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
                <Field orientation="horizontal">
                  <Checkbox
                    id={`${testIdPrefix}-${row.id}-optional`}
                    checked={row.optional === true}
                    onCheckedChange={(checked) =>
                      onChange(
                        patchRow(rows, row.id, { optional: checked === true }),
                      )
                    }
                    data-testid={`${testIdPrefix}-${row.id}-optional`}
                  />
                  <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-optional`}>
                    Optional
                  </FieldLabel>
                </Field>
                <Field className="min-w-32 flex-1">
                  <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-default`}>
                    Default
                  </FieldLabel>
                  <Input
                    id={`${testIdPrefix}-${row.id}-default`}
                    className="h-7 min-h-7"
                    value={row.defaultValue ?? ""}
                    data-testid={`${testIdPrefix}-${row.id}-default`}
                    onChange={(event) =>
                      onChange(
                        patchRow(rows, row.id, {
                          defaultValue: event.target.value,
                        }),
                      )
                    }
                  />
                </Field>
                {row.type === "enum" ? (
                  <NamedListEditor
                    values={[...(row.enumValues ?? [])]}
                    onChange={(enumValues) =>
                      onChange(patchRow(rows, row.id, { enumValues }))
                    }
                    title="Enum Values"
                    addPlaceholder="value"
                    addLabel="Add Value"
                    data-testid={`${testIdPrefix}-${row.id}-enum-values`}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      <Field>
        <FieldLabel htmlFor="pin-add-name">Add Pin</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            id="pin-add-name"
            className="h-8 min-h-8 min-w-0 flex-1"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="name"
          />
          {showDirection ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`${testIdPrefix}-add-input`}
                onClick={() => commitAdd("in")}
              >
                Add Input
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`${testIdPrefix}-add-output`}
                onClick={() => commitAdd("out")}
              >
                Add Output
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`${testIdPrefix}-add`}
              onClick={() => commitAdd()}
            >
              Add
            </Button>
          )}
        </div>
      </Field>
    </div>
  );
}
