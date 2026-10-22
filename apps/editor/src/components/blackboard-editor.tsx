import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import {
  createDefaultBlackboard,
  parseBlackboardDocument,
  type BlackboardDocument,
  type BlackboardKey,
} from "@haptic/behaviour-tree";
import {
  AssetPicker,
  PanelFrame,
  PinTypePicker,
  PropertyGrid,
  PropertySectionTitle,
  TreeView,
  TypeColorMark,
  assetRowIdentity,
  pinPickerColorVar,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  defaultValueForMember,
  keepsTypeClassId,
  pinTypeForMember,
  typeClassIdFromPinType,
  typeIdFromPinType,
} from "@haptic/scripting";
import { useDocumentActions, useOpenDocument, useRegistryState } from "../context/document-context";
import { useBlackboardEditing } from "../context/blackboard-editing-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { IconActionButton } from "./icon-action-button";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import {
  collectEnumMemberNames,
  variableAssetPickerAllowedTypes,
  variableDefaultPropertyRows,
} from "../lib/graph-inspector";
import { unitPatchForType, valueUnitRow } from "../lib/value-unit-row";
import {
  collectGraphTypeAssets,
  typeAssetPickerEntries,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";

function asBoard(payload: Record<string, unknown>): BlackboardDocument {
  return parseBlackboardDocument(payload) ?? createDefaultBlackboard();
}

function uniqueKeyName(keys: readonly BlackboardKey[]): string {
  const used = new Set(keys.map((key) => key.name));
  if (!used.has("key")) return "key";
  let index = 2;
  while (used.has(`key${index}`)) index += 1;
  return `key${index}`;
}

/** Open Structure, Enum and Data Definition tabs override their saved types. */
const TYPE_KINDS = ["structure", "enum", "data-definition"] as const;

/** Type-picker value for a key: Tag Container is a struct with an engine class. */
function keyPickerType(key: BlackboardKey): string {
  const typeId = typeIdFromPinType(key.type);
  return typeId === "struct" && typeClassIdFromPinType(key.type) === "engine:TagContainer" ? "tagContainer" : typeId;
}

const keyRowId = (index: number) => `key:${index}`;
const keyIndexFromRow = (id: string) => {
  const index = Number(id.slice("key:".length));
  return id.startsWith("key:") && Number.isInteger(index) ? index : null;
};

function useBlackboardDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return {
    payload,
    commit: (next: Record<string, unknown>, mergeKey?: string) =>
      void applyAssetDocumentChange(documentId, next, mergeKey),
  };
}

export function BlackboardKeysPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, commit } = useBlackboardDocument();
  const { selected, select } = useBlackboardEditing();
  return <BlackboardKeys payload={payload} onChange={commit} selected={selected} onSelect={select} />;
}

export function BlackboardInspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, commit } = useBlackboardDocument();
  const { selected, select } = useBlackboardEditing();
  return <BlackboardInspector payload={payload} onChange={commit} selected={selected} onSelect={select} />;
}

type BlackboardEditorProps = {
  payload: Record<string, unknown>;
  /** `mergeKey` groups one scrub's edits into one undo entry. */
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
  selected: number | null;
  onSelect: (index: number | null) => void;
};

const commitBoard = (onChange: BlackboardEditorProps["onChange"]) => (next: BlackboardDocument, mergeKey?: string) => {
  const record = next as unknown as Record<string, unknown>;
  if (mergeKey) onChange(record, mergeKey);
  else onChange(record);
};

/** The keys as rows: type colour, name (double-tap or F2 renames) and a compact type picker. */
export function BlackboardKeys({ payload, onChange, selected, onSelect }: BlackboardEditorProps) {
  const doc = useMemo(() => asBoard(payload), [payload]);
  const commit = commitBoard(onChange);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const { assetRegistry } = useRegistryState();
  const openDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const typeSchemas = typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets: assetRegistry?.list() ?? [], openDocuments }));
  const current = selected !== null && selected < doc.keys.length ? selected : null;
  const setType = (index: number, selectedType: string) => {
    const entry = doc.keys[index];
    if (!entry) return;
    const typeId = selectedType === "tagContainer" ? "struct" : selectedType;
    const previousClass = typeClassIdFromPinType(entry.type);
    const nextTypeClassId = selectedType === "tagContainer"
      ? "engine:TagContainer" : keepsTypeClassId(typeId) ? previousClass : undefined;
    commit({
      ...doc,
      keys: doc.keys.map((row, at) => at === index
        ? { ...row, type: pinTypeForMember(typeId, nextTypeClassId), defaultValue: defaultValueForMember(typeId, nextTypeClassId, typeSchemas), ...unitPatchForType(typeId) }
        : row),
    });
  };
  return (
    <PanelFrame
      data-testid="blackboard-keys-panel"
      toolbar={
        <>
          <IconActionButton
            label="Add Key"
            data-testid="blackboard-add-key"
            onClick={() => {
              const next: BlackboardKey = { name: uniqueKeyName(doc.keys), type: pinTypeForMember("bool"), defaultValue: false };
              commit({ ...doc, keys: [...doc.keys, next] });
              onSelect(doc.keys.length);
              setRenamingId(keyRowId(doc.keys.length));
            }}
          >
            <PlusIcon />
          </IconActionButton>
          <IconActionButton
            label="Delete Key"
            disabled={current === null}
            data-testid="blackboard-delete-key"
            onClick={() => {
              if (current === null) return;
              commit({ ...doc, keys: doc.keys.filter((_, index) => index !== current) });
              onSelect(doc.keys.length > 1 ? Math.max(0, current - 1) : null);
            }}
          >
            <Trash2Icon />
          </IconActionButton>
        </>
      }
    >
      <TreeView
        nodes={doc.keys.map((entry, index) => ({
          id: keyRowId(index),
          label: entry.name,
          depth: 0,
          hasChildren: false,
          expanded: false,
          renamable: true,
          draggable: false,
          icon: <TypeColorMark colorVar={pinPickerColorVar(keyPickerType(entry))} />,
          trailing: (
            <PinTypePicker
              compact
              labels={{ struct: "Structure / Data Definition" }}
              value={keyPickerType(entry)}
              onChange={(type) => setType(index, type)}
              data-testid={`blackboard-key-type-${index}`}
            />
          ),
        }))}
        selectedId={current === null ? null : keyRowId(current)}
        onSelect={(id) => onSelect(keyIndexFromRow(id))}
        renamingId={renamingId}
        onRenameRequest={setRenamingId}
        onRenameDone={(id, name) => {
          setRenamingId(null);
          const index = keyIndexFromRow(id);
          if (name === null || index === null || !name.trim()) return;
          commit({ ...doc, keys: doc.keys.map((entry, at) => (at === index ? { ...entry, name: name.trim() } : entry)) });
        }}
        emptyLabel="No Keys"
        aria-label="Blackboard Keys"
        data-testid="blackboard-keys-tree"
      />
    </PanelFrame>
  );
}

/** The selected key's name, type, record or enum type and default value. */
export function BlackboardInspector({ payload, onChange, selected }: BlackboardEditorProps) {
  const { assetRegistry } = useRegistryState();
  const openDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const doc = useMemo(() => asBoard(payload), [payload]);
  const [typeAssetPickerOpen, setTypeAssetPickerOpen] = useState(false);
  /** The default row that asked for an asset, so a Structure field pick writes only that field. */
  const [defaultAssetPick, setDefaultAssetPick] = useState<{ rowId: string; assetType: string } | null>(null);
  const typeCatalog = collectGraphTypeAssets({
    assets: assetRegistry?.list() ?? [],
    openDocuments,
  });
  const typeSchemas = typeSchemasFromGraphAssets(typeCatalog);
  const typeAssets = typeAssetPickerEntries(typeCatalog);
  const pickerAssets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const enumMembers = collectEnumMemberNames(openDocuments, assetRegistry?.list() ?? []);
  const commit = commitBoard(onChange);
  const index = selected !== null && selected < doc.keys.length ? selected : null;
  const key = index === null ? undefined : doc.keys[index];
  const pickerTypeId = key ? typeIdFromPinType(key.type) : "bool";
  const typeClassId = key ? typeClassIdFromPinType(key.type) : undefined;
  const isStruct = pickerTypeId === "struct";
  const isEnum = pickerTypeId === "enum";
  const typeAsset = typeAssets.find((entry) => entry.guid === typeClassId);
  const patchKey = (patch: Partial<BlackboardKey>, mergeKey?: string) =>
    commit({ ...doc, keys: doc.keys.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)) }, mergeKey);

  if (!key || index === null) {
    return (
      <PanelFrame data-testid="blackboard-inspector-panel">
        <p className="p-3 text-xs text-muted-foreground">Select a key to edit its type and default value.</p>
      </PanelFrame>
    );
  }

  const keyRows: PropertyRow[] = [
    { id: "name", kind: "text", label: "Name", value: key.name, onChange: (name) => patchKey({ name }) },
  ];
  if (isStruct && typeClassId !== "engine:TagContainer" || isEnum) {
    keyRows.push({
      id: "type-asset",
      kind: "asset",
      label: isEnum ? "Enum Type" : "Record Type",
      value: typeClassId ?? null,
      placeholder: "Pick Type",
      onPick: () => setTypeAssetPickerOpen(true),
      onChange: (guid) => patchKey({
        type: pinTypeForMember(pickerTypeId, guid ?? undefined),
        defaultValue: defaultValueForMember(pickerTypeId, guid ?? undefined, typeSchemas),
      }),
      ...assetRowIdentity(
        typeAsset
          ? { name: typeAsset.name, type: typeAsset.type }
          : typeClassId
            ? { name: typeClassId, type: isEnum ? "Enum" : "Record" }
            : undefined,
      ),
      testId: "blackboard-key-type-asset",
    });
  }
  const defaultRows = variableDefaultPropertyRows(
    pickerTypeId,
    key.defaultValue,
    // Default editors scrub numbers, vectors and colors continuously.
    (value) => patchKey({ defaultValue: value }, `blackboard:key:${index}:defaultValue`),
    {
      typeClassId,
      schemas: typeSchemas,
      enumMembers,
      assetEntries: pickerAssets.map((entry) => ({ id: entry.guid, name: entry.name, type: entry.type })),
      onPickAsset: (rowId, assetType) => setDefaultAssetPick({ rowId, assetType }),
      unit: key.unit,
    },
  );
  const unitRow = valueUnitRow("unit", pickerTypeId, key.unit, (unit) => patchKey({ unit }));
  if (unitRow) keyRows.push(unitRow);

  return (
    <PanelFrame data-testid="blackboard-inspector-panel">
      <div className="flex flex-col" data-testid="blackboard-details">
        <PropertySectionTitle>Key</PropertySectionTitle>
        <PropertyGrid rows={keyRows.slice(0, 1)} />
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <span className="text-sm font-medium leading-snug text-foreground">Type</span>
          <PinTypePicker
            labels={{ struct: "Structure / Data Definition" }}
            value={keyPickerType(key)}
            onChange={(selectedType) => {
              const typeId = selectedType === "tagContainer" ? "struct" : selectedType;
              const nextTypeClassId = selectedType === "tagContainer"
                ? "engine:TagContainer" : keepsTypeClassId(typeId) ? typeClassId : undefined;
              patchKey({
                type: pinTypeForMember(typeId, nextTypeClassId),
                defaultValue: defaultValueForMember(typeId, nextTypeClassId, typeSchemas),
                ...unitPatchForType(typeId),
              });
            }}
            data-testid="blackboard-key-type"
          />
        </div>
        {keyRows.length > 1 ? <PropertyGrid rows={keyRows.slice(1)} /> : null}
        {defaultRows.length > 0 ? (
          <>
            <PropertySectionTitle>Default Value</PropertySectionTitle>
            <PropertyGrid rows={defaultRows} />
          </>
        ) : null}
      </div>
      <AssetPicker
        open={typeAssetPickerOpen}
        onOpenChange={setTypeAssetPickerOpen}
        assets={typeAssets}
        allowedTypes={isEnum ? ["Enum"] : ["Structure", "DataDefinition"]}
        allowNone
        title={isEnum ? "Pick Enum Type" : "Pick Record Type"}
        onPick={(guid) => {
          patchKey({
            type: pinTypeForMember(pickerTypeId, guid ?? undefined),
            defaultValue: defaultValueForMember(pickerTypeId, guid ?? undefined, typeSchemas),
          });
          setTypeAssetPickerOpen(false);
        }}
        data-testid="blackboard-key-type-asset-picker"
      />
      <AssetPicker
        open={defaultAssetPick !== null}
        onOpenChange={(open) => {
          if (!open) setDefaultAssetPick(null);
        }}
        assets={pickerAssets}
        allowedTypes={variableAssetPickerAllowedTypes(defaultAssetPick?.assetType)}
        allowNone
        title="Pick Asset"
        onPick={(guid) => {
          const row = defaultRows.find((entry) => entry.id === defaultAssetPick?.rowId);
          if (row?.kind === "asset") row.onChange(guid ?? "");
          setDefaultAssetPick(null);
        }}
        data-testid="blackboard-key-default-asset-picker"
      />
    </PanelFrame>
  );
}
