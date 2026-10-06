import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  generateSaveGameTypes,
  validateSaveGameDefinition,
  type SaveGameDefinition,
  type SaveGameField,
  type SaveGameValue,
} from "@babylonslate/core";
import { AssetPicker, PanelFrame, PropertyGrid, type PropertyRow } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { FieldGroup, FieldSet, FieldLegend } from "@babylonslate/ui/components/field";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

const FIELD_TYPES: Array<{ value: SaveGameField["type"]; label: string }> = [
  { value: "bool", label: "Boolean" }, { value: "int", label: "Integer" },
  { value: "float", label: "Number" }, { value: "string", label: "Text" },
  { value: "vector3", label: "Vector 3" }, { value: "actor", label: "Actor Reference" },
  { value: "asset", label: "Asset Reference" },
];

function initialValue(type: SaveGameField["type"]): SaveGameValue {
  if (type === "bool") return false;
  if (type === "int" || type === "float") return 0;
  if (type === "string") return "";
  if (type === "vector3") return { x: 0, y: 0, z: 0 };
  return null;
}

function useSaveGameDocument() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const [error, setError] = useState<string | null>(null);
  let definition: SaveGameDefinition | null = null;
  let invalid: string | null = null;
  try { definition = validateSaveGameDefinition(doc?.content); }
  catch (cause) { invalid = cause instanceof Error ? cause.message : String(cause); }
  const commit = async (next: SaveGameDefinition) => {
    try {
      validateSaveGameDefinition(next);
      await applyAssetDocumentChange(documentId, { ...next });
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return { definition, error: error ?? invalid, commit };
}

function DefaultValueEditor({ field, value, onChange, label = "Default Value" }: {
  field: SaveGameField; value: SaveGameValue; onChange(value: SaveGameValue): void; label?: string;
}) {
  const { assetRegistry } = useDocuments();
  const [pickerOpen, setPickerOpen] = useState(false);
  const base = { id: `default-${field.id}-${label}`, label };
  let row: PropertyRow;
  switch (field.type) {
    case "bool": row = { ...base, kind: "boolean", value: value === true, onChange }; break;
    case "int":
    case "float": row = { ...base, kind: "number", value: Number(value), precision: field.type === "int" ? 0 : undefined, onChange: (next) => onChange(field.type === "int" ? Math.round(next) : next) }; break;
    case "vector3": {
      const vector = value as { x: number; y: number; z: number };
      row = { ...base, kind: "vector3", value: [vector.x, vector.y, vector.z], onChange: ([x, y, z]) => onChange({ x, y, z }) }; break;
    }
    case "asset": {
      const asset = assetRegistry?.getByGuid(String(value));
      return <>
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" aria-label={`${label} For ${field.name}`} onClick={() => setPickerOpen(true)}>{label}: {asset?.header.name ?? "None"}</Button>
        <AssetPicker open={pickerOpen} onOpenChange={setPickerOpen} title="Pick Default Asset" allowNone assets={(assetRegistry?.list() ?? []).map((entry) => ({ guid: entry.header.guid, name: entry.header.name, type: entry.header.type, path: entry.path }))} onPick={(guid) => { onChange(guid); setPickerOpen(false); }} />
      </>;
    }
    case "actor": row = { ...base, kind: "text", value: "None", readOnly: true, description: "Assign an actor reference from gameplay. Saved references resolve by stable actor ID.", onChange: () => undefined }; break;
    default: row = { ...base, kind: "text", value: String(value), onChange };
  }
  return <PropertyGrid rows={[row]} />;
}

export function SaveGameFieldsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { definition, error, commit } = useSaveGameDocument();
  const patch = (id: string, changes: Partial<SaveGameField>) => {
    if (definition) void commit({ ...definition, fields: definition.fields.map((field) => field.id === id ? { ...field, ...changes } : field) });
  };
  return <PanelFrame data-testid="save-game-fields-panel" toolbar={<Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!definition} onClick={() => {
    if (!definition) return;
    let index = 1;
    while (definition.fields.some((field) => field.name === `Field${index}`)) index++;
    void commit({ ...definition, fields: [...definition.fields, { id: crypto.randomUUID(), name: `Field${index}`, type: "int", defaultValue: 0 }] });
  }}>Add Field</Button>}>
    <FieldGroup className="p-3">
      {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {definition?.fields.length === 0 ? <Empty><EmptyHeader><EmptyTitle>No Save Fields</EmptyTitle><EmptyDescription>Add progress such as Score, Level, or Unlocked Items. Choose this asset in Project Settings → Save Games.</EmptyDescription></EmptyHeader></Empty> : null}
      {definition?.fields.map((field) => <FieldSet key={field.id} className="rounded-md border border-border p-3" data-testid={`save-field-${field.id}`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><FieldLegend>{field.name}</FieldLegend><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" aria-label={`Remove ${field.name}`} onClick={() => void commit({ ...definition, fields: definition.fields.filter((entry) => entry.id !== field.id) })}>Remove Field</Button></div>
        <PropertyGrid rows={[
          { id: `name-${field.id}`, kind: "text", label: "Name", value: field.name, onChange: (name) => patch(field.id, { name }) },
          { id: `type-${field.id}`, kind: "enum", label: "Type", value: field.type, options: FIELD_TYPES, onChange: (value) => { const type = value as SaveGameField["type"]; patch(field.id, { type, defaultValue: field.array ? [] : initialValue(type) }); } },
          { id: `array-${field.id}`, kind: "boolean", label: "Array", value: !!field.array, onChange: (array) => patch(field.id, { array, defaultValue: array ? [] : initialValue(field.type) }) },
        ]} />
        {field.array ? <>
          {(field.defaultValue as SaveGameValue[]).map((value, index) => <div key={index} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1"><DefaultValueEditor field={field} label={`Default Item ${index + 1}`} value={value} onChange={(next) => patch(field.id, { defaultValue: (field.defaultValue as SaveGameValue[]).map((entry, position) => position === index ? next : entry) })} /></div>
            <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" aria-label={`Remove Default Item ${index + 1} From ${field.name}`} onClick={() => patch(field.id, { defaultValue: (field.defaultValue as SaveGameValue[]).filter((_, position) => position !== index) })}>Remove</Button>
          </div>)}
          <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => patch(field.id, { defaultValue: [...field.defaultValue as SaveGameValue[], initialValue(field.type)] })}>Add Default Item</Button></div>
        </> : <DefaultValueEditor field={field} value={field.defaultValue} onChange={(defaultValue) => patch(field.id, { defaultValue })} />}
        <PropertyGrid rows={[{ id: `id-${field.id}`, kind: "text", label: "Field ID", value: field.id, readOnly: true, description: "Retained when renamed so existing saves keep this value.", onChange: () => undefined }]} />
      </FieldSet>)}
    </FieldGroup>
  </PanelFrame>;
}

export function SaveGameDefinitionPanel(_props: IDockviewPanelProps) {
  void _props;
  const { definition, error, commit } = useSaveGameDocument();
  const { projectDocument, updateProjectSettings, assetRegistry } = useDocuments();
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const path = openDocuments.find((entry) => entry.id === documentId)?.ref.path;
  const guid = path ? assetRegistry?.getByPath(path)?.header.guid : undefined;
  const isDefault = !!guid && projectDocument?.settings.saveGame.definitionGuid === guid;
  return <PanelFrame data-testid="save-game-definition-panel"><div className="flex flex-col gap-3 p-3">
    {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {definition ? <>
      <PropertyGrid rows={[
        { id: "save-schema-version", label: "Schema Version", kind: "number", min: 1, precision: 0, value: definition.schemaVersion, onChange: (schemaVersion) => void commit({ ...definition, schemaVersion: Math.max(1, Math.round(schemaVersion)) }) },
        { id: "save-definition-id", label: "Definition ID", kind: "text", value: definition.id, readOnly: true, onChange: () => undefined },
      ]} />
      <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!guid || !projectDocument || isDefault} onClick={() => { if (guid && projectDocument) updateProjectSettings({ saveGame: { ...projectDocument.settings.saveGame, definitionGuid: guid } }); }}>{isDefault ? "Project Default" : "Use As Project Default"}</Button></div>
      <p className="text-xs text-muted-foreground">New fields use their defaults. Renames retain saved values. Increase the schema version for changes needing a migration; register migrations in gameplay before Load Game.</p>
      <FieldSet><FieldLegend>Generated Type</FieldLegend><pre className="select-text overflow-auto rounded-md border border-border p-2 text-xs" tabIndex={0}>{generateSaveGameTypes(definition)}</pre></FieldSet>
    </> : null}
  </div></PanelFrame>;
}
