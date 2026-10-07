import { useId, useState } from "react";
import { parseMapDefaultEntries } from "@babylonslate/core";
import { defaultValueForMember, structInstanceDefault, type StructField } from "@babylonslate/scripting";
import { AssetPicker, ClassPicker, EntryListEditor, PropertyGrid, humanizePropertyLabel, type PropertyRow } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { FieldLegend, FieldSet } from "@babylonslate/ui/components/field";
import { assetPickerAllowedTypes, variableDefaultPropertyRows } from "../lib/graph-inspector";
import { subclassClassEntries } from "../lib/component-property-rows";
import type { useDataCatalog } from "../lib/use-data-catalog";

const TOUCH_ACTION = "pointer-coarse:min-h-11";

/** Compose the same typed controls as Class defaults without hydrating away retired fields. */
export function DataValueEditor({ field, value, defaultValue, onChange, label, path, disabled, catalog, issues, depth = 0, visitedDefinitions = new Set<string>() }: {
  field: StructField & { description?: string; min?: number; max?: number };
  value: unknown;
  defaultValue: unknown;
  onChange: (value: unknown) => void;
  label: string;
  path: string;
  disabled: boolean;
  catalog: ReturnType<typeof useDataCatalog>;
  issues: readonly { code: string; path: string }[];
  depth?: number;
  visitedDefinitions?: ReadonlySet<string>;
}) {
  const id = useId();
  const [assetPicker, setAssetPicker] = useState<{ rowId: string; allowedTypes: string[] } | null>(null);
  const [classPicker, setClassPicker] = useState<{ rowId: string; base: string } | null>(null);
  if (depth > 64) return <p className="text-xs text-destructive">{label}: Data nesting limit exceeded.</p>;
  if (field.container !== "array" && field.container !== "map" && field.typeId === "struct" &&
    field.typeClassId && visitedDefinitions.has(field.typeClassId)) {
    return <p role="alert" className="text-xs text-destructive">{label}: Recursive data fields cannot be edited.</p>;
  }
  const invalid = issues.some((issue) => issue.code === "type-mismatch" && (issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`)));
  const change = (next: unknown) => { if (!disabled) onChange(next); };
  const shared = { disabled, catalog, issues, depth: depth + 1, visitedDefinitions };
  const seed = (typeId: string, typeClassId?: string) => ["object", "actor", "wildcard"].includes(typeId) ? null : defaultValueForMember(typeId, typeClassId, catalog.schemas);
  const resetValue = defaultValue === undefined ? (field.container === "array" || field.container === "map" ? [] : seed(field.typeId, field.typeClassId)) : defaultValue;
  if (field.container === "array" || field.container === "map") {
    const single = { ...field, container: "single" as const };
    const malformed = !Array.isArray(value) || (field.container === "map" && value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || !("key" in entry) || !("value" in entry)));
    const canReset = invalid || JSON.stringify(value) !== JSON.stringify(resetValue);
    return <FieldSet disabled={disabled} aria-label={label} className={depth === 0 ? "gap-1 border-b border-border/30 px-2 py-1" : "gap-1"} data-data-field={path}>
      <FieldLegend variant="label" className="mb-0 flex items-center gap-1">{label}{canReset ? <Button size="xs" variant="ghost" className={TOUCH_ACTION} disabled={disabled} aria-label={`Reset ${label}`} onClick={() => change(structuredClone(resetValue))}>Reset</Button> : null}</FieldLegend>
      {malformed ? <p className="text-xs text-destructive">Reset this invalid collection to edit its entries. The stored value is preserved until reset.</p> : field.container === "array" ? <EntryListEditor
        items={Array.isArray(value) ? value : []} touchAdaptive addLabel="Add Item"
        onCreate={() => seed(field.typeId, field.typeClassId)} onChange={change}
        renderItem={({ item, index, onChange: changeItem }) => <DataValueEditor {...shared} field={single} value={item} defaultValue={seed(field.typeId, field.typeClassId)} onChange={changeItem} label={`${label} Item ${index + 1}`} path={`${path}.${index}`} />}
      /> : <EntryListEditor
        items={parseMapDefaultEntries(value)} touchAdaptive addLabel="Add Entry" countNoun={{ one: "entry", other: "entries" }}
        onCreate={() => ({ key: seed(field.keyTypeId ?? "string", field.keyTypeClassId), value: seed(field.typeId, field.typeClassId) })} onChange={change}
        renderItem={({ item, index, onChange: changeItem }) => <>
          <DataValueEditor {...shared} field={{ name: "Key", typeId: field.keyTypeId ?? "string", typeClassId: field.keyTypeClassId }} value={item.key} defaultValue={seed(field.keyTypeId ?? "string", field.keyTypeClassId)} onChange={(key) => changeItem({ ...item, key })} label={`${label} Key ${index + 1}`} path={`${path}.${index}.key`} />
          <DataValueEditor {...shared} field={single} value={item.value} defaultValue={seed(field.typeId, field.typeClassId)} onChange={(next) => changeItem({ ...item, value: next })} label={`${label} Value ${index + 1}`} path={`${path}.${index}.value`} />
        </>}
      />}
    </FieldSet>;
  }
  const nested = field.typeId === "struct" && field.typeClassId && !["engine:TagContainer", "engine:InputType"].includes(field.typeClassId) ? catalog.schemas.structs[field.typeClassId] : undefined;
  if (nested) {
    const nestedShared = { ...shared, visitedDefinitions: new Set([...visitedDefinitions, field.typeClassId!]) };
    const authored = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const defaults = defaultValue && typeof defaultValue === "object" && !Array.isArray(defaultValue) ? defaultValue as Record<string, unknown> : structInstanceDefault(nested.fields, catalog.schemas);
    return <div className="flex flex-col gap-2" data-data-field={path}>{nested.fields.map((child) => <DataValueEditor {...nestedShared} key={child.id ?? child.name} field={child} value={authored[child.name]} defaultValue={defaults[child.name]} onChange={(next) => change({ ...authored, [child.name]: next })} label={`${label} ${humanizePropertyLabel(child.name)}`} path={`${path}.${child.name}`} />)}</div>;
  }
  const options = {
    typeClassId: field.typeClassId, schemas: catalog.schemas, enumMembers: catalog.enumMembers,
    label, pinId: path, assetEntries: catalog.propertyAssets, classEntries: catalog.classEntries,
    onPickAsset: (rowId: string, type: string) => setAssetPicker({ rowId, allowedTypes: assetPickerAllowedTypes(type, undefined) }),
    onPickClass: (rowId: string, base: string) => setClassPicker({ rowId, base }),
  };
  const generated = variableDefaultPropertyRows(field.typeId, value, change, options);
  const defaultRows = variableDefaultPropertyRows(field.typeId, resetValue, () => undefined, options);
  const rows = generated.map((row, index) => ({ ...row, id: `${id}:${row.id}`, disabled, description: field.description,
    ...(row.kind === "number" ? { min: field.min, max: field.max } : {}),
    defaultValue: invalid ? undefined : defaultRows.find((entry) => entry.id === row.id)?.value,
    labelAccessory: invalid && index === 0 ? <Button size="xs" variant="ghost" className={TOUCH_ACTION} disabled={disabled} aria-label={`Reset ${label}`} onClick={() => change(structuredClone(resetValue))}>Reset</Button> : undefined,
  } as PropertyRow));
  return <div data-data-field={path}>
    <PropertyGrid rows={rows} />
    {assetPicker ? <AssetPicker open onOpenChange={(open) => { if (!open) setAssetPicker(null); }} assets={catalog.pickerAssets} allowedTypes={assetPicker.allowedTypes} title="Choose Asset" allowNone onPick={(guid) => {
      const row = generated.find((entry) => entry.id === assetPicker?.rowId);
      if (row?.kind === "asset") row.onChange(guid ?? "");
      setAssetPicker(null);
    }} /> : null}
    {classPicker ? <ClassPicker open onOpenChange={(open) => { if (!open) setClassPicker(null); }} classes={subclassClassEntries(classPicker.base, catalog.assets)} title="Choose Class" allowNone onPick={(classId) => {
      const row = generated.find((entry) => entry.id === classPicker?.rowId);
      if (row?.kind === "asset") row.onChange(classId ?? "");
      setClassPicker(null);
    }} /> : null}
  </div>;
}
