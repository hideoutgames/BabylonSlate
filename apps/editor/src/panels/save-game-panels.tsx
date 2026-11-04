import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { PlusIcon } from "lucide-react";
import {
  cloneSaveGameValue,
  generateSaveGameTypes,
  quatToRotator,
  rotatorToQuat,
  validateSaveGameDefinition,
  type SaveGameDefinition,
  type SaveGameField,
  type SaveGameValue,
} from "@haptic/core";
import { nextCopyName } from "@haptic/assets";
import {
  AssetPicker, ClassPicker, DisclosureSection, EntryListEditor, LabelHint, PanelFrame,
  PinShapeGlyph, PinTypeMenu, PinTypePicker, PropertyGrid, SearchInput, TreeView, TypeColorMark,
  classRowIdentity, pinPickerColorVar, useTouchUi, type PropertyRow,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@haptic/ui/components/field";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import {
  useRegistryState,
  useDocumentActions,
  useProjectState,
  useOpenDocument,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSaveGameEditing } from "../context/save-game-editing-context";
import { ENGINE_TAG_CONTAINER_STRUCT_ID, defaultValueForMember, type TypeSchemas } from "@haptic/scripting";
import { variableDefaultPropertyRows } from "../lib/graph-inspector";
import { saveableStructures } from "../lib/save-game-catalog";
import { useDataCatalog } from "../lib/use-data-catalog";
import { shouldApplyAssetDocumentChange } from "../lib/asset-document-change";

/** Add Field and Type choices. TagContainer is a Structure field that holds `engine:TagContainer`. */
const FIELD_PICKER_TYPES = [
  "bool", "int", "float", "string", "tag", "tagContainer", "enum", "vec2", "vec3", "vec4", "color", "transform",
  "actor", "class", "asset", "struct",
] as const;
type FieldPickerType = (typeof FIELD_PICKER_TYPES)[number];
const FIELD_PICKER_LABELS: Record<FieldPickerType, string> = {
  bool: "Boolean", int: "Integer", float: "Float", string: "String", tag: "Tag", tagContainer: "TagContainer", enum: "Enum",
  vec2: "Vector 2", vec3: "Vector 3", vec4: "Vector 4", color: "Color", transform: "Transform",
  actor: "Actor Reference", class: "Class Reference", asset: "Asset Reference", struct: "Structure",
};
/** Save field types whose picker and pin type ids differ. */
const VECTOR_PIN_TYPES: Partial<Record<SaveGameField["type"], FieldPickerType>> = { vector2: "vec2", vector3: "vec3", vector4: "vec4" };
const VECTOR_FIELD_TYPES: Partial<Record<FieldPickerType, SaveGameField["type"]>> = { vec2: "vector2", vec3: "vector3", vec4: "vector4" };
const NEW_FIELD_NAME = "NewField";

type FieldType = Pick<SaveGameField, "type" | "structId" | "enumId">;
type TypeChoice = { guid: string; name: string };

function fieldPickerType(field: FieldType): FieldPickerType {
  if (field.type === "struct") return field.structId === ENGINE_TAG_CONTAINER_STRUCT_ID ? "tagContainer" : "struct";
  return VECTOR_PIN_TYPES[field.type] ?? field.type as FieldPickerType;
}

/** The pin type id of a field type; Structure fields, TagContainer included, are `struct`. */
function pinTypeId(type: SaveGameField["type"]): string {
  return VECTOR_PIN_TYPES[type] ?? type;
}

function fieldTypeLabel(field: SaveGameField): string {
  return `${FIELD_PICKER_LABELS[fieldPickerType(field)]}${field.array ? " Array" : ""}`;
}

/** One value of the field's type: references start as None, the rest as the type's own default. */
function singleDefault(field: FieldType, schemas: TypeSchemas): SaveGameValue {
  if (field.type === "actor" || field.type === "class" || field.type === "asset") return null;
  return cloneSaveGameValue(defaultValueForMember(pinTypeId(field.type), field.structId ?? field.enumId, schemas));
}

/** Types a field can take, with the Structures and Enums it can hold. */
function useFieldTypeCatalog() {
  const catalog = useDataCatalog();
  const structures: TypeChoice[] = saveableStructures(catalog.types.structures, catalog.schemas)
    .filter((entry) => entry.guid !== ENGINE_TAG_CONTAINER_STRUCT_ID);
  const enums: TypeChoice[] = [...catalog.types.enums].sort((a, b) => a.name.localeCompare(b.name));
  const types = FIELD_PICKER_TYPES.filter((type) => (type !== "struct" || structures.length > 0) && (type !== "enum" || enums.length > 0));
  /** A picker choice as field changes; a Structure or Enum field starts with the first one available. */
  const typeChanges = (picker: FieldPickerType, array: boolean): FieldType & { defaultValue: SaveGameValue } | null => {
    const structId = picker === "tagContainer" ? ENGINE_TAG_CONTAINER_STRUCT_ID : picker === "struct" ? structures[0]?.guid : undefined;
    const enumId = picker === "enum" ? enums[0]?.guid : undefined;
    if ((picker === "struct" && !structId) || (picker === "enum" && !enumId)) return null;
    const type: FieldType = {
      type: picker === "tagContainer" ? "struct" : VECTOR_FIELD_TYPES[picker] ?? picker as SaveGameField["type"],
      ...(structId ? { structId } : {}), ...(enumId ? { enumId } : {}),
    };
    return { ...type, defaultValue: array ? [] : singleDefault(type, catalog.schemas) };
  };
  return { catalog, structures, enums, types, typeChanges };
}

function useSaveGameDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { selectedId, select } = useSaveGameEditing();
  const doc = useOpenDocument(documentId);
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

type TransformValue = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
};

function DefaultValueEditor({ field, value, onChange, label = "Default Value" }: {
  field: SaveGameField; value: SaveGameValue; onChange(value: SaveGameValue): void; label?: string;
}) {
  const { assetRegistry } = useRegistryState();
  const [pickerOpen, setPickerOpen] = useState(false);
  const catalog = useDataCatalog();
  const id = `default-${field.id}-${label}`;
  // The field's own Default Value row explains when it applies; array items do not.
  const description = label === "Default Value" ? "Also used when an existing save is missing this field." : undefined;
  const base = { id, label, ...(description ? { description } : {}) };
  let row: PropertyRow;
  switch (field.type) {
    case "bool": row = { ...base, kind: "boolean", value: value === true, onChange }; break;
    case "int":
    case "float": row = { ...base, kind: "number", value: Number(value), precision: field.type === "int" ? 0 : undefined, onChange: (next) => onChange(field.type === "int" ? Math.round(next) : next) }; break;
    case "string": row = { ...base, kind: "text", value: String(value), onChange }; break;
    case "vector3": {
      const vector = value as { x: number; y: number; z: number };
      row = { ...base, kind: "vector3", value: [vector.x, vector.y, vector.z], onChange: ([x, y, z]) => onChange({ x, y, z }) }; break;
    }
    case "transform": {
      const transform = value as TransformValue;
      const rotator = quatToRotator(transform.rotation);
      const change = (part: Partial<TransformValue>) => onChange({ ...transform, ...part });
      return <FieldSet className="gap-1">
        <FieldLegend variant="label">{label}</FieldLegend>
        <PropertyGrid rows={[
          { id: `${id}-location`, kind: "vector3", label: "Location", value: [transform.position.x, transform.position.y, transform.position.z], onChange: ([x, y, z]) => change({ position: { x, y, z } }) },
          { id: `${id}-rotation`, kind: "vector3", label: "Rotation", unit: "deg", axes: ["Pitch", "Yaw", "Roll"], value: [rotator.pitch, rotator.yaw, rotator.roll], onChange: ([pitch, yaw, roll]) => change({ rotation: rotatorToQuat({ pitch, yaw, roll }) }) },
          { id: `${id}-scale`, kind: "vector3", label: "Scale", value: [transform.scale.x, transform.scale.y, transform.scale.z], onChange: ([x, y, z]) => change({ scale: { x, y, z } }) },
        ]} />
      </FieldSet>;
    }
    case "asset": {
      const asset = typeof value === "string" ? assetRegistry?.getByGuid(value) : undefined;
      return <>
        <PropertyGrid rows={[{ ...base, kind: "asset", value: typeof value === "string" ? value : null, displayLabel: asset?.header.name ?? (value ? "Missing Asset" : undefined), displayType: asset?.header.type, onChange, onPick: () => setPickerOpen(true) }]} />
        <AssetPicker open={pickerOpen} onOpenChange={setPickerOpen} title="Pick Default Asset" allowNone assets={catalog.pickerAssets} onPick={(guid) => { onChange(guid); setPickerOpen(false); }} />
      </>;
    }
    case "class": {
      const current = typeof value === "string" ? value : null;
      const identity = classRowIdentity(current ? { id: current, name: catalog.classEntries.find((entry) => entry.id === current)?.name ?? current } : undefined);
      return <>
        <PropertyGrid rows={[{ ...base, kind: "asset", value: current, ...identity, onChange: (next) => onChange(next || null), onPick: () => setPickerOpen(true) }]} />
        <ClassPicker open={pickerOpen} onOpenChange={setPickerOpen} title="Pick Default Class" allowNone classes={catalog.classEntries} onPick={(classId) => { onChange(classId); setPickerOpen(false); }} />
      </>;
    }
    case "actor": row = { ...base, kind: "text", value: "None", readOnly: true, description: "Assign an actor reference from gameplay. Saved references reconnect to the actor when loaded.", onChange: () => undefined }; break;
    default: {
      // Tag, Enum, Vector 2 and 4, Color and Structures share the Class Variable default controls.
      const structure = fieldPickerType(field) === "struct";
      const rows = variableDefaultPropertyRows(pinTypeId(field.type), value, (next) => onChange(cloneSaveGameValue(next)), {
        typeClassId: field.structId ?? field.enumId, schemas: catalog.schemas, enumMembers: catalog.enumMembers, pinId: id,
        // A Structure's rows are its fields, named after the item they belong to.
        label: structure && label === "Default Value" ? "Default" : label,
      });
      return <PropertyGrid rows={structure || !description ? rows : rows.map((entry) => ({ ...entry, description }))} />;
    }
  }
  return <PropertyGrid rows={[row]} />;
}

/** Structure or Enum a field holds, with its picker. */
function TypeReferenceRow({ fieldId, kind, value, choices, description, onPick }: {
  fieldId: string; kind: "Structure" | "Enum"; value: string | undefined; choices: readonly TypeChoice[];
  description?: string; onPick(guid: string): void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <PropertyGrid rows={[{
      id: `${kind.toLowerCase()}-${fieldId}`, kind: "asset", label: kind, value: value ?? null,
      displayLabel: choices.find((entry) => entry.guid === value)?.name ?? `Missing ${kind}`,
      displayType: kind, placeholder: `Choose ${kind}`, ...(description ? { description } : {}),
      onPick: () => setOpen(true), onChange: () => undefined,
    }]} />
    <AssetPicker open={open} onOpenChange={setOpen} title={`Pick ${kind}`} allowNone={false}
      assets={choices.map((entry) => ({ guid: entry.guid, name: entry.name, type: kind }))} allowedTypes={[kind]}
      onPick={(guid) => {
        setOpen(false);
        if (guid && guid !== value) onPick(guid);
      }} />
  </>;
}

export function SaveGameFieldsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { definition, selectedField, select, error, commit } = useSaveGameDocument();
  const { types, typeChanges } = useFieldTypeCatalog();
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const touchRows = useTouchUi();
  const needle = query.trim().toLocaleLowerCase();
  const fields = definition?.fields.filter((field) => `${field.name} ${fieldTypeLabel(field)}`.toLocaleLowerCase().includes(needle)) ?? [];
  // Like a new Class Variable: a generated name of the picked type, renamed inline.
  const addField = (picker: FieldPickerType) => {
    const changes = typeChanges(picker, false);
    if (!definition || !changes) return;
    const field: SaveGameField = { id: crypto.randomUUID(), name: nextCopyName(NEW_FIELD_NAME, definition.fields.map((entry) => entry.name)), ...changes };
    void commit({ ...definition, fields: [...definition.fields, field] }).then((applied) => {
      if (!applied) return;
      setQuery("");
      setRenameError(null);
      select(field.id);
      setRenamingId(field.id);
    });
  };
  const finishRename = (id: string, name: string | null) => {
    setRenamingId(null);
    if (!definition || name === null) return;
    const message = fieldNameError(definition, name, id);
    setRenameError(message);
    if (!message) void commit({ ...definition, fields: definition.fields.map((field) => field.id === id ? { ...field, name } : field) });
  };
  return <PanelFrame data-testid="save-game-fields-panel">
    <div className="flex flex-col gap-2 p-2">
      <div>
        <PinTypeMenu title="Field Type" types={types} labels={FIELD_PICKER_LABELS} onSelect={(type) => addField(type as FieldPickerType)} data-testid="save-game-add-field-menu">
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!definition} data-testid="save-game-add-field"><PlusIcon data-icon="inline-start" />Add Field</Button>
        </PinTypeMenu>
      </div>
      <SearchInput value={query} onChange={setQuery} placeholder="Search Fields" aria-label="Search Fields" data-testid="save-game-fields-search" />
      {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {renameError ? <Alert variant="destructive"><AlertTitle>Field Not Renamed</AlertTitle><AlertDescription>{renameError}</AlertDescription></Alert> : null}
      {definition?.fields.length === 0 ? <Empty><EmptyHeader><EmptyTitle>No Save Fields</EmptyTitle></EmptyHeader></Empty> : <TreeView
        nodes={fields.map((field) => ({
          id: field.id, label: field.name, depth: 0, hasChildren: false, expanded: false, renamable: true,
          icon: field.array ? <PinShapeGlyph shape="list" connected outlined={false} color={pinPickerColorVar(fieldPickerType(field))} size={12} /> : <TypeColorMark colorVar={pinPickerColorVar(fieldPickerType(field))} />,
          preview: <span className="text-xs text-muted-foreground">{fieldTypeLabel(field)}</span>,
        }))}
        selectedId={selectedField?.id}
        rowHeight={touchRows ? 44 : 28}
        onSelect={select}
        renamingId={renamingId}
        onRenameRequest={(id) => { setRenameError(null); setRenamingId(id); }}
        onRenameDone={finishRename}
        emptyLabel="No Matching Fields"
        aria-label="Save Fields"
        data-testid="save-game-fields-tree"
      />}
    </div>
  </PanelFrame>;
}

export function SaveGameDefinitionPanel(_props: IDockviewPanelProps) {
  void _props;
  const { definition, selectedField, select, error, commit } = useSaveGameDocument();
  const { updateProjectSettings } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry } = useRegistryState();
  const { documentId } = useDocumentWorkspace();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { catalog, structures, enums, types, typeChanges } = useFieldTypeCatalog();
  const [nameError, setNameError] = useState<{ fieldId: string; message: string } | null>(null);
  const path = useOpenDocument(documentId)?.ref.path;
  const guid = path ? assetRegistry?.getByPath(path)?.header.guid : undefined;
  const settings = projectDocument?.settings.saveGame;
  const isDefault = !!guid && settings?.definitionGuid === guid;
  const patch = (changes: Partial<SaveGameField>) => {
    if (definition && selectedField) void commit({ ...definition, fields: definition.fields.map((field) => field.id === selectedField.id ? { ...field, ...changes } : field) });
  };
  const selectedDefault = () => selectedField ? singleDefault(selectedField, catalog.schemas) : null;
  return <PanelFrame data-testid="save-game-definition-panel"><FieldGroup className="gap-4 p-3">
    {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {definition ? <>
      {selectedField ? <FieldSet key={selectedField.id} className="gap-3" data-testid={`save-field-${selectedField.id}`}>
        <FieldLegend>{selectedField.name}</FieldLegend>
        <PropertyGrid rows={[{
          id: `name-${selectedField.id}`, kind: "text", label: "Name", value: selectedField.name,
          description: "Renaming keeps its saved value.",
          error: nameError?.fieldId === selectedField.id ? nameError.message : undefined,
          // Checked like an inline rename; a rejected name stays in the draft and the field keeps its last name.
          onChange: (name) => {
            const message = fieldNameError(definition, name, selectedField.id);
            setNameError(message ? { fieldId: selectedField.id, message } : null);
            if (!message) patch({ name });
          },
          onCommit: () => setNameError(null),
        }]} />
        <Field><FieldLabel>Type</FieldLabel><PinTypePicker types={types} labels={FIELD_PICKER_LABELS} value={fieldPickerType(selectedField)} onChange={(value) => {
          if (value === fieldPickerType(selectedField)) return;
          const changes = typeChanges(value as FieldPickerType, !!selectedField.array);
          if (changes) patch({ structId: undefined, enumId: undefined, ...changes });
        }} data-testid="save-game-field-type" /></Field>
        {fieldPickerType(selectedField) === "struct" ? <TypeReferenceRow fieldId={selectedField.id} kind="Structure" value={selectedField.structId} choices={structures}
          description="Only Structures without object references can be saved."
          onPick={(structId) => patch({ structId, defaultValue: selectedField.array ? [] : singleDefault({ type: "struct", structId }, catalog.schemas) })} /> : null}
        {selectedField.type === "enum" ? <TypeReferenceRow fieldId={selectedField.id} kind="Enum" value={selectedField.enumId} choices={enums}
          onPick={(enumId) => patch({ enumId, defaultValue: selectedField.array ? [] : singleDefault({ type: "enum", enumId }, catalog.schemas) })} /> : null}
        <Field><FieldLabel>Container</FieldLabel><ToggleGroup variant="outline" size="sm" spacing={1} value={[selectedField.array ? "array" : "single"]} aria-label="Container" onValueChange={(values) => {
          const value = values[0];
          if (value !== "single" && value !== "array") return;
          const array = value === "array";
          if (array !== !!selectedField.array) patch({ array, defaultValue: array ? [] : selectedDefault() });
        }}><ToggleGroupItem value="single"><PinShapeGlyph shape="circle" connected outlined={false} color="currentColor" size={8} data-icon="inline-start" />Single</ToggleGroupItem><ToggleGroupItem value="array"><PinShapeGlyph shape="list" connected data-icon="inline-start" />Array</ToggleGroupItem></ToggleGroup></Field>
        {selectedField.array ? <FieldSet className="gap-2"><FieldLegend variant="label">Default Value</FieldLegend><EntryListEditor
          items={selectedField.defaultValue as SaveGameValue[]}
          onChange={(defaultValue) => patch({ defaultValue })}
          onCreate={selectedDefault}
          addLabel="Add Item"
          touchAdaptive
          data-testid="save-game-field-defaults"
          renderItem={({ item, index, onChange }) => <DefaultValueEditor field={selectedField} label={`Item ${index + 1}`} value={item} onChange={onChange} />}
        /></FieldSet> : <DefaultValueEditor field={selectedField} value={selectedField.defaultValue} onChange={(defaultValue) => patch({ defaultValue })} />}
        <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" aria-label={`Remove ${selectedField.name}`} onClick={() => {
          const fields = definition.fields.filter((field) => field.id !== selectedField.id);
          void commit({ ...definition, fields }).then((applied) => { if (applied) select(fields[0]?.id ?? null); });
        }}>Remove Field</Button></div>
      </FieldSet> : <Empty><EmptyHeader><EmptyTitle>No Field Selected</EmptyTitle></EmptyHeader></Empty>}
      <FieldSet className="gap-2">
        <LabelHint hint="The project default Save Game adds its fields to NodeGraphs."><FieldLegend>Save Setup</FieldLegend></LabelHint>
        <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!guid || !projectDocument || isDefault} onClick={() => { if (guid && settings) updateProjectSettings({ saveGame: { ...settings, definitionGuid: guid } }); }}>{isDefault ? "Project Default" : "Use As Project Default"}</Button></div>
        {isDefault && settings ? <PropertyGrid rows={[
          { id: `${documentId}-save-default-slot`, kind: "text", label: "Default Slot", value: settings.defaultSlot, description: "Save Game and Load Game use this slot when none is specified.", onChange: (defaultSlot) => updateProjectSettings({ saveGame: { ...settings, defaultSlot } }) },
          { id: `${documentId}-save-default-profile`, kind: "text", label: "Default Profile", value: settings.defaultProfile, description: "Keeps each player's saves together.", onChange: (defaultProfile) => updateProjectSettings({ saveGame: { ...settings, defaultProfile } }) },
        ]} /> : null}
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
