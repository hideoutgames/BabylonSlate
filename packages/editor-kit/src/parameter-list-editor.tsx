import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { NamedListEditor } from "./named-list-editor";
import { TypeColorMark } from "./type-color-mark";
import { pinColorVar } from "@babylonslate/ui/lib/data-types";

export const PARAMETER_VALUE_TYPES = [
  "string",
  "float",
  "int",
  "bool",
  "enum",
] as const;

export type ParameterValueType = (typeof PARAMETER_VALUE_TYPES)[number];

export type ParameterRow = {
  id: string;
  name: string;
  type: ParameterValueType;
  optional?: boolean;
  defaultValue?: string;
  enumValues?: readonly string[];
};

export type ParameterListEditorProps = {
  rows: ParameterRow[];
  onChange: (rows: ParameterRow[]) => void;
  title?: string;
};

const PARAMETER_PIN_KIND: Record<ParameterValueType, string> = {
  string: "string",
  float: "float",
  int: "int",
  bool: "bool",
  enum: "enumRef",
};

const TYPE_LABEL: Record<ParameterValueType, string> = {
  string: "String",
  float: "Float",
  int: "Int",
  bool: "Bool",
  enum: "Enum",
};

function patchRow(
  rows: ParameterRow[],
  id: string,
  patch: Partial<ParameterRow>,
): ParameterRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

function moveRow(
  rows: ParameterRow[],
  index: number,
  delta: number,
): ParameterRow[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= rows.length) return rows;
  const next = [...rows];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

/** Shared typed named reorderable row list (ExecuteJavaScript, My Class, interfaces). */
export function ParameterListEditor({
  rows,
  onChange,
  title = "Parameters",
}: ParameterListEditorProps) {
  const [draftName, setDraftName] = useState("");

  return (
    <div className="flex flex-col gap-2" data-testid="parameter-list-editor">
      <div className="text-sm font-medium">{title}</div>
      {rows.map((row, index) => (
        <FieldGroup
          key={row.id}
          className="rounded-md border border-border p-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Field className="min-w-32 flex-1">
              <FieldLabel htmlFor={`parameter-${row.id}-name`}>Name</FieldLabel>
              <Input
                id={`parameter-${row.id}-name`}
                className="min-h-11"
                value={row.name}
                aria-label={`Parameter ${index + 1} name`}
                onChange={(event) =>
                  onChange(patchRow(rows, row.id, { name: event.target.value }))
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Move ${row.name} up`}
              data-testid={`parameter-${row.id}-move-up`}
              disabled={index === 0}
              onClick={() => onChange(moveRow(rows, index, -1))}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Move ${row.name} down`}
              data-testid={`parameter-${row.id}-move-down`}
              disabled={index === rows.length - 1}
              onClick={() => onChange(moveRow(rows, index, 1))}
            >
              <ChevronDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="touch"
              aria-label={`Remove ${row.name}`}
              onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
            >
              Remove
            </Button>
          </div>
          <Field>
            <FieldLabel>Type</FieldLabel>
            <ToggleGroup
              variant="outline"
              size="touch"
              spacing={1}
              value={[row.type]}
              onValueChange={(value) => {
                const next = value[0] as ParameterValueType | undefined;
                if (!next) return;
                onChange(patchRow(rows, row.id, { type: next }));
              }}
              aria-label={`Parameter ${row.name} type`}
            >
              {PARAMETER_VALUE_TYPES.map((type) => (
                <ToggleGroupItem
                  key={type}
                  value={type}
                  aria-label={TYPE_LABEL[type]}
                  data-testid={`parameter-${row.id}-type-${type}`}
                >
                  <TypeColorMark
                    colorVar={pinColorVar(PARAMETER_PIN_KIND[type])}
                    label={TYPE_LABEL[type]}
                  />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Field orientation="horizontal">
              <Checkbox
                id={`parameter-${row.id}-optional`}
                checked={row.optional === true}
                onCheckedChange={(checked) =>
                  onChange(
                    patchRow(rows, row.id, { optional: checked === true }),
                  )
                }
                data-testid={`parameter-${row.id}-optional`}
              />
              <FieldLabel htmlFor={`parameter-${row.id}-optional`}>
                Optional
              </FieldLabel>
            </Field>
            <Field className="min-w-32 flex-1">
              <FieldLabel htmlFor={`parameter-${row.id}-default`}>
                Default
              </FieldLabel>
              <Input
                id={`parameter-${row.id}-default`}
                className="min-h-11"
                value={row.defaultValue ?? ""}
                data-testid={`parameter-${row.id}-default`}
                onChange={(event) =>
                  onChange(
                    patchRow(rows, row.id, { defaultValue: event.target.value }),
                  )
                }
              />
            </Field>
          </div>
          {row.type === "enum" ? (
            <NamedListEditor
              values={[...(row.enumValues ?? [])]}
              onChange={(enumValues) =>
                onChange(patchRow(rows, row.id, { enumValues }))
              }
              title="Enum Values"
              addPlaceholder="value"
              addLabel="Add Value"
              data-testid={`parameter-${row.id}-enum-values`}
            />
          ) : null}
        </FieldGroup>
      ))}
      <Field>
        <FieldLabel htmlFor="parameter-add-name">Add Parameter</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="parameter-add-name"
            className="min-h-11 min-w-0 flex-1"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="name"
          />
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => {
              const name = draftName.trim();
              if (!name) return;
              onChange([
                ...rows,
                {
                  id: `p_${Date.now()}`,
                  name,
                  type: "float",
                },
              ]);
              setDraftName("");
            }}
          >
            Add
          </Button>
        </div>
      </Field>
    </div>
  );
}
