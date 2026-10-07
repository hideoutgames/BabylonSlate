import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { buildDataTreeIndex, type DataTreeEntry } from "@babylonslate/core";
import { createDataEntryForDefinition, reconcileDataEntry, type StructField } from "@babylonslate/scripting";
import { normalizeTag, type TagContainer } from "@babylonslate/core";
import { AssetPicker, ContextMenuOverlay, NamePromptDialog, NestedMenu, NumberField, PanelFrame, PropertySectionTitle, SearchInput, SearchDropdown, TagPicker, TreeView, TypeVisualIcon, WindowedList, humanizePropertyLabel, isCoarsePointerEnvironment, resolveTypeVisual, tagDisplayName, useContextMenu, useTags, type NestedMenuItem, type TreeViewNode } from "@babylonslate/editor-kit";
import { ArrowUpIcon, BetweenHorizontalStartIcon, ChevronDownIcon, DatabaseIcon, ListPlusIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@babylonslate/ui/components/alert-dialog";
import { cn } from "@babylonslate/ui/lib/utils";
import { useDataAssetEditing } from "../context/data-asset-editing-context";
import { DataValueEditor } from "../components/data-value-editor";
import { DataTreeEntryField, DataTreeEntryPicker } from "../components/data-tree-entry-picker";
import { DiagnosticResultRow } from "../components/diagnostic-result-row";
import { IconActionButton } from "../components/icon-action-button";

const TOUCH_ACTION = "pointer-coarse:min-h-11";
const TOUCH_ICON_ACTION = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const DEFINITION_VISUAL = resolveTypeVisual({ assetType: "DataDefinition" });
const GRID_CONTROL = "h-6 min-h-6 w-full rounded-sm border-transparent bg-transparent px-1 text-xs shadow-none hover:border-input focus-visible:border-ring focus-visible:bg-control focus-visible:ring-1 dark:bg-transparent pointer-coarse:h-11";

function DefinitionButton({ label, name, assigned, disabled, onClick, testId }: {
  label: string; name: string; assigned: boolean; disabled: boolean; onClick: () => void; testId?: string;
}) {
  return <Button variant="outline" size="sm" className={cn("min-w-0 flex-1 justify-start", TOUCH_ACTION)} aria-label={label} title={name} data-testid={testId} disabled={disabled} onClick={onClick}>
    <TypeVisualIcon visual={DEFINITION_VISUAL} className={assigned ? undefined : "opacity-50"} />
    <span className={cn("min-w-0 flex-1 truncate text-left", !assigned && "text-muted-foreground")}>{name}</span>
    <ChevronDownIcon data-icon="inline-end" />
  </Button>;
}
type TreeState = ReturnType<typeof useDataAssetEditing>;
type Migration = ReturnType<typeof reconcileDataEntry> | null | undefined;
function migrationBlocked(migration: Migration): boolean {
  return Boolean(migration?.issues.some((issue) => ["rename-conflict", "ambiguous-schema", "invalid-schema", "recursive-schema"].includes(issue.code)));
}
function requiresApply(migration: Migration): boolean {
  return Boolean(migration?.changes.some((change) => change.kind === "added" || change.kind === "renamed"));
}
function pickerEntries(index: TreeState["index"]) {
  return index?.orderedEntries.map((entry) => ({ id: entry.id, path: index.pathById.get(entry.id)!, effectiveDefinitionGuid: index.effectiveDefinitionById.get(entry.id) ?? null })) ?? [];
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
function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else if (quoted || value === "") quoted = !quoted;
      else value += character;
    } else if (!quoted && (character === "\t" || character === "\n" || character === "\r")) {
      row.push(value); value = "";
      if (character !== "\t") {
        rows.push(row); row = [];
        if (character === "\r" && text[index + 1] === "\n") index++;
      }
    } else value += character;
  }
  if (quoted) throw new Error("The pasted table has an unclosed quoted value.");
  if (value || row.length || !rows.length) { row.push(value); rows.push(row); }
  if (rows.some((entry) => entry.length !== rows[0]!.length)) throw new Error("Paste a rectangular table with the same number of columns in every row.");
  return rows;
}
function parseCell(text: string, field: StructField, enums: Record<string, string[]>): unknown {
  const label = humanizePropertyLabel(field.name);
  if (field.container === "array" || field.container === "map") throw new Error(`${label}: Edit collection values in Values.`);
  if (field.typeId === "string") return text;
  if (field.typeId === "float" || field.typeId === "int") {
    const value = Number(text.trim());
    if (!text.trim() || !Number.isFinite(value) || (field.typeId === "int" && !Number.isSafeInteger(value))) throw new Error(`${label}: Enter a valid ${field.typeId === "int" ? "integer" : "number"}.`);
    return value;
  }
  if (field.typeId === "bool") {
    const value = text.trim().toLocaleLowerCase();
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw new Error(`${label}: Enter True or False.`);
  }
  if (field.typeId === "enum") {
    const value = (enums[field.typeClassId ?? ""] ?? []).find((entry) => entry === text.trim() || humanizePropertyLabel(entry) === text.trim());
    if (value !== undefined) return value;
    throw new Error(`${label}: Choose an existing Enum value.`);
  }
  throw new Error(`${label}: Edit this field in Values.`);
}
function tsvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function DataEntryCell({ field, value, label, editable, enums, onChange, preview }: {
  field: StructField; value: unknown; label: string; editable: boolean;
  enums: Record<string, string[]>; onChange: (value: unknown) => void; preview: string;
}) {
  const { entries: tags } = useTags();
  const collection = field.container === "array" || field.container === "map";
  const tagContainer = field.typeId === "struct" && field.typeClassId === "engine:TagContainer";
  const tagValue: TagContainer = value && typeof value === "object" && Array.isArray((value as TagContainer).Tags) ? value as TagContainer : { Tags: [] };
  if (!collection && field.typeId === "tag") {
    const tag = normalizeTag(Number(value ?? 0));
    if (!editable) return <span title={tagDisplayName(tags, tag)} className="block truncate px-1">{tagDisplayName(tags, tag)}</span>;
    return <TagPicker mode="single" value={tag} onChange={onChange} aria-label={label} className={cn(GRID_CONTROL, "justify-start gap-1 font-normal")} />;
  }
  if (!collection && tagContainer) {
    const names = tagValue.Tags.map((tag) => tagDisplayName(tags, tag)).join(", ") || "No Tags";
    if (!editable) return <span title={names} className="block truncate px-1">{names}</span>;
    return <TagPicker mode="multiple" value={tagValue} onChange={onChange} aria-label={label} className={cn(GRID_CONTROL, "justify-start gap-1 font-normal")} />;
  }
  if (!editable || collection) return <span title={preview} className="block truncate px-1 text-muted-foreground">{preview}</span>;
  if (field.typeId === "float" || field.typeId === "int") return <NumberField aria-label={label} className={cn(GRID_CONTROL, "tabular-nums")} value={typeof value === "number" ? value : 0} onChange={(next) => onChange(field.typeId === "int" ? Math.trunc(next) : next)} />;
  if (field.typeId === "bool") return <span className="flex px-1"><Checkbox aria-label={label} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} /></span>;
  if (field.typeId === "string") return <Input key={String(value)} aria-label={label} className={GRID_CONTROL} defaultValue={typeof value === "string" ? value : ""} onBlur={(event) => {
    if (event.target.value !== value) onChange(event.target.value);
  }} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.currentTarget.value = typeof value === "string" ? value : ""; event.currentTarget.blur(); }
    if (event.key === "Enter") event.currentTarget.blur();
  }} />;
  if (field.typeId === "enum") return <SearchDropdown title={label} items={(enums[field.typeClassId ?? ""] ?? []).map((name) => ({ id: name, label: humanizePropertyLabel(name) }))} onSelect={onChange}>
    <Button size="xs" variant="ghost" aria-label={label} className="w-full justify-start gap-1 px-1 font-normal pointer-coarse:h-11"><span className="min-w-0 flex-1 truncate text-left">{humanizePropertyLabel(String(value ?? "Choose"))}</span><ChevronDownIcon className="size-3 text-muted-foreground" /></Button>
  </SearchDropdown>;
  return <span title={preview} className="block truncate px-1 text-muted-foreground">{preview}</span>;
}

function useTreeActions(state: TreeState) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const pending = useRef(0);
  const siblingPositions = useMemo(() => {
    const positions = new Map<string, number>();
    for (const siblings of state.index?.childrenByParentId.values() ?? []) siblings.forEach((entry, position) => positions.set(entry.id, position));
    return positions;
  }, [state.index]);
  const run = async (action: () => Promise<unknown>) => {
    pending.current++; setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current--; setBusy(pending.current > 0); }
  };
  const menuItems = (id: string): NestedMenuItem[] => {
    const entry = state.index?.byId.get(id);
    const siblings = state.index?.childrenByParentId.get(entry?.parentId ?? null) ?? [];
    const position = siblingPositions.get(id) ?? -1;
    const disabled = state.readOnly || busy || !entry;
    return [
      { id: "add-child", label: "Add Child", disabled, onSelect: () => void run(() => state.addEntry(id)) },
      { id: "rename-entry", label: "Rename", disabled, onSelect: () => setRenameId(id) },
      { id: "move-entry", label: "Move To", disabled, onSelect: () => setMoveId(id) },
      { id: "move-up", label: "Move Up", disabled: disabled || position <= 0, onSelect: () => void run(() => state.moveEntry(id, siblings[position - 1]!.id, "before")) },
      { id: "move-down", label: "Move Down", disabled: disabled || position >= siblings.length - 1, onSelect: () => void run(() => state.moveEntry(id, siblings[position + 1]!.id, "after")) },
      { type: "separator", id: "entry-separator" },
      { id: "duplicate-entry", label: "Duplicate Subtree", disabled, onSelect: () => void run(() => state.duplicateEntry(id)) },
      { id: "remove-entry", label: "Remove Subtree", disabled, variant: "destructive", onSelect: () => setRemoveId(id) },
    ];
  };
  const movePath = moveId ? state.index?.pathById.get(moveId) : undefined;
  const destinations = useMemo(() => moveId ? pickerEntries(state.index).filter((entry) => entry.id !== moveId && (!movePath || !entry.path.startsWith(`${movePath}/`))) : [], [state.index, moveId, movePath]);
  const removedPath = removeId ? state.index?.pathById.get(removeId) : undefined;
  const removeCount = removedPath ? state.index!.orderedEntries.filter((entry) => entry.id === removeId || state.index!.pathById.get(entry.id)!.startsWith(`${removedPath}/`)).length : 0;
  const dialogs = <>
    <NamePromptDialog open={renameId !== null} onOpenChange={(open) => { if (!open) setRenameId(null); }} title="Rename Entry" label="Name" confirmLabel="Rename" initialValue={state.index?.byId.get(renameId ?? "")?.name ?? ""} validate={(name) => {
      if (!state.tree || !renameId) return "This entry is no longer available.";
      return buildDataTreeIndex({ ...state.tree, entries: state.tree.entries.map((entry) => entry.id === renameId ? { ...entry, name: name.trim() } : entry) }).issues[0]?.message ?? null;
    }} onSubmit={(name) => { if (renameId) void run(() => state.renameEntry(renameId, name)); }} />
    <DataTreeEntryPicker open={moveId !== null} onOpenChange={(open) => { if (!open) setMoveId(null); }} title="Move Entry To" entries={destinations} includeRoot testId="data-tree-move-picker" onPick={(path) => {
      if (moveId) void run(() => state.moveEntry(moveId, path ? state.index?.idByPath.get(path) ?? null : null));
      setMoveId(null);
    }} />
    <AlertDialog open={removeId !== null} onOpenChange={(open) => { if (!open) setRemoveId(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove Subtree</AlertDialogTitle><AlertDialogDescription>Remove {removedPath ?? "this entry"}{removeCount > 1 ? ` and ${removeCount - 1} descendant${removeCount === 2 ? "" : "s"}` : ""}? Undo restores these entries and their values.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (removeId) void run(() => state.removeEntry(removeId)); setRemoveId(null); }}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
  return { error, busy, run, menuItems, dialogs };
}

export function DataTreeHierarchyPanel(_props: IDockviewPanelProps) {
  void _props;
  const state = useDataAssetEditing();
  const { tree, index, catalog, readOnly, selectedEntryId, collapsedIds } = state;
  const actions = useTreeActions(state);
  const [query, setQuery] = useState("");
  const [definitionPicker, setDefinitionPicker] = useState(false);
  const context = useContextMenu({ items: [] });
  useEffect(() => { if (state.focusRequest) setQuery(""); }, [state.focusRequest]);
  const visible = useMemo(() => {
    if (!index) return [];
    const search = query.trim().toLocaleLowerCase();
    const included = new Set<string>();
    if (search) for (const entry of index.orderedEntries) {
      if (!index.pathById.get(entry.id)!.toLocaleLowerCase().includes(search)) continue;
      let current: DataTreeEntry | undefined = entry;
      while (current && !included.has(current.id)) { included.add(current.id); current = current.parentId ? index.byId.get(current.parentId) : undefined; }
    }
    let collapsedPath: string | null = null;
    return index.orderedEntries.filter((entry) => {
      const path = index.pathById.get(entry.id)!;
      if (search) return included.has(entry.id);
      if (collapsedPath && path.startsWith(`${collapsedPath}/`)) return false;
      collapsedPath = collapsedIds.has(entry.id) ? path : null;
      return true;
    });
  }, [index, query, collapsedIds]);
  const nodes: TreeViewNode[] = visible.map((entry) => {
    const children = index!.childrenByParentId.get(entry.id)?.length ?? 0;
    return { id: entry.id, label: entry.name, depth: index!.pathById.get(entry.id)!.split("/").length - 1, hasChildren: children > 0, expanded: Boolean(query.trim()) || !collapsedIds.has(entry.id),
      icon: <BetweenHorizontalStartIcon className="size-3.5" />,
      preview: children ? <span className="text-xs tabular-nums text-muted-foreground">{children}</span> : undefined,
      trailing: <NestedMenu size="chrome" items={actions.menuItems(entry.id)} trigger={<Button variant="ghost" size="icon-xs" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11" aria-label={`Entry Menu For ${entry.name}`}><MoreHorizontalIcon className="size-3.5" /></Button>} />,
    };
  });
  if (!tree) return <PanelFrame><DataEmpty title="Data Tree Unavailable">Reopen the asset to reload its data.</DataEmpty></PanelFrame>;
  const definition = tree.defaultDefinitionGuid ? state.definitions.get(tree.defaultDefinitionGuid) : null;
  return <PanelFrame data-testid="data-tree-hierarchy-panel">
    <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-panel-header p-2">
      <div className="flex items-center gap-2"><span className="shrink-0 text-xs text-muted-foreground">Default Definition</span><DefinitionButton label="Tree Default Definition" testId="data-tree-default-definition" assigned={Boolean(definition)} name={definition?.name ?? (tree.defaultDefinitionGuid ? "Missing Definition" : "None")} disabled={readOnly || actions.busy} onClick={() => setDefinitionPicker(true)} /></div>
      <div className="flex items-center gap-1">
        <SearchInput value={query} onChange={setQuery} placeholder="Search Tree" aria-label="Search Tree" className="h-7 min-h-7 min-w-0 flex-1 pointer-coarse:min-h-11" />
        <IconActionButton label="Add Root" variant="ghost" className={TOUCH_ICON_ACTION} disabled={readOnly || actions.busy} onClick={() => void actions.run(() => state.addEntry(null))}><PlusIcon /></IconActionButton>
        <IconActionButton label="Add Child" variant="ghost" className={TOUCH_ICON_ACTION} disabled={readOnly || actions.busy || !selectedEntryId} onClick={() => { if (selectedEntryId) void actions.run(() => state.addEntry(selectedEntryId)); }}><ListPlusIcon /></IconActionButton>
      </div>
    </div>
    <OperationError message={actions.error} />
    <div className="px-1 pt-1"><Button variant="ghost" size="sm" className={cn("h-7 w-full justify-start gap-1 rounded-sm px-1 text-[13px] font-normal", TOUCH_ACTION, !state.browseBranchId && !selectedEntryId ? "bg-accent font-medium" : "hover:bg-accent/50")} onClick={() => state.browse(null)}><span className="flex size-5 items-center justify-center text-muted-foreground"><DatabaseIcon className="size-3.5" /></span>Tree Root<span className="ml-auto pr-1 text-xs tabular-nums text-muted-foreground">{tree.entries.length}</span></Button></div>
    {!index ? <DataEmpty title="Invalid Hierarchy">Resolve the issues in Validation before editing this tree. Stored entries are preserved.</DataEmpty> : <TreeView nodes={nodes} selectedId={selectedEntryId} data-testid="data-tree-hierarchy" aria-label="Data Tree" rowHeight={isCoarsePointerEnvironment() ? 44 : 28} emptyLabel={tree.entries.length ? "No Matching Entries" : "No Entries"} onSelect={(id) => state.selectEntry(id)} onToggleExpanded={(id) => state.setCollapsedIds((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onActivate={(id) => state.browse(id)} onReparent={readOnly ? undefined : (id, targetId, placement) => void actions.run(() => state.moveEntry(id, targetId, placement))} onContextMenu={(id, x, y) => { state.selectEntry(id, false); context.openMenuAt(x, y, actions.menuItems(id)); }} />}
    <AssetPicker open={definitionPicker} onOpenChange={setDefinitionPicker} title="Choose Tree Default Definition" allowedTypes={["DataDefinition"]} assets={catalog.types.dataDefinitions.map((entry) => ({ ...entry, type: "DataDefinition" }))} allowNone onPick={(guid) => { setDefinitionPicker(false); void actions.run(() => state.setDefaultDefinition(guid)); }} />
    <ContextMenuOverlay menu={context.menu} onClose={context.closeMenu} />
    {actions.dialogs}
  </PanelFrame>;
}

export function DataTreeEntriesPanel(_props: IDockviewPanelProps) {
  void _props;
  const state = useDataAssetEditing();
  const { tree, index, catalog, readOnly, selectedEntryId, browseBranchId, focusRequest } = state;
  const actions = useTreeActions(state);
  const gridId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [definitionFilter, setDefinitionFilter] = useState("auto");
  const [descendants, setDescendants] = useState(false);
  const [sort, setSort] = useState<{ field: string; direction: 1 | -1 } | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const handledFocus = useRef<number | null>(null);
  const searchCache = useMemo(() => new WeakMap<DataTreeEntry, string>(), []);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(69);
  const hasTree = Boolean(tree);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => { const height = header.getBoundingClientRect().height; if (height > 0) setHeaderHeight(height); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(header);
    return () => observer?.disconnect();
  }, [hasTree]);
  const entries = useMemo(() => {
    if (!index) return [];
    if (!descendants) return index.childrenByParentId.get(browseBranchId) ?? [];
    const path = browseBranchId ? index.pathById.get(browseBranchId) : "";
    return index.orderedEntries.filter((entry) => !path || index.pathById.get(entry.id)!.startsWith(`${path}/`));
  }, [index, browseBranchId, descendants]);
  const definitionGuids = useMemo(() => [...new Set(entries.map((entry) => index!.effectiveDefinitionById.get(entry.id) ?? null))], [entries, index]);
  const guid = definitionFilter === "auto" ? definitionGuids.length === 1 ? definitionGuids[0] : undefined : definitionFilter === "none" ? null : definitionFilter;
  const definition = guid ? state.definitions.get(guid) : undefined;
  const visibleFields = useMemo(() => definition?.fields.filter((field) => !hiddenColumns.has(field.id ?? field.name)) ?? [], [definition, hiddenColumns]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const result = entries.filter((entry) => {
      if (definitionFilter !== "auto" && index?.effectiveDefinitionById.get(entry.id) !== guid) return false;
      if (filter !== "all" && !state.entryInfo.get(entry.id)?.issues.some((issue) => issue.severity === filter)) return false;
      if (!search || index?.pathById.get(entry.id)?.toLocaleLowerCase().includes(search)) return true;
      let text = searchCache.get(entry);
      if (text === undefined) { text = JSON.stringify(entry.values).toLocaleLowerCase(); searchCache.set(entry, text); }
      return text.includes(search);
    });
    if (sort) result.sort((a, b) => {
      const left = sort.field === "$name" ? descendants ? index?.pathById.get(a.id) : a.name : a.values[sort.field];
      const right = sort.field === "$name" ? descendants ? index?.pathById.get(b.id) : b.name : b.values[sort.field];
      return sort.direction * (typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true }));
    });
    return result;
  }, [entries, definitionFilter, index, guid, filter, state.entryInfo, query, sort, descendants, searchCache]);
  const selected = selectedEntryId ? index?.byId.get(selectedEntryId) : undefined;
  const selectedIndex = filtered.findIndex((entry) => entry.id === selectedEntryId);
  const rowHeight = isCoarsePointerEnvironment() ? 44 : 28;
  const gridColumns = `minmax(160px, 1.5fr) ${definition ? visibleFields.map(() => "minmax(120px, 1fr)").join(" ") : "minmax(130px, 1fr) minmax(60px, .4fr)"} minmax(105px, 1fr)`;
  useEffect(() => { setDefinitionFilter("auto"); setQuery(""); setFilter("all"); }, [browseBranchId]);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.sequence) return;
    handledFocus.current = focusRequest.sequence;
    setQuery(""); setFilter("all"); setDefinitionFilter("auto");
    const effective = index?.effectiveDefinitionById.get(focusRequest.entryId);
    if (effective && definitionGuids.length > 1) setDefinitionFilter(effective);
    const field = effective ? state.definitions.get(effective)?.fields.find((entry) => focusRequest.path === entry.name || focusRequest.path.startsWith(`${entry.name}.`)) : undefined;
    if (field) setHiddenColumns((previous) => { const next = new Set(previous); next.delete(field.id ?? field.name); return next; });
  }, [focusRequest, index, definitionGuids, state.definitions]);
  const editCell = (entryId: string, field: StructField, value: unknown) => {
    state.selectEntry(entryId, false);
    void actions.run(() => state.updateValues([{ entryId, values: { [field.name]: value }, expectedDefinitionGuid: definition?.guid }], { mergeKey: `data:${entryId}:${field.id ?? field.name}` }));
  };
  const pasteCells = (entryIndex: number, columnIndex: number, text: string) => void actions.run(async () => {
    if (!definition) throw new Error("Filter to one available Definition before pasting values.");
    const cells = parseTsv(text);
    if (entryIndex + cells.length > filtered.length || columnIndex + cells[0]!.length > visibleFields.length) throw new Error("The pasted table exceeds the visible entries or columns. Add entries or show more columns, then retry.");
    const targets = cells.map((values, offset) => ({ entryId: filtered[entryIndex + offset]!.id, expectedDefinitionGuid: definition.guid, values: Object.fromEntries(values.map((value, fieldIndex) => {
      const field = visibleFields[columnIndex + fieldIndex]!;
      return [field.name, parseCell(value, field, catalog.enumMembers)];
    })) }));
    await state.updateValues(targets, { validate: true });
    state.selectEntry(targets[0]!.entryId, false);
  });
  const sortColumn = (field: string) => setSort((previous) => ({ field, direction: previous?.field === field && previous.direction === 1 ? -1 : 1 }));
  if (!tree) return <PanelFrame><DataEmpty title="Data Tree Unavailable">Reopen the asset to reload its data.</DataEmpty></PanelFrame>;
  const entryOptions = pickerEntries(state.index);
  const branchPath = browseBranchId ? index?.pathById.get(browseBranchId) ?? "" : "";
  return <PanelFrame data-testid="data-tree-entries-panel">
    <div ref={headerRef} className="sticky top-0 z-20 flex flex-col gap-1.5 border-b border-border bg-panel-header p-2">
      <div className="flex items-center gap-1"><IconActionButton label="Parent" variant="ghost" className={TOUCH_ICON_ACTION} disabled={!browseBranchId} onClick={() => state.browse(index?.byId.get(browseBranchId ?? "")?.parentId ?? null)}><ArrowUpIcon /></IconActionButton><div className="min-w-0 flex-1"><DataTreeEntryField value={branchPath} onChange={(path) => state.browse(path ? index?.idByPath.get(path) ?? null : null)} entries={entryOptions} includeRoot hideLabel label="Browse Branch" testId="data-tree-browse-branch" /></div><span className="shrink-0 pl-1 text-xs tabular-nums text-muted-foreground">{filtered.length === entries.length ? filtered.length : `${filtered.length} / ${entries.length}`} {entries.length === 1 ? "Entry" : "Entries"}</span></div>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="outline" size="sm" className={TOUCH_ACTION} disabled={readOnly || actions.busy} onClick={() => void actions.run(async () => { await state.addEntry(browseBranchId); setQuery(""); setFilter("all"); setDefinitionFilter("auto"); })}><PlusIcon data-icon="inline-start" />New Entry</Button>
        <NestedMenu size="chrome" trigger={<Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={!selected}>Entry<ChevronDownIcon data-icon="inline-end" /></Button>} items={selected ? actions.menuItems(selected.id) : []} />
        <NestedMenu size="chrome" trigger={<Button variant="ghost" size="sm" className={TOUCH_ACTION}>View<ChevronDownIcon data-icon="inline-end" /></Button>} items={[
          { type: "checkbox", id: "descendants", label: "Include Descendants", checked: descendants, onCheckedChange: setDescendants },
          { type: "submenu", id: "filter", label: "Filter", items: [{ type: "radio-group", id: "filter-choice", value: filter, onValueChange: setFilter, items: [{ id: "all", value: "all", label: "All Entries" }, { id: "error", value: "error", label: "Errors" }, { id: "warning", value: "warning", label: "Warnings" }] }] },
          { type: "submenu", id: "columns", label: "Columns", disabled: !definition, items: (definition?.fields ?? []).map((field) => ({ type: "checkbox", id: field.id ?? field.name, label: humanizePropertyLabel(field.name), checked: !hiddenColumns.has(field.id ?? field.name), closeOnClick: false, onCheckedChange: (checked) => setHiddenColumns((previous) => { const next = new Set(previous); if (checked) next.delete(field.id ?? field.name); else next.add(field.id ?? field.name); return next; }) })) },
          { id: "clear-sort", label: "Clear Sort", disabled: !sort, onSelect: () => setSort(null) },
          { id: "copy-entry", label: "Copy Entry Values", disabled: !selected || !visibleFields.length || index?.effectiveDefinitionById.get(selected.id) !== definition?.guid, onSelect: () => void actions.run(async () => {
            if (!selected) return;
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is not available in this browser.");
            const migration = state.entryInfo.get(selected.id)?.migration;
            const values = migrationBlocked(migration) ? selected.values : migration?.entry.values ?? selected.values;
            await navigator.clipboard.writeText(visibleFields.map((field) => tsvCell(values[field.name])).join("\t"));
          }) },
        ]} />
        <SearchDropdown title="Filter Definition" items={[{ id: "auto", label: "All Definitions" }, ...definitionGuids.map((entry) => ({ id: entry ?? "none", label: entry ? state.definitions.get(entry)?.name ?? "Missing Definition" : "No Definition" }))]} onSelect={setDefinitionFilter}><Button size="sm" variant="ghost" className={cn("max-w-48", TOUCH_ACTION)} aria-label="Filter Definition"><TypeVisualIcon visual={DEFINITION_VISUAL} /><span className="min-w-0 truncate">{definitionFilter === "auto" ? definition?.name ?? "All Definitions" : definition?.name ?? "No Definition"}</span><ChevronDownIcon data-icon="inline-end" /></Button></SearchDropdown>
        <SearchInput value={query} onChange={setQuery} placeholder="Search Entries" aria-label="Search Entries" className="ml-auto h-7 min-h-7 min-w-32 flex-1 pointer-coarse:min-h-11" />
      </div>
    </div>
    <OperationError message={actions.error} />
    {!index ? <DataEmpty title="Invalid Hierarchy">Resolve the issues in Validation before editing entries.</DataEmpty> : entries.length === 0 ? <DataEmpty title="No Entries">Add an entry to this branch.</DataEmpty> : filtered.length === 0 ? <DataEmpty title="No Matching Entries">Change the search or filter to show entries.</DataEmpty> : <div role="grid" aria-label="Branch Entries" aria-rowcount={filtered.length + 1} aria-colcount={definition ? visibleFields.length + 2 : 4} aria-activedescendant={selectedIndex >= 0 ? `${gridId}-${selectedEntryId}` : undefined} tabIndex={0} className="min-w-full outline-none" style={{ width: Math.max(420, 265 + (definition ? visibleFields.length * 120 : 190)) }} onKeyDown={(event) => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
      let next = selectedIndex;
      if (event.key === "ArrowDown") next = Math.min(filtered.length - 1, selectedIndex + 1);
      else if (event.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = filtered.length - 1;
      else if (event.key === "Enter" && selected) { event.preventDefault(); state.focusField(selected.id, ""); return; }
      else return;
      event.preventDefault(); state.selectEntry(filtered[next]?.id ?? null, false);
    }}>
      <div role="row" className="sticky z-10 grid h-7 items-center border-b border-border bg-panel-header text-xs text-muted-foreground pointer-coarse:h-11" style={{ gridTemplateColumns: gridColumns, top: headerHeight }}>
        <span role="columnheader" aria-sort={sort?.field === "$name" ? sort.direction === 1 ? "ascending" : "descending" : "none"}><Button variant="ghost" size="xs" aria-label="Sort By Entry Name" className="w-full justify-start px-2 pointer-coarse:min-h-11" onClick={() => sortColumn("$name")}>{descendants ? "Path" : "Name"}{sort?.field === "$name" ? sort.direction === 1 ? " ↑" : " ↓" : ""}</Button></span>
        {definition ? visibleFields.map((field) => <span role="columnheader" key={field.id ?? field.name} aria-sort={sort?.field === field.name ? sort.direction === 1 ? "ascending" : "descending" : "none"}><Button variant="ghost" size="xs" className="w-full justify-start truncate px-2 pointer-coarse:min-h-11" aria-label={`Sort By ${humanizePropertyLabel(field.name)}`} onClick={() => sortColumn(field.name)}>{humanizePropertyLabel(field.name)}{sort?.field === field.name ? sort.direction === 1 ? " ↑" : " ↓" : ""}</Button></span>) : <><span role="columnheader" className="px-2">Definition</span><span role="columnheader" className="px-2">Children</span></>}
        <span role="columnheader" className="px-2">Status</span>
      </div>
      <WindowedList itemCount={filtered.length} rowHeight={rowHeight} activeIndex={selectedIndex}>{(entryIndex) => {
        const entry = filtered[entryIndex]!;
        const info = state.entryInfo.get(entry.id);
        const migration = info?.migration;
        const issues = info?.issues ?? [];
        const errors = issues.filter((issue) => issue.severity === "error").length;
        const warnings = issues.length - errors;
        const needsApply = requiresApply(migration);
        const status = needsApply ? "Definition Changed" : errors ? `${errors} Error${errors === 1 ? "" : "s"}` : warnings ? `${warnings} Warning${warnings === 1 ? "" : "s"}` : "";
        const values = migrationBlocked(migration) ? entry.values : migration?.entry.values ?? entry.values;
        const effective = index.effectiveDefinitionById.get(entry.id);
        return <div id={`${gridId}-${entry.id}`} role="row" aria-rowindex={entryIndex + 2} aria-selected={selectedEntryId === entry.id} data-testid={`data-tree-entry-${entry.id}`} className={cn("grid h-full cursor-default items-center border-b border-border/40 text-xs", selectedEntryId === entry.id ? "bg-accent" : "hover:bg-accent/40")} style={{ gridTemplateColumns: gridColumns }} onClick={() => state.selectEntry(entry.id, false)} onDoubleClick={() => state.browse(entry.id)}>
          <span role="gridcell" className="truncate px-2 font-medium" title={index.pathById.get(entry.id)}>{descendants ? index.pathById.get(entry.id) : entry.name}</span>
          {definition ? visibleFields.map((field, columnIndex) => <div key={field.id ?? field.name} role="gridcell" className="min-w-0 px-1" onDoubleClick={(event) => event.stopPropagation()} onPaste={(event) => {
            const text = event.clipboardData.getData("text/plain");
            if (!/[\t\r\n]/.test(text)) return;
            event.preventDefault(); pasteCells(entryIndex, columnIndex, text);
          }}><DataEntryCell field={field} value={values[field.name]} label={`${entry.name} ${humanizePropertyLabel(field.name)}`} editable={!readOnly && !needsApply && !migrationBlocked(migration)} enums={catalog.enumMembers} onChange={(value) => editCell(entry.id, field, value)} preview={previewValue(values[field.name], (assetGuid) => catalog.byGuid.get(assetGuid)?.header.name)} /></div>) : <><span role="gridcell" className="truncate px-2 text-muted-foreground">{effective ? state.definitions.get(effective)?.name ?? "Missing Definition" : "None"}</span><span role="gridcell" className="px-2 tabular-nums text-muted-foreground">{index.childrenByParentId.get(entry.id)?.length ?? 0}</span></>}
          <span role="gridcell" className={cn("truncate px-2", errors ? "text-destructive" : needsApply || warnings ? "text-(--warning)" : "text-muted-foreground")}>{status}</span>
        </div>;
      }}</WindowedList>
    </div>}
    {actions.dialogs}
  </PanelFrame>;
}

function definitionSource(state: TreeState, entry: DataTreeEntry): string {
  if (entry.definitionGuid !== undefined) return entry.definitionGuid === null ? "No Definition · Branch Override" : "Entry Override";
  let ancestor = entry.parentId ? state.index?.byId.get(entry.parentId) : undefined;
  while (ancestor) {
    if (ancestor.definitionGuid !== undefined) return `Inherited From ${state.index?.pathById.get(ancestor.id)}`;
    ancestor = ancestor.parentId ? state.index?.byId.get(ancestor.parentId) : undefined;
  }
  return "Inherited From Tree Default";
}

export function DataTreeValuesPanel(_props: IDockviewPanelProps) {
  void _props;
  const state = useDataAssetEditing();
  const { index, catalog, selectedEntryId, readOnly, focusRequest } = state;
  const actions = useTreeActions(state);
  const entry = selectedEntryId ? index?.byId.get(selectedEntryId) : undefined;
  const effective = entry ? index?.effectiveDefinitionById.get(entry.id) : null;
  const definition = effective ? state.definitions.get(effective) : undefined;
  const migration = entry ? state.entryInfo.get(entry.id)?.migration : null;
  const issues = entry ? state.entryInfo.get(entry.id)?.issues ?? [] : [];
  const [review, setReview] = useState(false);
  const [definitionPicker, setDefinitionPicker] = useState(false);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const recursive = issues.some((issue) => issue.code === "recursive-schema");
  const defaults = useMemo(() => definition && !recursive ? createDataEntryForDefinition(definition.guid, definition.fields, catalog.schemas).values : {}, [definition, catalog.schemas, recursive]);
  const editable = !readOnly && !requiresApply(migration) && !migrationBlocked(migration);
  const changed = Boolean(migration?.changes.some((change) => change.kind !== "removed"));
  useEffect(() => { setReview(false); }, [selectedEntryId]);
  useEffect(() => {
    if (!focusRequest || focusRequest.entryId !== selectedEntryId) return;
    const fields = Array.from(fieldsRef.current?.querySelectorAll<HTMLElement>("[data-data-field]") ?? []);
    const field = fields.find((item) => item.dataset.dataField === focusRequest.path) ?? fields.find((item) => focusRequest.path.startsWith(`${item.dataset.dataField}.`)) ?? fields[0];
    const control = field?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled])") ?? field?.querySelector<HTMLElement>('[id^="property-"]:not([disabled]), button:not([disabled]), [tabindex]');
    field?.scrollIntoView?.({ block: "nearest" }); control?.focus();
  }, [focusRequest, selectedEntryId]);
  if (!entry) return <PanelFrame data-testid="data-tree-values-panel"><DataEmpty title={index ? "Select An Entry" : "Invalid Hierarchy"}>{index ? "Select an entry to edit its owned values and Definition." : "Resolve the issues in Validation before editing this tree."}</DataEmpty></PanelFrame>;
  const entryPath = index?.pathById.get(entry.id) ?? entry.name;
  const fieldCount = definition && !recursive ? definition.fields.length : 0;
  return <PanelFrame data-testid="data-tree-values-panel">
    <div className="flex flex-col" ref={fieldsRef}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel-header px-2 py-1.5">
        <BetweenHorizontalStartIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium" title={entry.name}>{entry.name}</span>
          {entryPath !== entry.name ? <span className="truncate text-xs text-muted-foreground" title={entryPath}>{entryPath}</span> : null}
        </div>
        <NestedMenu size="chrome" items={actions.menuItems(entry.id)} trigger={<Button variant="ghost" size="icon-xs" className={TOUCH_ICON_ACTION} aria-label="Selected Entry Menu"><MoreHorizontalIcon className="size-3.5" /></Button>} />
      </div>
      <PropertySectionTitle>Definition</PropertySectionTitle>
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <div className="flex items-center gap-1">
          <DefinitionButton label="Entry Definition" assigned={Boolean(definition)} name={definition?.name ?? (effective ? "Missing Definition" : "None")} disabled={readOnly || actions.busy} onClick={() => setDefinitionPicker(true)} />
          {entry.definitionGuid !== undefined ? <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={readOnly || actions.busy} onClick={() => void actions.run(() => state.setEntryDefinition(entry.id, undefined))}>Use Parent Definition</Button> : null}
        </div>
        <p className="text-xs text-muted-foreground">{definitionSource(state, entry)}</p>
      </div>
      {actions.error || changed || recursive ? <div className="flex flex-col gap-2 px-2 pb-2">
        <OperationError message={actions.error} />
        {changed ? <Alert><AlertTitle>Definition Changed</AlertTitle><AlertDescription>{requiresApply(migration) ? "Review the field changes before editing this entry." : "Edit or reset changed values to match the Definition."}<Button size="sm" variant="outline" className={TOUCH_ACTION} disabled={readOnly} onClick={() => setReview(true)}>Review Changes</Button></AlertDescription></Alert> : null}
        {recursive ? <Alert variant="destructive"><AlertTitle>Recursive Definition</AlertTitle><AlertDescription>Remove the circular record reference before editing these values.</AlertDescription></Alert> : null}
      </div> : null}
      <PropertySectionTitle aside={issues.length ? <span className="font-normal text-destructive">{issues.length} {issues.length === 1 ? "Issue" : "Issues"}</span> : fieldCount ? <span className="font-normal tabular-nums text-muted-foreground">{fieldCount}</span> : null}>Values</PropertySectionTitle>
      {!definition ? <DataEmpty title={effective ? "Definition Missing" : "Untyped Entry"}>{effective ? "Restore or choose a Data Definition to edit these values. Stored values are preserved." : "Choose a Definition to edit typed values. This entry can still contain children; stored values are preserved."}</DataEmpty> : (recursive ? [] : definition.fields).map((field) => <DataValueEditor key={`${entry.id}:${field.id ?? field.name}`} field={field} value={(migrationBlocked(migration) ? entry.values : migration?.entry.values ?? entry.values)[field.name]} defaultValue={defaults[field.name]} onChange={(value) => void actions.run(() => state.updateValues([{ entryId: entry.id, values: { [field.name]: value }, expectedDefinitionGuid: definition.guid }], { mergeKey: `data:${entry.id}:${field.id ?? field.name}` }))} label={humanizePropertyLabel(field.name)} path={field.name} disabled={!editable} catalog={catalog} issues={issues} />)}
    </div>
    <AssetPicker open={definitionPicker} onOpenChange={setDefinitionPicker} title="Override Entry Definition" allowedTypes={["DataDefinition"]} assets={catalog.types.dataDefinitions.map((item) => ({ ...item, type: "DataDefinition" }))} allowNone onPick={(guid) => { setDefinitionPicker(false); void actions.run(() => state.setEntryDefinition(entry.id, guid)); }} />
    <AlertDialog open={review} onOpenChange={setReview}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Update Entry Fields</AlertDialogTitle><AlertDialogDescription>Apply the current Data Definition to this entry. Removed fields remain stored for recovery. Values belong to this entry; changing them does not change its children. Undo restores the previous values.</AlertDialogDescription></AlertDialogHeader>
      <ul className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 text-sm">{migration?.changes.map((change, position) => <li key={position} className="py-1">{humanizePropertyLabel(change.kind)}: {change.previousPath ? `${change.previousPath} → ` : ""}{change.path}</li>)}</ul>
      {migrationBlocked(migration) ? <Alert variant="destructive"><AlertTitle>Resolve Definition Conflicts</AlertTitle><AlertDescription>{migration?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ")}</AlertDescription></Alert> : null}
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={readOnly || migrationBlocked(migration)} onClick={() => { void actions.run(() => state.applyDefinition(entry.id)); setReview(false); }}>Apply Changes</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    {actions.dialogs}
  </PanelFrame>;
}

export function DataTreeValidationPanel(_props: IDockviewPanelProps) {
  void _props;
  const state = useDataAssetEditing();
  const { validation, index, focusRequest } = state;
  const errors = validation.filter((issue) => issue.severity === "error").length;
  return <PanelFrame data-testid="data-tree-validation-panel">
    <div className="sticky top-0 z-10 flex h-7 items-center border-b border-border bg-panel-header px-2 text-xs text-muted-foreground">{errors} Errors · {validation.length - errors} Warnings</div>
    {validation.length === 0 ? <DataEmpty title="No Issues">The hierarchy and typed entries are valid.</DataEmpty> : <WindowedList itemCount={validation.length} rowHeight={44}>{(position) => {
      const issue = validation[position]!;
      return <DiagnosticResultRow severity={issue.severity} message={issue.message} location={`${issue.entryId ? index?.pathById.get(issue.entryId) ?? issue.entryId : "Tree"}${issue.path ? ` · ${humanizePropertyLabel(issue.path)}` : ""}`} selected={focusRequest?.entryId === issue.entryId && focusRequest?.path === issue.path} onSelect={() => { if (issue.entryId) state.focusField(issue.entryId, issue.path); else state.documents.activateDockPanel("data-tree-hierarchy"); }} testId="data-validation-issue" />;
    }}</WindowedList>}
  </PanelFrame>;
}
