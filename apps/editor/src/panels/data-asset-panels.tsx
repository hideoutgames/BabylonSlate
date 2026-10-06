import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  documentId as documentIdForRef,
  isDataObjectAsset,
  isDataSheetAsset,
  type DataObjectAsset,
  type DataSheetAsset,
} from "@babylonslate/core";
import {
  createDataObjectForStructure,
  reconcileDataObject,
  validateDataObject,
  type StructField,
  type TypeSchemas,
} from "@babylonslate/scripting";
import {
  AssetPicker,
  ClassPicker,
  NamePromptDialog,
  NumberField,
  PanelFrame,
  PropertyGrid,
  SearchInput,
  SearchDropdown,
  WindowedList,
  humanizePropertyLabel,
  isCoarsePointerEnvironment,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { cn } from "@babylonslate/ui/lib/utils";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useDataAssetEditing } from "../context/data-asset-editing-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";
import { assetPickerAllowedTypes, variableDefaultPropertyRows } from "../lib/graph-inspector";
import { createPickerAsset } from "../lib/create-project-asset";
import { subclassClassEntries } from "../lib/component-property-rows";

const DATA_KINDS = ["data-object", "data-sheet"] as const;
const TYPE_KINDS = ["structure", "enum"] as const;
const TOUCH_ACTION = "pointer-coarse:min-h-11";

function recursiveStructure(guid: string, schemas: TypeSchemas, visiting = new Set<string>()): boolean {
  if (visiting.has(guid) || visiting.size > 64) return true;
  const next = new Set([...visiting, guid]);
  return Boolean(schemas.structs[guid]?.fields.some((field) => field.typeId === "struct" && field.typeClassId && recursiveStructure(field.typeClassId, schemas, next)));
}

/** Graph property controls hydrate known fields; data editing also keeps retired values. */
function preserveAuthoredFields(previous: unknown, next: unknown, depth = 0): unknown {
  if (depth > 64 || !previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) || Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  return Object.fromEntries(Object.entries({ ...before, ...next }).map(([key, value]) => [key,
    Object.prototype.hasOwnProperty.call(next, key) ? preserveAuthoredFields(before[key], value, depth + 1) : value,
  ]));
}

/** Indexed headers supply closed rows; open document values always take priority. */
function useDataCatalog() {
  const { assetRegistry, registryEpoch } = useDocuments();
  const dataDocuments = useOpenDocumentsOfKinds(DATA_KINDS);
  const typeDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const assets = useMemo(() => {
    void registryEpoch;
    return assetRegistry?.list() ?? [];
  }, [assetRegistry, registryEpoch]);
  const byGuid = useMemo(() => new Map(assets.map((asset) => [asset.header.guid, asset])), [assets]);
  const byPath = useMemo(() => new Map(assets.map((asset) => [asset.path, asset])), [assets]);
  const openByPath = useMemo(() => new Map(dataDocuments.map((doc) => [doc.ref.path, doc])), [dataDocuments]);
  const types = useMemo(() => collectGraphTypeAssets({ assets, openDocuments: typeDocuments }), [assets, typeDocuments]);
  const schemas = useMemo(() => typeSchemasFromGraphAssets(types), [types]);
  const enumMembers = useMemo(() => Object.fromEntries(types.enums.map((entry) => [entry.guid, entry.members.map((member) => member.name)])), [types]);
  const objects = useMemo(() => ({ get(guid: string): DataObjectAsset | undefined {
    const indexed = byGuid.get(guid);
    if (indexed?.header.type !== "DataObject") return undefined;
    const value = openByPath.get(indexed.path)?.content ?? indexed.header.payload;
    return isDataObjectAsset(value) ? value : undefined;
  } }), [byGuid, openByPath]);
  const reconciliationFor = useMemo(() => {
    const cache = new WeakMap<DataObjectAsset, ReturnType<typeof reconcileDataObject>>();
    return (asset: DataObjectAsset) => {
      const fields = asset.structureGuid ? schemas.structs[asset.structureGuid]?.fields : undefined;
      if (!fields) return null;
      let result = cache.get(asset);
      if (!result) { result = reconcileDataObject(asset, fields, schemas); cache.set(asset, result); }
      return result;
    };
  }, [schemas]);
  const pickerAssets = useMemo(() => assets.map((asset) => ({
    guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path,
  })), [assets]);
  const classEntries = useMemo(() => subclassClassEntries("BObject", assets), [assets]);
  const propertyAssets = useMemo(() => pickerAssets.map((entry) => ({ id: entry.guid, name: entry.name, type: entry.type })), [pickerAssets]);
  return { assets, byGuid, byPath, openByPath, objects, reconciliationFor, types, schemas, enumMembers, pickerAssets, propertyAssets, classEntries };
}

function OperationError({ message }: { message: string | null }) {
  return message ? <Alert variant="destructive"><AlertTitle>Data Edit Failed</AlertTitle><AlertDescription>{message}</AlertDescription></Alert> : null;
}

function DataEmpty({ title, children }: { title: string; children: string }) {
  return <Empty className="p-4"><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{children}</EmptyDescription></EmptyHeader></Empty>;
}

function previewValue(value: unknown, assetName: (guid: string) => string | undefined): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return assetName(value) ?? value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function DataSheetCell({ field, value, label, editable, enums, onChange, preview }: {
  field: StructField;
  value: unknown;
  label: string;
  editable: boolean;
  enums: Record<string, string[]>;
  onChange: (value: unknown) => void;
  preview: string;
}) {
  const control = "h-6 min-h-6 w-full rounded-sm px-1 text-xs pointer-coarse:h-11";
  if (!editable) return <span title={preview} className="block truncate">{preview}</span>;
  if (field.typeId === "float" || field.typeId === "int") {
    return <NumberField aria-label={label} className={control} value={typeof value === "number" ? value : 0} onChange={(next) => onChange(field.typeId === "int" ? Math.trunc(next) : next)} />;
  }
  if (field.typeId === "bool") return <Checkbox aria-label={label} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />;
  if (field.typeId === "string") return <Input key={String(value)} aria-label={label} className={control} defaultValue={typeof value === "string" ? value : ""} onBlur={(event) => {
    if (event.target.value !== value) onChange(event.target.value);
  }} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.currentTarget.value = typeof value === "string" ? value : ""; event.currentTarget.blur(); }
    if (event.key === "Enter") event.currentTarget.blur();
  }} />;
  if (field.typeId === "enum") return <SearchDropdown title={label} items={(enums[field.typeClassId ?? ""] ?? []).map((name) => ({ id: name, label: humanizePropertyLabel(name) }))} onSelect={onChange}>
    <Button size="xs" variant="ghost" aria-label={label} className="w-full justify-start truncate pointer-coarse:h-11">{humanizePropertyLabel(String(value ?? "Choose"))}</Button>
  </SearchDropdown>;
  return <span title={preview} className="block truncate">{preview}</span>;
}

export function DataSheetRowsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const gridId = useId();
  const documents = useDocuments();
  const catalog = useDataCatalog();
  const { selectedGuid, select } = useDataAssetEditing();
  const doc = documents.openDocuments.find((entry) => entry.id === documentId);
  const sheet = isDataSheetAsset(doc?.content) ? doc.content : null;
  const [query, setQuery] = useState("");
  const [structurePicker, setStructurePicker] = useState(false);
  const [objectPicker, setObjectPicker] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const cellWrites = useRef(new Map<string, Promise<void>>());
  const schema = sheet?.structureGuid ? catalog.schemas.structs[sheet.structureGuid] : undefined;
  const structureName = sheet?.structureGuid ? catalog.types.structures.find((entry) => entry.guid === sheet.structureGuid)?.name ?? "Missing Structure" : "Choose Structure";
  const ownerAsset = doc ? catalog.byPath.get(doc.ref.path) : undefined;
  const readOnly = Boolean(ownerAsset && documents.assetRegistry?.getRoot(ownerAsset.rootId)?.readOnly) || Boolean(doc && documents.sourceControl.isDocumentReadOnly(doc.ref.path));
  const memberSet = useMemo(() => new Set(sheet?.objectGuids ?? []), [sheet?.objectGuids]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (sheet?.objectGuids ?? []).filter((guid) => {
      const asset = catalog.byGuid.get(guid);
      return !search || `${asset?.header.name ?? "Missing Object"} ${asset?.path ?? guid}`.toLocaleLowerCase().includes(search);
    });
  }, [sheet?.objectGuids, query, catalog.byGuid]);
  const selectedIndex = filtered.indexOf(selectedGuid ?? "");
  const selectedAsset = selectedGuid ? catalog.byGuid.get(selectedGuid) : undefined;
  const rowHeight = isCoarsePointerEnvironment() ? 44 : 28;
  const gridColumns = `minmax(180px, 1.5fr) ${schema?.fields.map(() => "minmax(120px, 1fr)").join(" ") ?? ""} minmax(110px, 1fr)`;

  const run = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { mutation.current = false; setBusy(false); }
  };
  const commit = async (next: DataSheetAsset) => {
    const changed = await documents.applyAssetDocumentChange(documentId, { ...next });
    if (!changed) throw new Error("The sheet could not be edited. Check whether the asset is read-only or locked.");
  };
  const openSelected = () => {
    if (selectedAsset?.header.type !== "DataObject") return;
    void run(() => documents.openDocument({ kind: "data-object", path: selectedAsset.path, label: selectedAsset.header.name }));
  };
  const editCell = (guid: string, field: StructField, value: unknown) => {
    select(guid);
    const previous = cellWrites.current.get(guid) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      const indexed = documents.assetRegistry?.getByGuid(guid);
      if (!indexed || indexed.header.type !== "DataObject") throw new Error("This Data Object is no longer available.");
      const id = await documents.ensureAssetDocument({ kind: "data-object", path: indexed.path, label: indexed.header.name });
      const current = documents.getOpenDocuments().find((entry) => entry.id === id)?.content;
      if (!isDataObjectAsset(current) || current.structureGuid !== sheet?.structureGuid) throw new Error("The object's Structure changed. Open the object to review its fields.");
      const fields = catalog.schemas.structs[current.structureGuid ?? ""]?.fields;
      const migration = fields ? reconcileDataObject(current, fields, catalog.schemas) : null;
      if (!migration || migration.changes.some((change) => change.kind === "added" || change.kind === "renamed") || migration.issues.some((issue) => ["rename-conflict", "ambiguous-schema", "invalid-schema", "recursive-schema"].includes(issue.code))) throw new Error("Apply the Structure changes in Values before editing this object.");
      if (Object.is(current.values[field.name], value)) return;
      const next = reconcileDataObject({ ...current, values: { ...current.values, [field.name]: value } }, fields!, catalog.schemas).asset;
      if (!await documents.applyAssetDocumentChange(id, { ...next }, `data:${field.id ?? field.name}`)) throw new Error("The object could not be edited. Check whether it is read-only or locked.");
    });
    cellWrites.current.set(guid, write);
    void write.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => {
      if (cellWrites.current.get(guid) === write) cellWrites.current.delete(guid);
    });
  };
  const moveSelected = (direction: -1 | 1) => {
    if (!sheet || !selectedGuid) return;
    const index = sheet.objectGuids.indexOf(selectedGuid);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= sheet.objectGuids.length) return;
    const objectGuids = [...sheet.objectGuids];
    [objectGuids[index], objectGuids[next]] = [objectGuids[next]!, objectGuids[index]!];
    void run(() => commit({ ...sheet, objectGuids }));
  };
  if (!sheet || !doc) return <PanelFrame><DataEmpty title="Data Sheet Unavailable">Reopen the asset to reload its data.</DataEmpty></PanelFrame>;
  return (
    <PanelFrame data-testid="data-sheet-rows-panel">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-border bg-panel-header px-2 py-1">
        <Button variant="outline" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || sheet.objectGuids.length > 0} onClick={() => setStructurePicker(true)} title={sheet.objectGuids.length ? "Remove sheet membership before changing the Structure." : undefined} data-testid="data-sheet-structure">{structureName}</Button>
        <Button variant="outline" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !schema} onClick={() => setCreating(true)}>New Object</Button>
        <Button variant="outline" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !schema} onClick={() => setObjectPicker(true)}>Add Existing</Button>
        <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !selectedGuid || !memberSet.has(selectedGuid)} onClick={() => void run(async () => {
          await commit({ ...sheet, objectGuids: sheet.objectGuids.filter((guid) => guid !== selectedGuid) });
          select(null);
        })}>Remove</Button>
        <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={!selectedAsset || busy} onClick={openSelected}>Open Object</Button>
        <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !selectedGuid || sheet.objectGuids.indexOf(selectedGuid) <= 0} onClick={() => moveSelected(-1)}>Move Up</Button>
        <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !selectedGuid || !memberSet.has(selectedGuid) || sheet.objectGuids.indexOf(selectedGuid) >= sheet.objectGuids.length - 1} onClick={() => moveSelected(1)}>Move Down</Button>
        <div className="min-w-36 flex-1"><SearchInput value={query} onChange={setQuery} placeholder="Filter Objects…" aria-label="Filter Objects" className="h-7 pointer-coarse:min-h-11" /></div>
        <span className="px-1 text-xs text-muted-foreground" role="status">{filtered.length} / {sheet.objectGuids.length}</span>
      </div>
      <OperationError message={error} />
      {!sheet.structureGuid ? <DataEmpty title="Choose A Structure">A Structure defines the fields shared by objects in this sheet.</DataEmpty> : !schema ? <DataEmpty title="Structure Missing">Restore the referenced Structure to edit this sheet.</DataEmpty> : filtered.length === 0 ? <DataEmpty title={sheet.objectGuids.length ? "No Matching Objects" : "No Objects"}>{sheet.objectGuids.length ? "Change the filter to see more objects." : "Create an object or add an existing one. Removing a row only removes its membership in this sheet."}</DataEmpty> : (
        <div className="min-w-full" style={{ minWidth: 320 + schema.fields.length * 120 }} role="grid" aria-label="Data Sheet Objects" aria-rowcount={filtered.length + 1} aria-colcount={schema.fields.length + 2} tabIndex={0} aria-activedescendant={selectedGuid && selectedIndex >= 0 ? `${gridId}-${selectedGuid}` : undefined}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.nativeEvent.isComposing) return;
            let next = selectedIndex;
            if (event.key === "ArrowDown") next = Math.min(filtered.length - 1, selectedIndex + 1);
            else if (event.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = filtered.length - 1;
            else if (event.key === "Enter") { event.preventDefault(); openSelected(); return; }
            else return;
            event.preventDefault();
            select(filtered[next] ?? null);
          }}>
          <div role="row" className="grid h-7 items-center border-b border-border bg-muted/30 text-xs text-muted-foreground" style={{ gridTemplateColumns: gridColumns }}>
            <span role="columnheader" className="truncate px-2">Object</span>
            {schema.fields.map((field) => <span key={field.id ?? field.name} role="columnheader" className="truncate px-2">{humanizePropertyLabel(field.name)}</span>)}
            <span role="columnheader" className="px-2">Status</span>
          </div>
          <WindowedList itemCount={filtered.length} rowHeight={rowHeight} activeIndex={selectedIndex}>
            {(index) => {
              const guid = filtered[index]!;
              const asset = catalog.byGuid.get(guid);
              const object = catalog.objects.get(guid);
              const valid = object?.structureGuid === sheet.structureGuid;
              const migration = object && valid ? catalog.reconciliationFor(object) : null;
              const needsMigration = migration?.changes.some((change) => change.kind === "added" || change.kind === "renamed") || migration?.issues.some((issue) => ["rename-conflict", "ambiguous-schema", "invalid-schema", "recursive-schema"].includes(issue.code));
              const changedType = migration?.changes.some((change) => change.kind === "typeChanged");
              const invalidValues = migration?.issues.some((issue) => issue.severity === "error");
              const open = asset ? catalog.openByPath.get(asset.path) : undefined;
              const status = !object ? "Missing Object" : !valid ? "Structure Mismatch" : needsMigration ? "Structure Changed" : changedType ? "Review Value Type" : invalidValues ? "Invalid Values" : open?.dirty ? "Modified" : "";
              return <div id={`${gridId}-${guid}`} role="row" aria-rowindex={index + 2} aria-selected={selectedGuid === guid} data-testid={`data-sheet-row-${guid}`} className={cn("grid h-full cursor-default items-center border-b border-border/50 text-xs hover:bg-accent/50", selectedGuid === guid && "bg-accent")} style={{ gridTemplateColumns: gridColumns }} onClick={() => select(guid)} onDoubleClick={() => {
                if (asset?.header.type === "DataObject") void run(() => documents.openDocument({ kind: "data-object", path: asset.path, label: asset.header.name }));
              }}>
                <span role="gridcell" className="truncate px-2" title={asset?.path ?? guid}>{asset?.header.name ?? guid}</span>
                {schema.fields.map((field) => <div key={field.id ?? field.name} role="gridcell" className="min-w-0 px-1" onDoubleClick={(event) => event.stopPropagation()}>
                  <DataSheetCell field={field} value={object?.values[field.name]} label={`${asset?.header.name ?? guid} ${humanizePropertyLabel(field.name)}`} editable={Boolean(valid && !needsMigration && !readOnly && asset && !documents.assetRegistry?.getRoot(asset.rootId)?.readOnly && !documents.sourceControl.isDocumentReadOnly(asset.path))} enums={catalog.enumMembers} onChange={(value) => editCell(guid, field, value)} preview={previewValue(object?.values[field.name], (value) => catalog.byGuid.get(value)?.header.name)} />
                </div>)}
                <span role="gridcell" className={cn("truncate px-2", !valid || invalidValues ? "text-destructive" : "text-muted-foreground")}>{status}</span>
              </div>;
            }}
          </WindowedList>
        </div>
      )}
      <AssetPicker open={structurePicker} onOpenChange={setStructurePicker} title="Choose Structure" allowedTypes={["Structure"]} assets={catalog.types.structures.map((entry) => ({ ...entry, type: "Structure" }))} allowNone={false} onPick={(guid) => {
        setStructurePicker(false);
        if (guid && guid !== sheet.structureGuid) void run(() => commit({ ...sheet, structureGuid: guid }));
      }} />
      <AssetPicker open={objectPicker} onOpenChange={setObjectPicker} title="Add Existing Object" allowedTypes={["DataObject"]} createTypes={[]} allowNone={false} assets={objectPicker ? catalog.pickerAssets.filter((entry) => !memberSet.has(entry.guid) && catalog.objects.get(entry.guid)?.structureGuid === sheet.structureGuid) : []} onPick={(guid) => {
        setObjectPicker(false);
        if (!guid || memberSet.has(guid) || catalog.objects.get(guid)?.structureGuid !== sheet.structureGuid) return;
        void run(async () => { await commit({ ...sheet, objectGuids: [...sheet.objectGuids, guid] }); select(guid); });
      }} />
      <NamePromptDialog open={creating} onOpenChange={setCreating} title="New Data Object" label="Name" confirmLabel="Create" validate={(name) => /[\\/]/.test(name) ? "Use a name without path separators." : null} onSubmit={(name) => void run(async () => {
        if (!documents.assetRegistry || !sheet.structureGuid) return;
        const created = await createPickerAsset({ registry: documents.assetRegistry, ownerPath: doc.ref.path, openDocuments: documents.getOpenDocuments(), type: "DataObject", name, structureGuid: sheet.structureGuid });
        documents.noteAssetsCreated();
        const current = documents.getOpenDocuments().find((entry) => entry.id === documentId)?.content;
        if (!isDataSheetAsset(current) || current.structureGuid !== sheet.structureGuid) throw new Error("The object was created, but the sheet changed. Add the object from the Content Browser when ready.");
        await commit({ ...current, objectGuids: [...current.objectGuids, created.header.guid] });
        select(created.header.guid);
      })} />
    </PanelFrame>
  );
}

export function DataObjectValuesPanel(_props: IDockviewPanelProps) {
  void _props;
  const formId = useId();
  const { documentId } = useDocumentWorkspace();
  const documents = useDocuments();
  const catalog = useDataCatalog();
  const { selectedGuid } = useDataAssetEditing();
  const workspace = documents.openDocuments.find((entry) => entry.id === documentId);
  const sheet = isDataSheetAsset(workspace?.content) ? workspace.content : null;
  const selectedAsset = sheet && selectedGuid && sheet.objectGuids.includes(selectedGuid) ? catalog.byGuid.get(selectedGuid) : undefined;
  const targetRef = sheet ? selectedAsset?.header.type === "DataObject" ? { kind: "data-object" as const, path: selectedAsset.path, label: selectedAsset.header.name } : null : workspace?.ref;
  const targetId = targetRef ? documentIdForRef(targetRef) : null;
  const target = targetId ? documents.openDocuments.find((entry) => entry.id === targetId) : undefined;
  const targetLoaded = Boolean(target);
  const asset = isDataObjectAsset(target?.content) ? target.content : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [structurePicker, setStructurePicker] = useState(false);
  const [assetPicker, setAssetPicker] = useState<{ rowId: string; allowedTypes: string[] } | null>(null);
  const [classPicker, setClassPicker] = useState<{ rowId: string; base: string } | null>(null);
  const [pendingStructure, setPendingStructure] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const latestTarget = useRef(targetId);
  latestTarget.current = targetId;
  const indexed = targetRef ? catalog.byPath.get(targetRef.path) : undefined;
  const readOnly = Boolean(indexed && documents.assetRegistry?.getRoot(indexed.rootId)?.readOnly) || Boolean(targetRef && documents.sourceControl.isDocumentReadOnly(targetRef.path));
  const schema = asset?.structureGuid ? catalog.schemas.structs[asset.structureGuid] : undefined;
  const recursive = useMemo(() => Boolean(asset?.structureGuid && recursiveStructure(asset.structureGuid, catalog.schemas)), [asset?.structureGuid, catalog.schemas]);
  const defaults = useMemo(() => asset?.structureGuid && schema && !recursive ? createDataObjectForStructure(asset.structureGuid, schema.fields, catalog.schemas).values : {}, [asset?.structureGuid, schema, catalog.schemas, recursive]);
  const migration = useMemo(() => asset ? catalog.reconciliationFor(asset) : null, [asset, catalog.reconciliationFor]);
  const issues = useMemo(() => asset ? validateDataObject(asset, catalog.schemas, { assetTypeForGuid: (guid) => catalog.byGuid.get(guid)?.header.type }) : [], [asset, catalog.schemas, catalog.byGuid]);
  const visibleIssues = asset?.structureGuid ? issues : issues.filter((issue) => issue.code !== "missing-structure" || issue.path);
  const schemaChanged = Boolean(migration?.changes.some((change) => change.kind !== "removed"));
  const needsStructuralApply = Boolean(migration?.changes.some((change) => change.kind === "added" || change.kind === "renamed"));
  const migrationBlocked = Boolean(migration?.issues.some((issue) => ["rename-conflict", "ambiguous-schema", "invalid-schema", "recursive-schema"].includes(issue.code)));
  const editable = !readOnly && !needsStructuralApply && !migrationBlocked;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setAssetPicker(null);
    setClassPicker(null);
    setReview(false);
    setPendingStructure(null);
    if (!sheet || !targetRef || target) { setLoading(false); return; }
    setLoading(true);
    void documents.ensureAssetDocument(targetRef).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Selection is keyed by identity; opening a document should not restart its request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, targetLoaded, documents.ensureAssetDocument]);

  const commit = (next: DataObjectAsset, mergeKey?: string) => {
    if (!targetId) return;
    setError(null);
    const identity = targetId;
    void documents.applyAssetDocumentChange(identity, { ...next }, mergeKey).then((changed) => {
      if (!changed && latestTarget.current === identity && JSON.stringify(next) !== JSON.stringify(asset)) setError("The object could not be edited. Check whether the asset is read-only or locked.");
    }).catch((reason: unknown) => { if (latestTarget.current === identity) setError(reason instanceof Error ? reason.message : String(reason)); });
  };
  const rows: PropertyRow[] = [];
  for (const field of recursive ? [] : schema?.fields ?? []) {
    const changeValue = (value: unknown) => {
      if (!asset || !targetId) return;
      const current = documents.getOpenDocuments().find((entry) => entry.id === targetId)?.content;
      if (!isDataObjectAsset(current)) return;
      const next = { ...current, values: { ...current.values, [field.name]: preserveAuthoredFields(current.values[field.name], value) } };
      commit(schema ? reconcileDataObject(next, schema.fields, catalog.schemas).asset : next, `data:${field.id ?? field.name}`);
    };
    const generated = variableDefaultPropertyRows(field.typeId, (migrationBlocked ? asset?.values : migration?.asset.values ?? asset?.values)?.[field.name], changeValue, {
      typeClassId: field.typeClassId, schemas: catalog.schemas, enumMembers: catalog.enumMembers,
      label: humanizePropertyLabel(field.name), pinId: field.name,
      assetEntries: catalog.propertyAssets,
      classEntries: catalog.classEntries,
      onPickAsset: (pinId, type) => setAssetPicker({ rowId: `${formId}:${field.name}:${pinId}`, allowedTypes: assetPickerAllowedTypes(type, undefined) }),
      onPickClass: (pinId, base) => setClassPicker({ rowId: `${formId}:${field.name}:${pinId}`, base }),
    });
    const defaultRows = variableDefaultPropertyRows(field.typeId, defaults[field.name], () => undefined, {
      typeClassId: field.typeClassId, schemas: catalog.schemas, enumMembers: catalog.enumMembers,
      label: humanizePropertyLabel(field.name), pinId: field.name, onPickClass: () => undefined,
    });
    const invalidValue = issues.some((issue) => issue.code === "type-mismatch" && (issue.path === field.name || issue.path.startsWith(`${field.name}.`)));
    rows.push(...generated.map((row, index) => ({ ...row, id: `${formId}:${field.name}:${row.id}`, disabled: !editable,
      // An invalid authored value may display the same fallback as its default.
      // Keep an explicit repair action available even in that case.
      defaultValue: invalidValue ? undefined : defaultRows.find((entry) => entry.id === row.id)?.value,
      labelAccessory: invalidValue && index === 0 ? <Button size="xs" variant="ghost" className={TOUCH_ACTION} disabled={!editable} aria-label={`Reset ${humanizePropertyLabel(field.name)}`} onClick={() => changeValue(defaults[field.name])}>Reset</Button> : undefined,
    } as PropertyRow)));
  }
  const structureName = asset?.structureGuid ? catalog.types.structures.find((entry) => entry.guid === asset.structureGuid)?.name ?? "Missing Structure" : "Choose Structure";
  const pickerRows = rows;

  return (
    <PanelFrame data-testid="data-object-values-panel" toolbar={asset && targetId ? <>
      {sheet ? <>
        <Button size="sm" variant="ghost" className={TOUCH_ACTION} disabled={readOnly || !documents.canUndoDocument(targetId)} onClick={() => documents.undoDocument(targetId)}>Undo Object</Button>
        <Button size="sm" variant="ghost" className={TOUCH_ACTION} disabled={readOnly || !documents.canRedoDocument(targetId)} onClick={() => documents.redoDocument(targetId)}>Redo Object</Button>
      </> : null}
      <Button size="sm" variant="ghost" className={TOUCH_ACTION} disabled={readOnly || !indexed} onClick={() => setRenaming(true)}>Rename</Button>
    </> : undefined}>
      <div className="flex flex-col gap-2 p-2">
        <OperationError message={error} />
        {loading ? <p role="status" className="text-xs text-muted-foreground">Loading Object…</p> : !asset ? <DataEmpty title={sheet ? "Select An Object" : "Data Object Unavailable"}>{sheet ? "Select a row to edit the shared object values." : "Reopen the asset to reload its data."}</DataEmpty> : <>
          {sheet ? <p className="truncate text-xs font-medium">{indexed?.header.name ?? target?.ref.label}{target?.dirty ? " *" : ""}</p> : null}
          <PropertyGrid rows={[{
            id: `${formId}-structure`, kind: "asset", label: "Structure", value: asset.structureGuid,
            displayLabel: structureName, displayType: "Structure", placeholder: "Choose Structure",
            disabled: readOnly || Boolean(sheet), onPick: () => setStructurePicker(true), onChange: () => undefined,
          }]} />
          {sheet && asset.structureGuid !== sheet.structureGuid ? <Alert variant="destructive"><AlertTitle>Structure Mismatch</AlertTitle><AlertDescription>This object uses a different Structure. Open it to change its Structure, or remove its membership from this sheet.</AlertDescription></Alert> : null}
          {schemaChanged ? <Alert><AlertTitle>Structure Changed</AlertTitle><AlertDescription>{needsStructuralApply ? "Review the field changes before editing this object." : "Review the changed types, or edit or reset their values to repair them."}<Button size="sm" variant="outline" className={TOUCH_ACTION} disabled={readOnly} onClick={() => setReview(true)}>Review Changes</Button></AlertDescription></Alert> : null}
          {recursive ? <Alert variant="destructive"><AlertTitle>Recursive Structure</AlertTitle><AlertDescription>Remove the circular Structure reference before editing these values.</AlertDescription></Alert> : null}
          {visibleIssues.length > 0 ? <Alert variant={visibleIssues.some((issue) => issue.severity === "error") ? "destructive" : "default"}><AlertTitle>Validation</AlertTitle><AlertDescription><ul className="list-disc pl-4">{visibleIssues.map((issue, index) => <li key={index}>{issue.path ? `${humanizePropertyLabel(issue.path)}: ` : ""}{issue.message}</li>)}</ul></AlertDescription></Alert> : null}
          {schema ? <PropertyGrid rows={rows} /> : asset.structureGuid ? <DataEmpty title="Structure Missing">Restore the referenced Structure or choose another one. Existing values are preserved.</DataEmpty> : <DataEmpty title="Choose A Structure">Data Objects are standalone assets. Choose a Structure to define this object's fields.</DataEmpty>}
          {sheet && target?.dirty ? <Button size="sm" variant="outline" className={cn("self-start", TOUCH_ACTION)} onClick={() => void documents.saveAll().then((saved) => { if (!saved) setError("The changes could not be saved. Resolve the editor's save diagnostics and retry."); }).catch((reason: unknown) => setError(String(reason)))}>Save All</Button> : null}
        </>}
      </div>
      <AssetPicker open={structurePicker} onOpenChange={setStructurePicker} assets={catalog.types.structures.map((entry) => ({ ...entry, type: "Structure" }))} allowedTypes={["Structure"]} title="Choose Structure" allowNone={false} onPick={(guid) => {
        setStructurePicker(false);
        if (!guid || !asset || guid === asset.structureGuid) return;
        const chosen = catalog.schemas.structs[guid];
        if (!chosen) return;
        if (Object.keys(asset.values).length > 0) setPendingStructure(guid);
        else commit(createDataObjectForStructure(guid, chosen.fields, catalog.schemas));
      }} />
      <AssetPicker open={Boolean(assetPicker)} onOpenChange={(open) => { if (!open) setAssetPicker(null); }} assets={catalog.pickerAssets} allowedTypes={assetPicker?.allowedTypes} title="Choose Asset" allowNone onPick={(guid) => {
        const row = pickerRows.find((entry) => entry.id === assetPicker?.rowId);
        if (row?.kind === "asset") row.onChange(guid ?? "");
        setAssetPicker(null);
      }} />
      <ClassPicker open={Boolean(classPicker)} onOpenChange={(open) => { if (!open) setClassPicker(null); }} classes={classPicker ? subclassClassEntries(classPicker.base, catalog.assets) : []} title="Choose Class" allowNone onPick={(classId) => {
        const row = pickerRows.find((entry) => entry.id === classPicker?.rowId);
        if (row?.kind === "asset") row.onChange(classId ?? "");
        setClassPicker(null);
      }} />
      <AlertDialog open={pendingStructure !== null} onOpenChange={(open) => { if (!open) setPendingStructure(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Change Structure</AlertDialogTitle><AlertDialogDescription>Replace this object's values with the new Structure defaults. Undo restores the current values.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => {
          const chosen = pendingStructure ? catalog.schemas.structs[pendingStructure] : undefined;
          if (pendingStructure && chosen) commit(createDataObjectForStructure(pendingStructure, chosen.fields, catalog.schemas));
          setPendingStructure(null);
        }}>Change Structure</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={review} onOpenChange={setReview}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Update Object Fields</AlertDialogTitle><AlertDialogDescription>Apply the current Structure to this object. Removed fields remain stored for recovery. Undo restores the previous snapshot.</AlertDialogDescription></AlertDialogHeader>
          <ul className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 text-sm">{migration?.changes.map((change, index) => <li key={index} className="py-1">{humanizePropertyLabel(change.kind)}: {change.previousPath ? `${change.previousPath} → ` : ""}{change.path}</li>)}</ul>
          {migrationBlocked ? <Alert variant="destructive"><AlertTitle>Resolve Schema Conflicts</AlertTitle><AlertDescription>{migration?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ")}</AlertDescription></Alert> : null}
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={migrationBlocked} onClick={() => { if (migration && !migrationBlocked) commit(migration.asset); setReview(false); }}>Apply Changes</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <NamePromptDialog open={renaming} onOpenChange={setRenaming} title="Rename Data Object" label="Name" confirmLabel="Rename" initialValue={indexed?.header.name ?? ""} validate={(name) => /[\\/]/.test(name) ? "Use a name without path separators." : null} onSubmit={(name) => {
        if (!indexed || !documents.assetRegistry || name === indexed.header.name) return;
        if (documents.sourceControl.refuseIfTheirs(indexed.path)) { setError("This object is locked by another user."); return; }
        const registry = documents.assetRegistry;
        void registry.renameAsset(indexed.header.guid, name).then(async (renamed) => {
          documents.repathDocument("data-object", indexed.path, renamed.path);
          documents.noteAssetsCreated();
          await documents.sourceControl.transferLock(indexed.path, renamed.path);
        }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
      }} />
    </PanelFrame>
  );
}
