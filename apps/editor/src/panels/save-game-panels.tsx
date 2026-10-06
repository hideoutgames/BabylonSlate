import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { PlusIcon } from "lucide-react";
import {
  generateSaveGameTypes,
  validateSaveGameDefinition,
  type SaveGameDefinition,
  type SaveGameField,
  type SaveGameValue,
} from "@babylonslate/core";
import {
  AssetPicker, DisclosureSection, EntryListEditor, NamePromptDialog, PanelFrame,
  PinShapeGlyph, PinTypePicker, PropertyGrid, SearchInput, TreeView,
  isCoarsePointerEnvironment, pinPickerColorVar, type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@babylonslate/ui/components/field";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSaveGameEditing } from "../context/save-game-editing-context";
import { shouldApplyAssetDocumentChange } from "../lib/asset-document-change";

const FIELD_TYPES = ["bool", "int", "float", "string", "vec3", "actor", "asset"] as const;
const FIELD_TYPE_LABELS: Record<SaveGameField["type"], string> = {
  bool: "Boolean", int: "Integer", float: "Float", string: "String",
  vector3: "Vector 3", actor: "Actor Reference", asset: "Asset Reference",
};
const FIELD_PICKER_LABELS = { ...FIELD_TYPE_LABELS, vec3: FIELD_TYPE_LABELS.vector3 };

function fieldPickerType(type: SaveGameField["type"]) {
  return type === "vector3" ? "vec3" : type;
}

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
  const { selectedId, select } = useSaveGameEditing();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const [error, setError] = useState<string | null>(null);
  let definition: SaveGameDefinition | null = null;
  let invalid: string | null = null;
  try { definition = validateSaveGameDefinition(doc?.content); }
  catch (cause) { invalid = cause instanceof Error ? cause.message : String(cause); }
  const commit = async (next: SaveGameDefinition) => {
    try {
      validateSaveGameDefinition(next);
      if (definition && !shouldApplyAssetDocumentChange({ ...definition }, { ...next })) {
        setError(null);
        return true;
      }
      const applied = await applyAssetDocumentChange(documentId, { ...next });
      if (!applied) throw new Error("The Save Game could not be updated. Try again.");
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const selectedField = definition?.fields.find((field) => field.id === selectedId) ?? definition?.fields[0];
  return { definition, selectedField, select, error: error ?? invalid, commit };
}

function fieldNameError(definition: SaveGameDefinition, name: string, id?: string): string | null {
  if (!name.trim()) return "Enter a field name.";
  if (name.length > 128) return "Use 128 characters or fewer.";
  if (["__proto__", "constructor", "prototype"].includes(name)) return "Choose a different field name; this name is reserved.";
  if (definition.fields.some((field) => field.id !== id && field.name === name)) return "A field with this name already exists.";
  return null;
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
      const asset = typeof value === "string" ? assetRegistry?.getByGuid(value) : undefined;
      return <>
        <PropertyGrid rows={[{ ...base, kind: "asset", value: typeof value === "string" ? value : null, displayLabel: asset?.header.name ?? (value ? "Missing Asset" : undefined), displayType: asset?.header.type, onChange, onPick: () => setPickerOpen(true) }]} />
        <AssetPicker open={pickerOpen} onOpenChange={setPickerOpen} title="Pick Default Asset" allowNone assets={(assetRegistry?.list() ?? []).map((entry) => ({ guid: entry.header.guid, name: entry.header.name, type: entry.header.type, path: entry.path }))} onPick={(guid) => { onChange(guid); setPickerOpen(false); }} />
      </>;
    }
    case "actor": row = { ...base, kind: "text", value: "None", readOnly: true, description: "Assign an actor reference from gameplay. Saved references reconnect to the actor when loaded.", onChange: () => undefined }; break;
    default: row = { ...base, kind: "text", value: String(value), onChange };
  }
  return <PropertyGrid rows={[row]} />;
}

export function SaveGameFieldsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { definition, selectedField, select, error, commit } = useSaveGameDocument();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const needle = query.trim().toLocaleLowerCase();
  const fields = definition?.fields.filter((field) => `${field.name} ${FIELD_TYPE_LABELS[field.type]} ${field.array ? "Array" : "Single"}`.toLocaleLowerCase().includes(needle)) ?? [];
  return <PanelFrame data-testid="save-game-fields-panel">
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!definition} onClick={() => setAdding(true)}><PlusIcon data-icon="inline-start" />Add Field</Button>
        <span className="text-xs text-muted-foreground">{definition?.fields.length ?? 0} Fields</span>
      </div>
      <SearchInput value={query} onChange={setQuery} placeholder="Search Fields" aria-label="Search Fields" data-testid="save-game-fields-search" />
      {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {definition?.fields.length === 0 ? <Empty><EmptyHeader><EmptyTitle>No Save Fields</EmptyTitle><EmptyDescription>Add progress such as Score, Level, or Unlocked Items, then edit its type and starting value in Details.</EmptyDescription></EmptyHeader></Empty> : <TreeView
        nodes={fields.map((field) => ({
          id: field.id, label: field.name, depth: 0, hasChildren: false, expanded: false,
          icon: <PinShapeGlyph shape={field.array ? "list" : "circle"} connected color={pinPickerColorVar(fieldPickerType(field.type))} size={14} />,
          preview: <span className="text-xs text-muted-foreground">{FIELD_TYPE_LABELS[field.type]}{field.array ? " Array" : ""}</span>,
        }))}
        selectedId={selectedField?.id}
        rowHeight={isCoarsePointerEnvironment() ? 44 : 28}
        onSelect={select}
        emptyLabel="No Matching Fields"
        aria-label="Save Fields"
        data-testid="save-game-fields-tree"
      />}
    </div>
    <NamePromptDialog open={adding} onOpenChange={setAdding} title="Add Field" label="Field Name" validate={(name) => definition ? fieldNameError(definition, name) : "The Save Game is unavailable."} onSubmit={(name) => {
      if (!definition) return;
      const field: SaveGameField = { id: crypto.randomUUID(), name, type: "int", defaultValue: 0 };
      void commit({ ...definition, fields: [...definition.fields, field] }).then((applied) => {
        if (applied) { setQuery(""); select(field.id); }
      });
    }} />
  </PanelFrame>;
}

export function SaveGameDefinitionPanel(_props: IDockviewPanelProps) {
  void _props;
  const { definition, selectedField, select, error, commit } = useSaveGameDocument();
  const { projectDocument, updateProjectSettings, assetRegistry, openDocuments } = useDocuments();
  const { documentId } = useDocumentWorkspace();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const path = openDocuments.find((entry) => entry.id === documentId)?.ref.path;
  const guid = path ? assetRegistry?.getByPath(path)?.header.guid : undefined;
  const settings = projectDocument?.settings.saveGame;
  const isDefault = !!guid && settings?.definitionGuid === guid;
  const patch = (changes: Partial<SaveGameField>) => {
    if (definition && selectedField) void commit({ ...definition, fields: definition.fields.map((field) => field.id === selectedField.id ? { ...field, ...changes } : field) });
  };
  return <PanelFrame data-testid="save-game-definition-panel"><FieldGroup className="gap-4 p-3">
    {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {definition ? <>
      {selectedField ? <FieldSet key={selectedField.id} className="gap-3" data-testid={`save-field-${selectedField.id}`}>
        <FieldLegend>{selectedField.name}</FieldLegend>
        <PropertyGrid rows={[{ id: `name-${selectedField.id}`, kind: "text", label: "Name", value: selectedField.name, onChange: (name) => patch({ name }) }]} />
        <Field><FieldLabel>Type</FieldLabel><PinTypePicker types={FIELD_TYPES} labels={FIELD_PICKER_LABELS} value={fieldPickerType(selectedField.type)} onChange={(value) => {
          const type = (value === "vec3" ? "vector3" : value) as SaveGameField["type"];
          if (type !== selectedField.type) patch({ type, defaultValue: selectedField.array ? [] : initialValue(type) });
        }} data-testid="save-game-field-type" /></Field>
        <Field><FieldLabel>Container</FieldLabel><ToggleGroup variant="outline" size="sm" spacing={1} value={[selectedField.array ? "array" : "single"]} aria-label="Container" onValueChange={(values) => {
          const value = values[0];
          if (value !== "single" && value !== "array") return;
          const array = value === "array";
          if (array !== !!selectedField.array) patch({ array, defaultValue: array ? [] : initialValue(selectedField.type) });
        }}><ToggleGroupItem value="single">Single</ToggleGroupItem><ToggleGroupItem value="array"><PinShapeGlyph shape="list" connected data-icon="inline-start" />Array</ToggleGroupItem></ToggleGroup></Field>
        {selectedField.array ? <FieldSet className="gap-2"><FieldLegend variant="label">Default Value</FieldLegend><EntryListEditor
          items={selectedField.defaultValue as SaveGameValue[]}
          onChange={(defaultValue) => patch({ defaultValue })}
          onCreate={() => initialValue(selectedField.type)}
          addLabel="Add Item"
          touchAdaptive
          data-testid="save-game-field-defaults"
          renderItem={({ item, index, onChange }) => <DefaultValueEditor field={selectedField} label={`Item ${index + 1}`} value={item} onChange={onChange} />}
        /></FieldSet> : <DefaultValueEditor field={selectedField} value={selectedField.defaultValue} onChange={(defaultValue) => patch({ defaultValue })} />}
        <FieldDescription>Used for new games and when an existing save is missing this field. Renaming keeps its saved value.</FieldDescription>
        <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" aria-label={`Remove ${selectedField.name}`} onClick={() => {
          const fields = definition.fields.filter((field) => field.id !== selectedField.id);
          void commit({ ...definition, fields }).then((applied) => { if (applied) select(fields[0]?.id ?? null); });
        }}>Remove Field</Button></div>
      </FieldSet> : <Empty><EmptyHeader><EmptyTitle>Select A Field</EmptyTitle><EmptyDescription>Add a field in the Fields window to configure the data your game remembers.</EmptyDescription></EmptyHeader></Empty>}
      <FieldSet className="gap-2">
        <FieldLegend>Save Setup</FieldLegend>
        <FieldDescription>{isDefault ? "This is the project's active Save Game. Get Save and Set Save field nodes use these fields." : "Choose this as the project default to make its fields available in NodeGraphs."}</FieldDescription>
        <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!guid || !projectDocument || isDefault} onClick={() => { if (guid && settings) updateProjectSettings({ saveGame: { ...settings, definitionGuid: guid } }); }}>{isDefault ? "Project Default" : "Use As Project Default"}</Button></div>
        {isDefault && settings ? <PropertyGrid rows={[
          { id: `${documentId}-save-default-slot`, kind: "text", label: "Default Slot", value: settings.defaultSlot, description: "Save Game and Load Game use this slot when none is specified.", onChange: (defaultSlot) => updateProjectSettings({ saveGame: { ...settings, defaultSlot } }) },
          { id: `${documentId}-save-default-profile`, kind: "text", label: "Default Profile", value: settings.defaultProfile, description: "Keeps each player's saves together.", onChange: (defaultProfile) => updateProjectSettings({ saveGame: { ...settings, defaultProfile } }) },
        ]} /> : null}
        <FieldDescription>Use Set Save field nodes to update progress, Save Game at checkpoints, and Load Game before reading progress. Manage local Play saves in Project Settings → Save Games.</FieldDescription>
      </FieldSet>
      <DisclosureSection title="Advanced" open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <FieldGroup className="gap-3">
          <PropertyGrid rows={[{ id: `${documentId}-save-schema-version`, label: "Schema Version", kind: "number", min: 1, precision: 0, value: definition.schemaVersion, description: "Increase for incompatible changes, then register a gameplay migration before Load Game.", onChange: (schemaVersion) => void commit({ ...definition, schemaVersion: Math.max(1, Math.round(schemaVersion)) }) }]} />
          <FieldSet className="gap-2"><FieldLegend variant="label">Generated Type</FieldLegend><pre className="select-text overflow-auto rounded-md border border-border p-2 text-xs" tabIndex={0}>{generateSaveGameTypes(definition)}</pre></FieldSet>
        </FieldGroup>
      </DisclosureSection>
    </> : null}
  </FieldGroup></PanelFrame>;
}
