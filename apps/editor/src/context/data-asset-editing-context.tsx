import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildDataTreeIndex, createDataTreeEntry, isDataTreeAsset, type DataTreeAsset, type DataTreeEntry, type DataTreeIndex } from "@babylonslate/core";
import { createDataEntryForDefinition, reconcileDataEntry, validateDataDefinition, validateDataEntry, type DataValidationIssue } from "@babylonslate/scripting";
import {
  useDocumentActions,
  useRegistryState,
  useSourceControl,
  useOpenDocument,
} from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import { useDataCatalog } from "../lib/use-data-catalog";
import { duplicateBaseName } from "../lib/scene-actor-names";

type Placement = "before" | "into" | "after";
type Migration = ReturnType<typeof reconcileDataEntry>;
const CONFLICT_CODES = new Set(["rename-conflict", "ambiguous-schema", "invalid-schema", "recursive-schema"]);
function blocked(migration: Migration): boolean { return migration.issues.some((issue) => CONFLICT_CODES.has(issue.code)); }
function needsApply(migration: Migration): boolean { return migration.changes.some((change) => change.kind === "added" || change.kind === "renamed"); }
function preserveAuthoredFields(previous: unknown, next: unknown, depth = 0): unknown {
  if (depth > 64 || !previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) || Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  return Object.fromEntries(Object.entries({ ...before, ...next }).map(([key, value]) => [key, Object.prototype.hasOwnProperty.call(next, key) ? preserveAuthoredFields(before[key], value, depth + 1) : value]));
}
function uniqueName(index: DataTreeIndex, parentId: string | null, base: string): string {
  const names = new Set((index.childrenByParentId.get(parentId) ?? []).map((entry) => entry.name.toLowerCase()));
  let name = base;
  let suffix = 2;
  while (names.has(name.toLowerCase())) name = `${base} ${suffix++}`;
  return name;
}
function descendantIds(index: DataTreeIndex, id: string): Set<string> {
  const path = index.pathById.get(id);
  if (path === undefined) throw new Error("This entry is no longer available.");
  return new Set(index.orderedEntries.filter((entry) => entry.id === id || index.pathById.get(entry.id)!.startsWith(`${path}/`)).map((entry) => entry.id));
}

function useDataTreeState() {
  const { documentId } = useDocumentWorkspace();
  const documents = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const { sourceControl } = useSourceControl();
  const catalog = useDataCatalog();
  const { assets, byGuid, types, schemas } = catalog;
  const definitions = useMemo(() => new Map(types.dataDefinitions.map((entry) => [entry.guid, entry])), [types]);
  const doc = useOpenDocument(documentId);
  const tree = isDataTreeAsset(doc?.content) ? doc.content : null;
  const hierarchy = useMemo(() => tree ? buildDataTreeIndex(tree) : null, [tree]);
  const index = hierarchy?.index ?? null;
  const indexed = assets.find((asset) => asset.path === doc?.ref.path);
  const assetReadOnly = Boolean(indexed && assetRegistry?.getRoot(indexed.rootId)?.readOnly) || Boolean(doc && sourceControl.isDocumentReadOnly(doc.ref.path));
  const readOnly = assetReadOnly || !index;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const schemaSignature = useMemo(() => JSON.stringify(schemas), [schemas]);
  const latest = useRef({ schemaSignature, assetReadOnly });
  latest.current = { schemaSignature, assetReadOnly };
  const definitionIssues = useMemo(() => {
    const cache = new Map<string, DataValidationIssue[]>();
    return (guid: string) => {
      let result = cache.get(guid);
      if (!result) {
        const definition = definitions.get(guid);
        result = definition ? validateDataDefinition({ kind: "dataDefinition", fields: definition.fields.map((field) => ({ ...field, id: field.id ?? `legacy:${field.name}` })) }, schemas, guid) : [{ code: "missing-definition", path: "", severity: "error", message: "Choose an existing Data Definition." }];
        cache.set(guid, result);
      }
      return result;
    };
  }, [definitions, schemas]);
  // An inherited Definition may change without replacing a descendant entry.
  const inspectEntry = useMemo(() => {
    const cache = new WeakMap<DataTreeEntry, Map<string | null, { migration: Migration | null; issues: DataValidationIssue[] }>>();
    return (entry: DataTreeEntry, guid: string | null) => {
      let byDefinition = cache.get(entry);
      if (!byDefinition) { byDefinition = new Map(); cache.set(entry, byDefinition); }
      let result = byDefinition.get(guid);
      if (!result) {
        const definition = guid ? definitions.get(guid) : undefined;
        result = {
          migration: definition ? reconcileDataEntry(entry, guid, definition.fields, schemas) : null,
          issues: [...(guid ? definitionIssues(guid).map((issue) => ({ ...issue, entryId: entry.id })) : []), ...validateDataEntry(entry, guid, schemas, { assetTypeForGuid: (assetGuid) => byGuid.get(assetGuid)?.header.type })],
        };
        byDefinition.set(guid, result);
      }
      return result;
    };
  }, [definitions, schemas, definitionIssues, byGuid]);
  const entryInfo = useMemo(() => new Map(index?.orderedEntries.map((entry) => [entry.id, inspectEntry(entry, index.effectiveDefinitionById.get(entry.id) ?? null)]) ?? []), [index, inspectEntry]);
  const validation = useMemo(() => !index ? hierarchy?.issues ?? [] : [
    ...(tree?.defaultDefinitionGuid ? definitionIssues(tree.defaultDefinitionGuid) : []),
    ...index.orderedEntries.flatMap((entry) => entryInfo.get(entry.id)?.issues ?? []),
  ], [index, hierarchy, tree?.defaultDefinitionGuid, definitionIssues, entryInfo]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [focusRequest, setFocusRequest] = useState<{ entryId: string; path: string; sequence: number } | null>(null);
  const selectedEntryId = selectedId && index?.byId.has(selectedId) ? selectedId : null;
  const browseBranchId = branchId && index?.byId.has(branchId) ? branchId : null;
  const revealAncestors = (id: string, currentIndex = index) => {
    if (!currentIndex) return;
    const ancestors = new Set<string>();
    let entry = currentIndex.byId.get(id);
    while (entry?.parentId) { ancestors.add(entry.parentId); entry = currentIndex.byId.get(entry.parentId); }
    setCollapsedIds((previous) => new Set([...previous].filter((entryId) => !ancestors.has(entryId))));
  };
  const selectEntry = (id: string | null, navigate = true) => {
    setSelectedId(id);
    if (!id || !index) { if (navigate) setBranchId(null); return; }
    revealAncestors(id);
    const entry = index.byId.get(id);
    if (navigate && entry) setBranchId((index.childrenByParentId.get(id)?.length ?? 0) > 0 ? id : entry.parentId);
  };
  const browse = (id: string | null) => { setBranchId(id); setSelectedId(id); if (id) revealAncestors(id); };
  const focusField = (entryId: string, path: string) => {
    const entry = index?.byId.get(entryId);
    if (!entry) return;
    setSelectedId(entryId); setBranchId(entry.parentId); revealAncestors(entryId);
    for (const panel of ["data-tree-hierarchy", "data-tree-entries", "data-tree-values"]) if (!documents.isDockWindowOpen(panel)) documents.toggleDockWindow(panel);
    documents.activateDockPanel("data-tree-values");
    setFocusRequest((previous) => ({ entryId, path, sequence: (previous?.sequence ?? 0) + 1 }));
  };
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const changeTree = (update: (current: DataTreeAsset, currentIndex: DataTreeIndex) => DataTreeAsset, mergeKey?: string) => {
    const ownerRef = doc?.ref;
    const operation = mutationQueue.current.then(async () => {
      const currentDocument = documents.getOpenDocuments().find((entry) => entry.id === documentId);
      if (!mounted.current || currentDocument?.ref !== ownerRef) throw new Error("The Data Tree was closed or replaced. Reopen it before editing.");
      if (latest.current.assetReadOnly) throw new Error("This Data Tree is read-only or locked.");
      if (schemaSignature !== latest.current.schemaSignature) throw new Error("A Data Definition changed while this edit was waiting. Review its fields and retry.");
      const current = currentDocument?.content;
      if (!isDataTreeAsset(current)) throw new Error("The Data Tree is no longer available.");
      const before = buildDataTreeIndex(current);
      if (!before.index) throw new Error(before.issues[0]?.message ?? "Resolve the invalid hierarchy before editing.");
      const next = update(current, before.index);
      const checked = next === current ? before : buildDataTreeIndex(next);
      if (!checked.index) throw new Error(checked.issues[0]?.message ?? "The hierarchy change is invalid.");
      if (next !== current && !await documents.applyAssetDocumentChange(documentId, { ...next }, mergeKey)) throw new Error("The Data Tree could not be edited. Check whether it is read-only or locked.");
      return checked.index;
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  };
  const addEntry = async (parentId: string | null) => {
    let id = "";
    const updatedIndex = await changeTree((current, currentIndex) => {
      if (parentId && !currentIndex.byId.has(parentId)) throw new Error("The parent entry is no longer available.");
      const guid = parentId ? currentIndex.effectiveDefinitionById.get(parentId) ?? null : current.defaultDefinitionGuid;
      const definition = guid ? definitions.get(guid) : undefined;
      if (guid && !definition) throw new Error("Restore or change the inherited Data Definition before adding an entry.");
      const name = uniqueName(currentIndex, parentId, "New Entry");
      const entry = definition ? createDataEntryForDefinition(definition.guid, definition.fields, schemas, name, undefined, parentId) : createDataTreeEntry({ name, parentId });
      delete entry.definitionGuid;
      id = entry.id;
      return { ...current, entries: [...current.entries, entry] };
    });
    setSelectedId(id); setBranchId(parentId); revealAncestors(id, updatedIndex);
    return id;
  };
  const renameEntry = (id: string, name: string) => changeTree((current, currentIndex) => {
    if (!currentIndex.byId.has(id)) throw new Error("This entry is no longer available.");
    if (currentIndex.byId.get(id)!.name === name.trim()) return current;
    return { ...current, entries: current.entries.map((entry) => entry.id === id ? { ...entry, name: name.trim() } : entry) };
  });
  const moveEntry = async (id: string, targetId: string | null, placement: Placement = "into") => {
    const updatedIndex = await changeTree((current, currentIndex) => {
      const entry = currentIndex.byId.get(id);
      const target = targetId ? currentIndex.byId.get(targetId) : undefined;
      if (!entry || (targetId && !target)) throw new Error("The source or destination entry is no longer available.");
      if (targetId === id) throw new Error("An entry cannot be moved into itself.");
      const parentId = placement === "into" ? targetId : target?.parentId ?? null;
      const entries = current.entries.filter((item) => item.id !== id);
      const moved = { ...entry, parentId };
      if (placement === "into" || !target) entries.push(moved);
      else entries.splice(entries.findIndex((item) => item.id === target.id) + (placement === "after" ? 1 : 0), 0, moved);
      if (parentId === entry.parentId && entries.every((item, position) => item.id === current.entries[position]?.id)) return current;
      return { ...current, entries };
    });
    setSelectedId(id); setBranchId(updatedIndex.byId.get(id)?.parentId ?? null); revealAncestors(id, updatedIndex);
  };
  const duplicateEntry = async (id: string) => {
    let createdId = "";
    const updatedIndex = await changeTree((current, currentIndex) => {
      const source = currentIndex.byId.get(id);
      if (!source) throw new Error("This entry is no longer available.");
      const ids = descendantIds(currentIndex, id);
      const copies = currentIndex.orderedEntries.filter((entry) => ids.has(entry.id)).map((entry) => ({ source: entry, copy: createDataTreeEntry({ ...entry, id: undefined }) }));
      const remap = new Map(copies.map(({ source: original, copy }) => [original.id, copy.id]));
      for (const { source: original, copy } of copies) {
        if (original.id === id) { copy.name = uniqueName(currentIndex, source.parentId, duplicateBaseName(source.name)); createdId = copy.id; }
        else copy.parentId = remap.get(original.parentId!)!;
      }
      const entries = [...current.entries];
      entries.splice(entries.findIndex((entry) => entry.id === id) + 1, 0, ...copies.map(({ copy }) => copy));
      return { ...current, entries };
    });
    setSelectedId(createdId); setBranchId(updatedIndex.byId.get(createdId)?.parentId ?? null); revealAncestors(createdId, updatedIndex);
  };
  const removeEntry = async (id: string) => {
    let parentId: string | null = null;
    await changeTree((current, currentIndex) => {
      parentId = currentIndex.byId.get(id)?.parentId ?? null;
      const removed = descendantIds(currentIndex, id);
      return { ...current, entries: current.entries.filter((entry) => !removed.has(entry.id)) };
    });
    setSelectedId(parentId); setBranchId(parentId);
  };
  const setDefaultDefinition = (guid: string | null) => changeTree((current) => current.defaultDefinitionGuid === guid ? current : { ...current, defaultDefinitionGuid: guid });
  const setEntryDefinition = (id: string, guid: string | null | undefined) => changeTree((current, currentIndex) => {
    if (!currentIndex.byId.has(id)) throw new Error("This entry is no longer available.");
    if (currentIndex.byId.get(id)!.definitionGuid === guid) return current;
    return { ...current, entries: current.entries.map((entry) => {
    if (entry.id !== id) return entry;
    const next = { ...entry };
    if (guid === undefined) delete next.definitionGuid; else next.definitionGuid = guid;
    return next;
  }) };
  });
  const updateValues = (updates: readonly { entryId: string; values: Record<string, unknown>; expectedDefinitionGuid?: string }[], options: { validate?: boolean; mergeKey?: string } = {}) => changeTree((current, currentIndex) => {
    const changed = new Map<string, DataTreeEntry>();
    for (const update of updates) {
      const entry = changed.get(update.entryId) ?? currentIndex.byId.get(update.entryId);
      if (!entry) throw new Error("This entry is no longer available.");
      const guid = currentIndex.effectiveDefinitionById.get(entry.id) ?? null;
      if (update.expectedDefinitionGuid !== undefined && guid !== update.expectedDefinitionGuid) throw new Error("The entry's Data Definition changed. Review its fields before editing.");
      const definition = guid ? definitions.get(guid) : undefined;
      if (!definition) throw new Error("Choose an available Data Definition before editing values.");
      const migration = reconcileDataEntry(entry, guid, definition.fields, schemas);
      if (needsApply(migration) || blocked(migration)) throw new Error(`${entry.name}: Apply the Definition changes before editing values.`);
      const values = { ...entry.values };
      for (const [key, value] of Object.entries(update.values)) {
        if (!definition.fields.some((field) => field.name === key)) throw new Error(`The field '${key}' is not in this entry's Definition.`);
        values[key] = preserveAuthoredFields(values[key], value);
      }
      const next = reconcileDataEntry({ ...entry, values }, guid, definition.fields, schemas, { initializeMissingFields: false }).entry;
      if (options.validate) {
        const issue = validateDataEntry(next, guid, schemas, { assetTypeForGuid: (assetGuid) => byGuid.get(assetGuid)?.header.type }).find((item) => item.severity === "error");
        if (issue) throw new Error(`${currentIndex.pathById.get(entry.id)}${issue.path ? ` · ${issue.path}` : ""}: ${issue.message}`);
      }
      changed.set(entry.id, next);
    }
    return { ...current, entries: current.entries.map((entry) => changed.get(entry.id) ?? entry) };
  }, options.mergeKey);
  const applyDefinition = (id: string) => changeTree((current, currentIndex) => {
    const entry = currentIndex.byId.get(id);
    const guid = currentIndex.effectiveDefinitionById.get(id) ?? null;
    const definition = guid ? definitions.get(guid) : undefined;
    if (!entry || !definition) throw new Error("This entry or its Definition is no longer available.");
    const migration = reconcileDataEntry(entry, guid, definition.fields, schemas);
    if (blocked(migration)) throw new Error(migration.issues.find((issue) => CONFLICT_CODES.has(issue.code))?.message ?? "Resolve Definition conflicts first.");
    if (JSON.stringify(migration.entry) === JSON.stringify(entry)) return current;
    return { ...current, entries: current.entries.map((item) => item.id === id ? migration.entry : item) };
  });
  return { documentId, documents, doc, tree, index, readOnly, catalog, definitions, entryInfo, validation, selectedEntryId, browseBranchId, collapsedIds, setCollapsedIds, selectEntry, browse, focusRequest, focusField, addEntry, renameEntry, moveEntry, duplicateEntry, removeEntry, setDefaultDefinition, setEntryDefinition, updateValues, applyDefinition };
}

const DataAssetEditingContext = createContext<ReturnType<typeof useDataTreeState> | null>(null);
/** Tree-owned values and hierarchy share one document history; selection stays local. */
export function DataAssetEditingProvider({ children }: { children: ReactNode }) {
  const value = useDataTreeState();
  return <DataAssetEditingContext.Provider value={value}>{children}</DataAssetEditingContext.Provider>;
}
// eslint-disable-next-line react-refresh/only-export-components
export function useDataAssetEditing() {
  const context = useContext(DataAssetEditingContext);
  if (!context) throw new Error("Data Trees require their document provider");
  return context;
}
