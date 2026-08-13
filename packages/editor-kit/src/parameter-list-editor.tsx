import { useState } from "react";
import { PinListEditor, type PinListRow } from "./pin-list-editor";

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

function asParameterRows(rows: PinListRow[]): ParameterRow[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: (PARAMETER_VALUE_TYPES as readonly string[]).includes(row.type)
      ? (row.type as ParameterValueType)
      : "float",
    optional: row.optional,
    defaultValue: row.defaultValue,
    enumValues: row.enumValues,
  }));
}

/** Thin PinListEditor wrapper for Execute JavaScript / On Command Run. */
export function ParameterListEditor({
  rows,
  onChange,
  title = "Parameters",
}: ParameterListEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    rows[0]?.id ?? null,
  );

  return (
    <PinListEditor
      rows={rows}
      onChange={(next) => onChange(asParameterRows(next))}
      title={title}
      selectedId={selectedId}
      onSelect={setSelectedId}
      types={PARAMETER_VALUE_TYPES}
      testIdPrefix="parameter"
      data-testid="parameter-list-editor"
    />
  );
}
