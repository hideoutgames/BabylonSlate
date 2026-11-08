import type { ReactNode } from "react";
import type { ExtensionField, ExtensionFieldValue, ExtensionFieldValues } from "@haptic/assets";
import { LabelHint, PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { extensionFieldRowId } from "../lib/extension-settings-ui";
import { LazyCodeBodyEditor } from "./lazy-code-editors";

function fieldRow(field: Exclude<ExtensionField, { type: "code" }>, value: ExtensionFieldValue, onChange: (value: ExtensionFieldValue) => void, idPrefix: string, disabled: boolean): PropertyRow {
  const base = {
    id: extensionFieldRowId(idPrefix, field.id),
    label: field.label,
    disabled,
    ...(field.hint ? { description: field.hint } : {}),
  };
  switch (field.type) {
    case "text":
    case "multiline":
      return { ...base, kind: "text", multiline: field.type === "multiline", value: String(value), defaultValue: field.default, onChange };
    case "number":
      return { ...base, kind: "number", value: Number(value), defaultValue: field.default, min: field.min, max: field.max,
        ...(field.integer ? { precision: 0, sensitivity: 1 } : {}), ...(field.unit ? { unit: field.unit } : {}),
        onChange: (next) => onChange(field.integer ? Math.round(next) : next) };
    case "toggle":
      return { ...base, kind: "boolean", value: value === true, defaultValue: field.default, onChange };
    case "choice":
      return { ...base, kind: "enum", value: String(value), defaultValue: field.default, options: field.options, onChange };
  }
}

/**
 * Renders an extension's declarative fields with the editor's own controls:
 * runs of ordinary fields as one PropertyGrid, code fields as code editors.
 */
export function ExtensionFieldList({ fields, values, onChange, idPrefix, disabled = false, gridClassName }: {
  fields: readonly ExtensionField[];
  values: ExtensionFieldValues;
  onChange(fieldId: string, value: ExtensionFieldValue): void;
  idPrefix: string;
  disabled?: boolean;
  /** Wraps each PropertyGrid, such as `settings-row` on settings pages. */
  gridClassName?: string;
}) {
  const parts: ReactNode[] = [];
  let rows: PropertyRow[] = [];
  const flush = () => {
    if (!rows.length) return;
    parts.push(<div key={`grid-${parts.length}`} className={gridClassName}><PropertyGrid rows={rows} /></div>);
    rows = [];
  };
  for (const field of fields) {
    const value = values[field.id] ?? field.default;
    if (field.type !== "code") {
      rows.push(fieldRow(field, value, (next) => onChange(field.id, next), idPrefix, disabled));
      continue;
    }
    flush();
    const label = <FieldLabel>{field.label}</FieldLabel>;
    parts.push(<Field key={field.id} className="min-w-0">
      {field.hint ? <LabelHint hint={field.hint}>{label}</LabelHint> : label}
      <div className="flex h-64 min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border" role="group" aria-label={field.label}>
        <LazyCodeBodyEditor language={field.language} ariaLabel={field.label} value={String(value)} readOnly={disabled} onChange={(next) => onChange(field.id, next)} />
      </div>
    </Field>);
  }
  flush();
  return <>{parts}</>;
}
