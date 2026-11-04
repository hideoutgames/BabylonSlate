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
  type SaveGameFieldType,
  type SaveGameMapKeyType,
  type SaveGameValue,
} from "@haptic/core";
import { nextCopyName } from "@haptic/assets";
import {
  AssetPicker, ClassPicker, DisclosureSection, EntryListEditor, LabelHint, PanelFrame,
  PinShapeGlyph, PinTypeMenu, PinTypePicker, PropertyGrid, SearchInput, TreeView, TypeColorMark,
  classRowIdentity, pinPickerColorVar, useAssetOpen, useTouchUi, type PropertyRow,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@haptic/ui/components/field";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import {
  useRegistryState,
  useDocumentActions,
  useProjectState,
  useOpenDocument,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSaveGameEditing } from "../context/save-game-editing-context";
import { ENGINE_TAG_CONTAINER_STRUCT_ID, type TypeSchemas } from "@haptic/scripting";
import { variableDefaultPropertyRows } from "../lib/graph-inspector";
import {
  resolveSaveGameDefinition, saveFieldDefault, saveFieldPinTypeId, saveTypeDefault, saveableStructures, type ResolvedSaveGame,
} from "../lib/save-game-catalog";
import { useDataCatalog } from "../lib/use-data-catalog";
import { shouldApplyAssetDocumentChange } from "../lib/asset-document-change";

/** Add Field and Type choices. TagContainer is a Structure field that holds `engine:TagContainer`. */
const FIELD_PICKER_TYPES = [
  "bool", "int", "float", "string", "tag", "tagContainer", "enum", "vec2", "vec3", "vec4", "rotator", "quat", "color", "transform",
  "actor", "class", "asset", "struct",
] as const;
type FieldPickerType = (typeof FIELD_PICKER_TYPES)[number];
/** Map key choices: values that identify an entry. Data Definitions may link others; Actor references never. */
const MAP_KEY_PICKER_TYPES = ["int", "float", "string", "tag", "enum", "class", "asset"] as const;
const FIELD_PICKER_LABELS: Record<FieldPickerType, string> = {
  bool: "Boolean", int: "Integer", float: "Float", string: "String", tag: "Tag", tagContainer: "TagContainer", enum: "Enum",
  vec2: "Vector 2", vec3: "Vector 3", vec4: "Vector 4", rotator: "Rotator", quat: "Quaternion", color: "Color", transform: "Transform",
  actor: "Actor Reference", class: "Class Reference", asset: "Asset Reference", struct: "Structure",
};
const FIELD_TYPES_BY_PICKER: Partial<Record<FieldPickerType, SaveGameFieldType>> = { vec2: "vector2", vec3: "vector3", vec4: "vector4", tagContainer: "struct" };
const NEW_FIELD_NAME = "NewField";

type FieldType = Pick<SaveGameField, "type" | "structId" | "enumId">;
type TypeChoice = { guid: string; name: string };

function fieldPickerType(field: FieldType): FieldPickerType {
  if (field.type === "struct" && field.structId === ENGINE_TAG_CONTAINER_STRUCT_ID) return "tagContainer";
  return saveFieldPinTypeId(field.type) as FieldPickerType;
}

function fieldTypeLabel(field: SaveGameField): string {
  const type = FIELD_PICKER_LABELS[fieldPickerType(field)];
  if (field.container === "map") return `${type} Map`;
  return `${type}${field.container === "array" ? " Array" : ""}`;
}

/** The field that edits a Map field's keys. */
function mapKeyField(field: SaveGameField): SaveGameField {
  return { id: `${field.id}-key`, name: field.name, type: field.keyType ?? "string", structId: field.keyStructId, enumId: field.keyEnumId, defaultValue: null };
}

/** A key no other entry uses where one can be made up, so Add Entry does not repeat a key. */
function nextMapKey(field: SaveGameField, entries: readonly { key: SaveGameValue }[], schemas: TypeSchemas, enumMembers: Readonly<Record<string, readonly string[]>>): SaveGameValue {
  const keys = entries.map((entry) => entry.key);
  switch (field.keyType) {
    case "string": return nextCopyName("Key", keys.filter((key): key is string => typeof key === "string"));
    case "int":
    case "float": return Math.max(-1, ...keys.filter((key): key is number => typeof key === "number")) + 1;
    case "enum": return enumMembers[field.keyEnumId ?? ""]?.find((name) => !keys.includes(name)) ?? saveTypeDefault("enum", field.keyEnumId, schemas);
    default: return saveTypeDefault(field.keyType ?? "string", field.keyStructId ?? field.keyEnumId, schemas);
  }
}

/** Types a field can take, with the Structures and Enums it can hold. */
function useFieldTypeCatalog() {
  const catalog = useDataCatalog();
  const structures: TypeChoice[] = saveableStructures(catalog.types.structures, catalog.schemas)
    .filter((entry) => entry.guid !== ENGINE_TAG_CONTAINER_STRUCT_ID);
  const enums: TypeChoice[] = [...catalog.types.enums].sort((a, b) => a.name.localeCompare(b.name));
  const available = (type: string) => (type !== "struct" || structures.length > 0) && (type !== "enum" || enums.length > 0);
  const types = FIELD_PICKER_TYPES.filter(available);
  const keyTypes = MAP_KEY_PICKER_TYPES.filter(available);
  const dataDefinitions: TypeChoice[] = [...catalog.types.dataDefinitions].sort((a, b) => a.name.localeCompare(b.name));
  /** A picker choice as field changes; a Structure or Enum field starts with the first one available. */
  const typeChanges = (picker: FieldPickerType, container: SaveGameField["container"]): FieldType & { defaultValue: SaveGameValue } | null => {
    const structId = picker === "tagContainer" ? ENGINE_TAG_CONTAINER_STRUCT_ID : picker === "struct" ? structures[0]?.guid : undefined;
    const enumId = picker === "enum" ? enums[0]?.guid : undefined;
    if ((picker === "struct" && !structId) || (picker === "enum" && !enumId)) return null;
    const type: FieldType = {
      type: FIELD_TYPES_BY_PICKER[picker] ?? picker as SaveGameFieldType,
      ...(structId ? { structId } : {}), ...(enumId ? { enumId } : {}),
    };
    return { ...type, defaultValue: container ? [] : saveTypeDefault(type.type, structId ?? enumId, catalog.schemas) };
  };
  return { catalog, structures, enums, types, keyTypes, dataDefinitions, typeChanges };
}

function useSaveGameDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { selectedId, select } = useSaveGameEditing();
  const doc = useOpenDocument(documentId);
  const { schemas } = useDataCatalog();
  const [error, setError] = useState<string | null>(null);
  // `stored` is the asset as saved; `definition` holds its fields, from its Data Definition when it is linked to one.
  let stored: SaveGameDefinition | null = null;
  let resolved: ResolvedSaveGame | null = null;
  let invalid: string | null = null;
  try {
    stored = validateSaveGameDefinition(doc?.content);
    resolved = resolveSaveGameDefinition(stored, schemas);
  } catch (cause) { invalid = cause instanceof Error ? cause.message : String(cause); }
  const definition = resolved?.definition ?? null;
  const commit = async (next: SaveGameDefinition) => {
    try {
      validateSaveGameDefinition(next);
      if (stored && !shouldApplyAssetDocumentChange({ ...stored }, { ...next })) {
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
  const linked = !!stored?.dataDefinitionId;
  return {
    stored, definition, selectedField, select, error: error ?? invalid, commit, linked,
    skipped: resolved?.skipped ?? [], missingDataDefinition: resolved?.missingDataDefinition ?? false,
  };
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
      // Tag, Enum, Vector 2 and 4, Rotator, Quaternion, Color and Structures share the Class Variable default controls.
      const structure = fieldPickerType(field) === "struct";
      const rows = variableDefaultPropertyRows(saveFieldPinTypeId(field.type), value, (next) => onChange(cloneSaveGameValue(next)), {
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
function TypeReferenceRow({ fieldId, kind, label = kind, value, choices, description, disabled, onPick }: {
  fieldId: string; kind: "Structure" | "Enum"; label?: string; value: string | undefined; choices: readonly TypeChoice[];
  description?: string; disabled?: boolean; onPick(guid: string): void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <PropertyGrid rows={[{
      id: `${label.toLowerCase().replace(/\s+/g, "-")}-${fieldId}`, kind: "asset", label, value: value ?? null, disabled,
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
  const { stored, definition, selectedField, select, error, commit, linked, skipped, missingDataDefinition } = useSaveGameDocument();
  const { types, typeChanges, dataDefinitions } = useFieldTypeCatalog();
  const openAsset = useAssetOpen();
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const touchRows = useTouchUi();
  const needle = query.trim().toLocaleLowerCase();
  const fields = definition?.fields.filter((field) => `${field.name} ${fieldTypeLabel(field)}`.toLocaleLowerCase().includes(needle)) ?? [];
  const source = linked ? dataDefinitions.find((entry) => entry.guid === stored?.dataDefinitionId) : undefined;
  // Like a new Class Variable: a generated name of the picked type, renamed inline.
  const addField = (picker: FieldPickerType) => {
    const changes = typeChanges(picker, undefined);
    if (!stored || !changes) return;
    const field: SaveGameField = { id: crypto.randomUUID(), name: nextCopyName(NEW_FIELD_NAME, stored.fields.map((entry) => entry.name)), ...changes };
    void commit({ ...stored, fields: [...stored.fields, field] }).then((applied) => {
      if (!applied) return;
      setQuery("");
      setRenameError(null);
      select(field.id);
      setRenamingId(field.id);
    });
  };
  const finishRename = (id: string, name: string | null) => {
    setRenamingId(null);
    if (!stored || name === null) return;
    const message = fieldNameError(stored, name, id);
    setRenameError(message);
    if (!message) void commit({ ...stored, fields: stored.fields.map((field) => field.id === id ? { ...field, name } : field) });
  };
  return <PanelFrame data-testid="save-game-fields-panel">
    <div className="flex flex-col gap-2 p-2">
      {/* A linked Save Game's fields are edited in their Data Definition. */}
      <div>{linked ? source ? <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!openAsset?.canOpen(source.guid)}
        onClick={() => openAsset?.openAsset(source.guid)} data-testid="save-game-open-data-definition">Open {source.name}</Button> : null
        : <PinTypeMenu title="Field Type" types={types} labels={FIELD_PICKER_LABELS} onSelect={(type) => addField(type as FieldPickerType)} data-testid="save-game-add-field-menu">
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={!definition} data-testid="save-game-add-field"><PlusIcon data-icon="inline-start" />Add Field</Button>
        </PinTypeMenu>}</div>
      <SearchInput value={query} onChange={setQuery} placeholder="Search Fields" aria-label="Search Fields" data-testid="save-game-fields-search" />
      {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {renameError ? <Alert variant="destructive"><AlertTitle>Field Not Renamed</AlertTitle><AlertDescription>{renameError}</AlertDescription></Alert> : null}
      {missingDataDefinition ? <Alert variant="destructive"><AlertTitle>Data Definition Missing</AlertTitle><AlertDescription>Choose another Data Definition, or None, under Advanced in the Inspector.</AlertDescription></Alert> : null}
      {skipped.length ? <Alert data-testid="save-game-skipped-fields"><AlertTitle>Fields Not Saved</AlertTitle><AlertDescription>
        <ul>{skipped.map((entry) => <li key={entry.name}><span className="font-medium">{entry.name}</span>: {entry.reason}</li>)}</ul>
      </AlertDescription></Alert> : null}
      {definition?.fields.length === 0 ? <Empty><EmptyHeader><EmptyTitle>No Save Fields</EmptyTitle></EmptyHeader></Empty> : <TreeView
        nodes={fields.map((field) => ({
          id: field.id, label: field.name, depth: 0, hasChildren: false, expanded: false, renamable: !linked,
          icon: field.container ? <PinShapeGlyph shape={field.container === "map" ? "map" : "list"} connected outlined={false} color={pinPickerColorVar(fieldPickerType(field))} size={12} /> : <TypeColorMark colorVar={pinPickerColorVar(fieldPickerType(field))} />,
          preview: <span className="text-xs text-muted-foreground">{fieldTypeLabel(field)}</span>,
        }))}
        selectedId={selectedField?.id}
        rowHeight={touchRows ? 44 : 28}
        onSelect={select}
        renamingId={renamingId}
        onRenameRequest={linked ? undefined : (id) => { setRenameError(null); setRenamingId(id); }}
        onRenameDone={finishRename}
        emptyLabel="No Matching Fields"
        aria-label="Save Fields"
        data-testid="save-game-fields-tree"
      />}
    </div>
  </PanelFrame>;
}

/** The field's default value: one value, an Array of items, or a Map of key and value entries. */
function FieldDefaultEditor({ field, onChange, onCreateKey }: {
  field: SaveGameField; onChange(value: SaveGameValue): void; onCreateKey(entries: readonly { key: SaveGameValue }[]): SaveGameValue;
}) {
  const catalog = useDataCatalog();
  const item = () => saveTypeDefault(field.type, field.structId ?? field.enumId, catalog.schemas);
  if (field.container === "array") return <FieldSet className="gap-2"><FieldLegend variant="label">Default Value</FieldLegend><EntryListEditor
    items={field.defaultValue as SaveGameValue[]}
    onChange={onChange}
    onCreate={item}
    addLabel="Add Item"
    touchAdaptive
    data-testid="save-game-field-defaults"
    renderItem={({ item: value, index, onChange: change }) => <DefaultValueEditor field={field} label={`Item ${index + 1}`} value={value} onChange={change} />}
  /></FieldSet>;
  if (field.container === "map") {
    const entries = field.defaultValue as Array<{ key: SaveGameValue; value: SaveGameValue }>;
    return <FieldSet className="gap-2"><FieldLegend variant="label">Default Value</FieldLegend><EntryListEditor
      items={entries}
      onChange={(next) => onChange(next)}
      onCreate={() => ({ key: onCreateKey(entries), value: item() })}
      addLabel="Add Entry"
      countNoun={{ one: "entry", other: "entries" }}
      touchAdaptive
      data-testid="save-game-field-defaults"
      renderItem={({ item: entry, index, onChange: change }) => <>
        <DefaultValueEditor field={mapKeyField(field)} label={`Key ${index + 1}`} value={entry.key} onChange={(key) => change({ ...entry, key })} />
        <DefaultValueEditor field={field} label={`Value ${index + 1}`} value={entry.value} onChange={(value) => change({ ...entry, value })} />
      </>}
    /></FieldSet>;
  }
  return <DefaultValueEditor field={field} value={field.defaultValue} onChange={onChange} />;
}

export function SaveGameDefinitionPanel(_props: IDockviewPanelProps) {
  void _props;
  const { stored, definition, selectedField, select, error, commit, linked } = useSaveGameDocument();
  const { updateProjectSettings } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry } = useRegistryState();
  const { documentId } = useDocumentWorkspace();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dataDefinitionPickerOpen, setDataDefinitionPickerOpen] = useState(false);
  const [pendingLink, setPendingLink] = useState<TypeChoice | null>(null);
  const { catalog, structures, enums, types, keyTypes, dataDefinitions, typeChanges } = useFieldTypeCatalog();
  const [nameError, setNameError] = useState<{ fieldId: string; message: string } | null>(null);
  const path = useOpenDocument(documentId)?.ref.path;
  const guid = path ? assetRegistry?.getByPath(path)?.header.guid : undefined;
  const settings = projectDocument?.settings.saveGame;
  const isDefault = !!guid && settings?.definitionGuid === guid;
  const patch = (changes: Partial<SaveGameField>) => {
    if (stored && selectedField) void commit({ ...stored, fields: stored.fields.map((field) => field.id === selectedField.id ? { ...field, ...changes } : field) });
  };
  const overrides = stored?.defaults ?? {};
  const overridden = !!selectedField && Object.hasOwn(overrides, selectedField.id);
  // A linked field keeps its Data Definition's default until one is set here.
  const setDefault = (defaultValue: SaveGameValue) => {
    if (!stored || !selectedField) return;
    if (linked) void commit({ ...stored, defaults: { ...overrides, [selectedField.id]: defaultValue } });
    else patch({ defaultValue });
  };
  const resetDefault = () => {
    if (!stored || !selectedField) return;
    const defaults = { ...overrides };
    delete defaults[selectedField.id];
    void commit({ ...stored, defaults });
  };
  const link = (target: string) => void commit({ ...stored!, fields: [], dataDefinitionId: target, defaults: undefined }).then((applied) => { if (applied) select(null); });
  // Turning the link off keeps the current fields, IDs and defaults as the Save Game's own, so saves still load.
  const unlink = () => void commit({ ...stored!, fields: definition!.fields, dataDefinitionId: undefined, defaults: undefined });
  const requestLink = (target: string | null) => {
    setDataDefinitionPickerOpen(false);
    if (!stored || target === (stored.dataDefinitionId ?? null)) return;
    if (!target) unlink();
    else if (!linked && stored.fields.length > 0) setPendingLink(dataDefinitions.find((entry) => entry.guid === target) ?? { guid: target, name: target });
    else link(target);
  };
  const keyPicker = selectedField?.keyType === "struct" && selectedField.keyStructId === ENGINE_TAG_CONTAINER_STRUCT_ID ? "tagContainer" : saveFieldPinTypeId(selectedField?.keyType ?? "string");
  return <PanelFrame data-testid="save-game-definition-panel"><FieldGroup className="gap-4 p-3">
    {error ? <Alert variant="destructive"><AlertTitle>Invalid Save Definition</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {stored && definition ? <>
      {selectedField ? <FieldSet key={selectedField.id} className="gap-3" data-testid={`save-field-${selectedField.id}`}>
        <FieldLegend>{selectedField.name}</FieldLegend>
        {linked ? null : <PropertyGrid rows={[{
          id: `name-${selectedField.id}`, kind: "text", label: "Name", value: selectedField.name,
          description: "Renaming keeps its saved value.",
          error: nameError?.fieldId === selectedField.id ? nameError.message : undefined,
          // Checked like an inline rename; a rejected name stays in the draft and the field keeps its last name.
          onChange: (name) => {
            const message = fieldNameError(stored, name, selectedField.id);
            setNameError(message ? { fieldId: selectedField.id, message } : null);
            if (!message) patch({ name });
          },
          onCommit: () => setNameError(null),
        }]} />}
        <Field><FieldLabel>Type</FieldLabel><PinTypePicker types={types} labels={FIELD_PICKER_LABELS} value={fieldPickerType(selectedField)} disabled={linked} onChange={(value) => {
          if (value === fieldPickerType(selectedField)) return;
          const changes = typeChanges(value as FieldPickerType, selectedField.container);
          if (changes) patch({ structId: undefined, enumId: undefined, ...changes });
        }} data-testid="save-game-field-type" /></Field>
        {fieldPickerType(selectedField) === "struct" ? <TypeReferenceRow fieldId={selectedField.id} kind="Structure" value={selectedField.structId} choices={structures} disabled={linked}
          description="Only Structures without object references can be saved."
          onPick={(structId) => patch({ structId, defaultValue: saveFieldDefault({ ...selectedField, structId }, catalog.schemas) })} /> : null}
        {selectedField.type === "enum" ? <TypeReferenceRow fieldId={selectedField.id} kind="Enum" value={selectedField.enumId} choices={enums} disabled={linked}
          onPick={(enumId) => patch({ enumId, defaultValue: saveFieldDefault({ ...selectedField, enumId }, catalog.schemas) })} /> : null}
        <Field><FieldLabel>Container</FieldLabel><ToggleGroup variant="outline" size="sm" spacing={1} value={[selectedField.container ?? "single"]} aria-label="Container" disabled={linked} onValueChange={(values) => {
          const value = values[0];
          if (value !== "single" && value !== "array" && value !== "map") return;
          if (value === (selectedField.container ?? "single")) return;
          const container = value === "single" ? undefined : value;
          patch({
            container, keyType: container === "map" ? "string" : undefined, keyStructId: undefined, keyEnumId: undefined,
            defaultValue: saveFieldDefault({ ...selectedField, container }, catalog.schemas),
          });
        }}>
          <ToggleGroupItem value="single"><PinShapeGlyph shape="circle" connected outlined={false} color="currentColor" size={8} data-icon="inline-start" />Single</ToggleGroupItem>
          <ToggleGroupItem value="array"><PinShapeGlyph shape="list" connected data-icon="inline-start" />Array</ToggleGroupItem>
          <ToggleGroupItem value="map"><PinShapeGlyph shape="map" connected data-icon="inline-start" />Map</ToggleGroupItem>
        </ToggleGroup></Field>
        {selectedField.container === "map" ? <>
          <Field><FieldLabel>Key Type</FieldLabel><PinTypePicker types={keyTypes} labels={FIELD_PICKER_LABELS} value={keyPicker} disabled={linked} onChange={(value) => {
            if (value === keyPicker) return;
            const changes = typeChanges(value as FieldPickerType, undefined);
            if (changes) patch({ keyType: changes.type as SaveGameMapKeyType, keyStructId: changes.structId, keyEnumId: changes.enumId, defaultValue: [] });
          }} data-testid="save-game-field-key-type" /></Field>
          {selectedField.keyType === "enum" ? <TypeReferenceRow fieldId={selectedField.id} kind="Enum" label="Key Enum" value={selectedField.keyEnumId} choices={enums} disabled={linked}
            onPick={(keyEnumId) => patch({ keyEnumId, defaultValue: [] })} /> : null}
        </> : null}
        <FieldDefaultEditor field={selectedField} onChange={setDefault}
          onCreateKey={(entries) => nextMapKey(selectedField, entries, catalog.schemas, catalog.enumMembers)} />
        {linked ? overridden ? <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={resetDefault} data-testid="save-game-reset-default">Use Data Definition Default</Button></div> : null
          : <div><Button size="sm" variant="outline" className="pointer-coarse:min-h-11" aria-label={`Remove ${selectedField.name}`} onClick={() => {
            const fields = stored.fields.filter((field) => field.id !== selectedField.id);
            void commit({ ...stored, fields }).then((applied) => { if (applied) select(fields[0]?.id ?? null); });
          }}>Remove Field</Button></div>}
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
          <PropertyGrid rows={[
            {
              id: `${documentId}-save-data-definition`, kind: "asset", label: "Data Definition", value: stored.dataDefinitionId ?? null,
              displayLabel: stored.dataDefinitionId ? dataDefinitions.find((entry) => entry.guid === stored.dataDefinitionId)?.name ?? "Missing Data Definition" : undefined,
              displayType: "DataDefinition", placeholder: "None",
              description: "Takes the fields from this Data Definition, so they are edited there. Default values can still be changed here.",
              onPick: () => setDataDefinitionPickerOpen(true), onChange: (next) => requestLink(next || null),
            },
            { id: `${documentId}-save-schema-version`, label: "Schema Version", kind: "number", min: 1, precision: 0, value: stored.schemaVersion, description: "Increase for incompatible changes, then register a gameplay migration before Load Game.", onChange: (schemaVersion) => void commit({ ...stored, schemaVersion: Math.max(1, Math.round(schemaVersion)) }) },
          ]} />
          <AssetPicker open={dataDefinitionPickerOpen} onOpenChange={setDataDefinitionPickerOpen} title="Pick Data Definition" allowNone
            assets={dataDefinitions.map((entry) => ({ guid: entry.guid, name: entry.name, type: "DataDefinition" }))} allowedTypes={["DataDefinition"]}
            onPick={(target) => requestLink(target)} />
          <FieldSet className="gap-2"><FieldLegend variant="label">Generated Type</FieldLegend><pre className="select-text overflow-auto rounded-md border border-border p-2 text-xs" tabIndex={0}>{generateSaveGameTypes(definition)}</pre></FieldSet>
        </FieldGroup>
      </DisclosureSection>
      <AlertDialog open={!!pendingLink} onOpenChange={(open) => { if (!open) setPendingLink(null); }}>
        <AlertDialogContent variant="destructive">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace {stored.fields.length} {stored.fields.length === 1 ? "Field" : "Fields"}?</AlertDialogTitle>
            <AlertDialogDescription>The fields come from {pendingLink?.name} instead. Values saved for the current fields won't load.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" data-testid="save-game-link-confirm" onClick={() => { if (pendingLink) link(pendingLink.guid); setPendingLink(null); }}>Replace Fields</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </> : null}
  </FieldGroup></PanelFrame>;
}
