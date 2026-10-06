import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDataSheetRow, type DataSheetRow } from "@babylonslate/core";
import { createDataRowForDefinition, reconcileDataRow, validateDataRow, type StructField, type TypeSchemas } from "@babylonslate/scripting";
import { AssetPicker, NamePromptDialog, NestedMenu, NumberField, PanelFrame, SearchInput, SearchDropdown, WindowedList, humanizePropertyLabel, isCoarsePointerEnvironment } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@babylonslate/ui/components/alert-dialog";
import { cn } from "@babylonslate/ui/lib/utils";
import { useDataAssetEditing } from "../context/data-asset-editing-context";
import { DataValueEditor } from "../components/data-value-editor";
import { DiagnosticResultRow } from "../components/diagnostic-result-row";

const TOUCH_ACTION = "pointer-coarse:min-h-11";
type SheetState = ReturnType<typeof useDataAssetEditing>;
type Migration = ReturnType<typeof reconcileDataRow> | null | undefined;

function migrationBlocked(migration: Migration): boolean {
  return Boolean(migration?.issues.some((issue) => ["rename-conflict", "ambiguous-schema", "invalid-schema", "recursive-schema"].includes(issue.code)));
}
function requiresApply(migration: Migration): boolean {
  return Boolean(migration?.changes.some((change) => change.kind === "added" || change.kind === "renamed"));
}
function recursiveDefinition(guid: string, schemas: TypeSchemas, visiting = new Set<string>()): boolean {
  if (visiting.has(guid) || visiting.size > 64) return true;
  const next = new Set([...visiting, guid]);
  return Boolean(schemas.structs[guid]?.fields.some((field) =>
    (field.typeId === "struct" && field.typeClassId && recursiveDefinition(field.typeClassId, schemas, next)) ||
    (field.container === "map" && field.keyTypeId === "struct" && field.keyTypeClassId && recursiveDefinition(field.keyTypeClassId, schemas, next))));
}
function preserveAuthoredFields(previous: unknown, next: unknown, depth = 0): unknown {
  if (depth > 64 || !previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) || Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  return Object.fromEntries(Object.entries({ ...before, ...next }).map(([key, value]) => [key,
    Object.prototype.hasOwnProperty.call(next, key) ? preserveAuthoredFields(before[key], value, depth + 1) : value,
  ]));
}
function changeRowValue(state: SheetState, rowId: string, field: StructField, value: unknown): Promise<void> {
  const definition = state.definition;
  if (!definition) return Promise.reject(new Error("Choose an available Data Definition before editing rows."));
  return state.changeSheet((sheet) => {
    if (sheet.definitionGuid !== definition.guid) throw new Error("The sheet's Data Definition changed. Review its fields before editing.");
    const row = sheet.rows.find((entry) => entry.id === rowId);
    if (!row) throw new Error("This row is no longer available.");
    const migration = reconcileDataRow(row, definition.guid, definition.fields, state.catalog.schemas);
    if (requiresApply(migration) || migrationBlocked(migration)) throw new Error("Apply the Definition changes in Values before editing this row.");
    const next = reconcileDataRow({ ...row, values: { ...row.values, [field.name]: preserveAuthoredFields(row.values[field.name], value) } }, definition.guid, definition.fields, state.catalog.schemas).row;
    return { ...sheet, rows: sheet.rows.map((entry) => entry.id === rowId ? next : entry) };
  }, `data:${rowId}:${field.id ?? field.name}`);
}
function nameError(rows: readonly DataSheetRow[], name: string, exceptId?: string): string | null {
  if (!name.trim()) return "Enter a row name.";
  return rows.some((row) => row.id !== exceptId && row.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()) ? "A row with this name already exists." : null;
}
function uniqueName(rows: readonly DataSheetRow[], base: string): string {
  let name = base;
  let suffix = 2;
  while (nameError(rows, name)) name = `${base} ${suffix++}`;
  return name;
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
function DataSheetCell({ field, value, label, editable, enums, onChange, preview }: {
  field: StructField; value: unknown; label: string; editable: boolean;
  enums: Record<string, string[]>; onChange: (value: unknown) => void; preview: string;
}) {
  const control = "h-6 min-h-6 w-full rounded-sm px-1 text-xs pointer-coarse:h-11";
  if (!editable || field.container === "array" || field.container === "map") return <span title={preview} className="block truncate">{preview}</span>;
  if (field.typeId === "float" || field.typeId === "int") return <NumberField aria-label={label} className={control} value={typeof value === "number" ? value : 0} onChange={(next) => onChange(field.typeId === "int" ? Math.trunc(next) : next)} />;
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
  const state = useDataAssetEditing();
  const { sheet, definition, catalog, readOnly, rowInfo, selectedRowId, select, focusRequest } = state;
  const gridId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<{ field: string; direction: 1 | -1 } | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const [definitionPicker, setDefinitionPicker] = useState(false);
  const [pendingDefinition, setPendingDefinition] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const hasSheet = Boolean(sheet);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(69);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => { const height = header.getBoundingClientRect().height; if (height > 0) setHeaderHeight(height); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(header);
    return () => observer?.disconnect();
  }, [hasSheet]);
  const searchCache = useMemo(() => new WeakMap<DataSheetRow, string>(), []);
  const issuesByRow = useMemo(() => {
    const result = new Map<string, typeof state.validation>();
    for (const issue of state.validation) {
      if (!issue.rowId) continue;
      const list = result.get(issue.rowId) ?? [];
      list.push(issue); result.set(issue.rowId, list);
    }
    return result;
  }, [state.validation]);
  const visibleFields = useMemo(() => definition?.fields.filter((field) => !hiddenColumns.has(field.id ?? field.name)) ?? [], [definition, hiddenColumns]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const rows = (sheet?.rows ?? []).filter((row) => {
      if (filter !== "all" && !(issuesByRow.get(row.id) ?? []).some((issue) => issue.severity === filter)) return false;
      if (!search) return true;
      let text = searchCache.get(row);
      if (text === undefined) { text = `${row.name} ${JSON.stringify(row.values)}`.toLocaleLowerCase(); searchCache.set(row, text); }
      return text.includes(search);
    });
    if (sort) rows.sort((a, b) => {
      const left = sort.field === "$name" ? a.name : a.values[sort.field];
      const right = sort.field === "$name" ? b.name : b.values[sort.field];
      return sort.direction * (typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true }));
    });
    return rows;
  }, [sheet?.rows, query, filter, sort, issuesByRow, searchCache]);
  const selected = sheet?.rows.find((row) => row.id === selectedRowId);
  const selectedIndex = filtered.findIndex((row) => row.id === selectedRowId);
  const rowHeight = isCoarsePointerEnvironment() ? 44 : 28;
  const gridColumns = `minmax(160px, 1.5fr) ${visibleFields.map(() => "minmax(120px, 1fr)").join(" ")} minmax(105px, 1fr)`;
  useEffect(() => {
    if (!focusRequest) return;
    setQuery(""); setFilter("all");
    const field = definition?.fields.find((entry) => focusRequest.path === entry.name || focusRequest.path.startsWith(`${entry.name}.`));
    if (field) setHiddenColumns((previous) => { const next = new Set(previous); next.delete(field.id ?? field.name); return next; });
  }, [focusRequest, definition]);
  const run = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { mutation.current = false; setBusy(false); }
  };
  const editCell = (rowId: string, field: StructField, value: unknown) => {
    select(rowId); setError(null);
    void changeRowValue(state, rowId, field, value).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const pasteCells = (rowIndex: number, columnIndex: number, text: string) => void run(async () => {
    if (!definition) throw new Error("Choose a Data Definition before pasting values.");
    const cells = parseTsv(text);
    if (rowIndex + cells.length > filtered.length || columnIndex + cells[0]!.length > visibleFields.length) throw new Error("The pasted table exceeds the visible rows or columns. Add rows or show more columns, then retry.");
    const targets = cells.map((values, index) => ({ id: filtered[rowIndex + index]!.id, values }));
    await state.changeSheet((current) => {
      if (current.definitionGuid !== definition.guid) throw new Error("The Data Definition changed. Retry the paste after reviewing its fields.");
      const changed = new Map<string, DataSheetRow>();
      const currentRows = new Map(current.rows.map((row) => [row.id, row]));
      for (const target of targets) {
        const row = currentRows.get(target.id);
        if (!row) throw new Error("A pasted row is no longer available.");
        const migration = reconcileDataRow(row, definition.guid, definition.fields, catalog.schemas);
        if (requiresApply(migration) || migrationBlocked(migration)) throw new Error(`${row.name}: Apply Definition changes before pasting.`);
        const values = { ...row.values };
        for (const [index, value] of target.values.entries()) {
          const field = visibleFields[columnIndex + index]!;
          values[field.name] = parseCell(value, field, catalog.enumMembers);
        }
        const next = reconcileDataRow({ ...row, values }, definition.guid, definition.fields, catalog.schemas).row;
        const issue = validateDataRow(next, definition.guid, catalog.schemas, { assetTypeForGuid: (guid) => catalog.byGuid.get(guid)?.header.type }).find((entry) => entry.severity === "error");
        if (issue) throw new Error(`${row.name}${issue.path ? ` · ${humanizePropertyLabel(issue.path)}` : ""}: ${issue.message}`);
        changed.set(row.id, next);
      }
      return { ...current, rows: current.rows.map((row) => changed.get(row.id) ?? row) };
    });
    select(targets[0]!.id);
  });
  const createRow = (duplicate = false) => void run(async () => {
    if (!definition) return;
    let createdId: string | null = null;
    await state.changeSheet((current) => {
      if (current.definitionGuid !== definition.guid) throw new Error("The sheet's Data Definition changed. Retry after reviewing it.");
      const source = duplicate ? current.rows.find((row) => row.id === selectedRowId) : undefined;
      if (duplicate && !source) throw new Error("Select a row to duplicate.");
      const name = uniqueName(current.rows, source ? `${source.name} Copy` : "New Entry");
      const row = source ? createDataSheetRow(name, source.values, source.schema) : createDataRowForDefinition(definition.guid, definition.fields, catalog.schemas, name);
      createdId = row.id;
      return { ...current, rows: [...current.rows, row] };
    });
    select(createdId); setQuery(""); setFilter("all");
  });
  const move = (direction: -1 | 1) => void run(() => state.changeSheet((current) => {
    const index = current.rows.findIndex((row) => row.id === selectedRowId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= current.rows.length) return current;
    const rows = [...current.rows]; [rows[index], rows[next]] = [rows[next]!, rows[index]!];
    setSort(null);
    return { ...current, rows };
  }));
  const setDefinition = (guid: string) => void run(() => state.changeSheet((current) => ({ ...current, definitionGuid: guid })));
  const sortColumn = (field: string) => setSort((previous) => ({ field, direction: previous?.field === field && previous.direction === 1 ? -1 : 1 }));
  if (!sheet) return <PanelFrame><DataEmpty title="Data Sheet Unavailable">Reopen the asset to reload its data.</DataEmpty></PanelFrame>;
  return <PanelFrame data-testid="data-sheet-rows-panel">
    <div ref={headerRef} className="sticky top-0 z-20 flex flex-col gap-1 border-b border-border bg-panel-header px-2 py-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">Definition</span>
        <Button variant="outline" size="sm" className={cn("max-w-56 truncate", TOUCH_ACTION)} disabled={busy || readOnly} onClick={() => setDefinitionPicker(true)} data-testid="data-sheet-definition">{definition?.name ?? (sheet.definitionGuid ? "Missing Definition" : "Choose Definition")}</Button>
        {definition ? <Button variant="ghost" size="sm" className={TOUCH_ACTION} onClick={() => void run(async () => {
          const asset = catalog.byGuid.get(definition.guid);
          if (asset) await state.documents.openDocument({ kind: "data-definition", path: asset.path, label: asset.header.name });
        })}>Open Definition</Button> : null}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{filtered.length === sheet.rows.length ? `${sheet.rows.length} Rows` : `${filtered.length} / ${sheet.rows.length} Rows`}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="outline" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !definition} onClick={() => createRow()}>New Row</Button>
        <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !selected || !definition} onClick={() => createRow(true)}>Duplicate</Button>
        <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !selected} onClick={() => setRenaming(true)}>Rename</Button>
        <Button variant="ghost" size="sm" className={TOUCH_ACTION} disabled={busy || readOnly || !selected} onClick={() => void run(async () => {
          await state.changeSheet((current) => ({ ...current, rows: current.rows.filter((row) => row.id !== selectedRowId) })); select(null);
        })}>Remove</Button>
        <NestedMenu size="chrome" trigger={<Button variant="ghost" size="sm" className={TOUCH_ACTION}>View</Button>} items={[
          { type: "submenu", id: "filter", label: "Filter", items: [{ type: "radio-group", id: "filter-choice", value: filter, onValueChange: setFilter, items: [{ id: "all", value: "all", label: "All Rows" }, { id: "error", value: "error", label: "Errors" }, { id: "warning", value: "warning", label: "Warnings" }] }] },
          { type: "submenu", id: "columns", label: "Columns", items: (definition?.fields ?? []).map((field) => ({ type: "checkbox", id: field.id ?? field.name, label: humanizePropertyLabel(field.name), checked: !hiddenColumns.has(field.id ?? field.name), closeOnClick: false, onCheckedChange: (checked) => setHiddenColumns((previous) => { const next = new Set(previous); if (checked) next.delete(field.id ?? field.name); else next.add(field.id ?? field.name); return next; }) })) },
          { id: "clear-sort", label: "Clear Sort", disabled: !sort, onSelect: () => setSort(null) },
          { id: "copy-row", label: "Copy Row Values", disabled: !selected || !visibleFields.length, onSelect: () => void run(async () => {
            if (!selected) return;
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is not available in this browser.");
            const migration = rowInfo.get(selected.id)?.migration;
            const values = migrationBlocked(migration) ? selected.values : migration?.row.values ?? selected.values;
            await navigator.clipboard.writeText(visibleFields.map((field) => tsvCell(values[field.name])).join("\t"));
          }) },
          { type: "separator", id: "order-separator" },
          { id: "move-up", label: "Move Row Up", disabled: busy || readOnly || !selected || sheet.rows[0]?.id === selectedRowId, onSelect: () => move(-1) },
          { id: "move-down", label: "Move Row Down", disabled: busy || readOnly || !selected || sheet.rows.at(-1)?.id === selectedRowId, onSelect: () => move(1) },
        ]} />
        <SearchInput value={query} onChange={setQuery} placeholder="Search Rows" aria-label="Search Rows" className="ml-auto h-7 min-h-7 min-w-32 flex-1 pointer-coarse:min-h-11" />
      </div>
    </div>
    <OperationError message={error} />
    {!definition ? <DataEmpty title={sheet.definitionGuid ? "Definition Missing" : "Choose A Definition"}>{sheet.definitionGuid ? "Restore the Data Definition or choose another one. Stored rows are preserved." : "Choose a Data Definition to create and edit rows in this sheet."}</DataEmpty> : sheet.rows.length === 0 ? <DataEmpty title="No Rows">Add a row to start authoring data.</DataEmpty> : filtered.length === 0 ? <DataEmpty title="No Matching Rows">Change the search or filter to show rows.</DataEmpty> : <div role="grid" aria-label="Data Rows" aria-rowcount={filtered.length + 1} aria-colcount={visibleFields.length + 2} aria-activedescendant={selectedIndex >= 0 ? `${gridId}-${selectedIndex}-${selectedRowId}` : undefined} tabIndex={0} className="min-w-full outline-none" style={{ width: Math.max(420, 265 + visibleFields.length * 120) }} onKeyDown={(event) => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
      let next = selectedIndex;
      if (event.key === "ArrowDown") next = Math.min(filtered.length - 1, selectedIndex + 1);
      else if (event.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = filtered.length - 1;
      else if (event.key === "Enter" && selected) { event.preventDefault(); state.focusField(selected.id, ""); return; }
      else return;
      event.preventDefault(); select(filtered[next]?.id ?? null);
    }}>
      <div role="row" className="sticky z-10 grid h-7 items-center border-b border-border bg-panel-header text-xs text-muted-foreground pointer-coarse:h-11" style={{ gridTemplateColumns: gridColumns, top: headerHeight }}>
        <span role="columnheader" aria-sort={sort?.field === "$name" ? sort.direction === 1 ? "ascending" : "descending" : "none"}><Button variant="ghost" size="xs" aria-label="Sort By Row Name" className="w-full justify-start px-2 pointer-coarse:min-h-11" onClick={() => sortColumn("$name")}>Row Name{sort?.field === "$name" ? sort.direction === 1 ? " ↑" : " ↓" : ""}</Button></span>
        {visibleFields.map((field) => <span role="columnheader" key={field.id ?? field.name} aria-sort={sort?.field === field.name ? sort.direction === 1 ? "ascending" : "descending" : "none"}><Button variant="ghost" size="xs" className="w-full justify-start truncate px-2 pointer-coarse:min-h-11" aria-label={`Sort By ${humanizePropertyLabel(field.name)}`} onClick={() => sortColumn(field.name)}>{humanizePropertyLabel(field.name)}{sort?.field === field.name ? sort.direction === 1 ? " ↑" : " ↓" : ""}</Button></span>)}
        <span role="columnheader" className="px-2">Status</span>
      </div>
      <WindowedList itemCount={filtered.length} rowHeight={rowHeight} activeIndex={selectedIndex}>{(index) => {
        const row = filtered[index]!;
        const migration = rowInfo.get(row.id)?.migration;
        const issues = issuesByRow.get(row.id) ?? [];
        const errors = issues.filter((issue) => issue.severity === "error").length;
        const warnings = issues.length - errors;
        const needsApply = requiresApply(migration);
        const status = needsApply ? "Definition Changed" : errors ? `${errors} Error${errors === 1 ? "" : "s"}` : warnings ? `${warnings} Warning${warnings === 1 ? "" : "s"}` : "";
        const values = migrationBlocked(migration) ? row.values : migration?.row.values ?? row.values;
        return <div id={`${gridId}-${index}-${row.id}`} role="row" aria-rowindex={index + 2} aria-selected={selectedRowId === row.id} data-testid={`data-sheet-row-${row.id}`} className={cn("grid h-full cursor-default items-center border-b border-border/50 text-xs hover:bg-accent/50", selectedRowId === row.id && "bg-accent")} style={{ gridTemplateColumns: gridColumns }} onClick={() => select(row.id)} onDoubleClick={() => state.focusField(row.id, "")}>
          <span role="gridcell" className="truncate px-2" title={row.name}>{row.name}</span>
          {visibleFields.map((field, columnIndex) => <div key={field.id ?? field.name} role="gridcell" className="min-w-0 px-1" onDoubleClick={(event) => event.stopPropagation()} onPaste={(event) => {
            const text = event.clipboardData.getData("text/plain");
            if (!/[\t\r\n]/.test(text)) return;
            event.preventDefault();
            pasteCells(index, columnIndex, text);
          }}>
            <DataSheetCell field={field} value={values[field.name]} label={`${row.name} ${humanizePropertyLabel(field.name)}`} editable={!readOnly && !needsApply && !migrationBlocked(migration)} enums={catalog.enumMembers} onChange={(value) => editCell(row.id, field, value)} preview={previewValue(values[field.name], (guid) => catalog.byGuid.get(guid)?.header.name)} />
          </div>)}
          <span role="gridcell" className={cn("truncate px-2", errors ? "text-destructive" : "text-muted-foreground")}>{status}</span>
        </div>;
      }}</WindowedList>
    </div>}
    <AssetPicker open={definitionPicker} onOpenChange={setDefinitionPicker} title="Choose Data Definition" allowedTypes={["DataDefinition"]} assets={catalog.types.dataDefinitions.map((entry) => ({ ...entry, type: "DataDefinition" }))} allowNone={false} onPick={(guid) => {
      setDefinitionPicker(false);
      if (!guid || guid === sheet.definitionGuid) return;
      if (sheet.rows.length) setPendingDefinition(guid); else setDefinition(guid);
    }} />
    <AlertDialog open={pendingDefinition !== null} onOpenChange={(open) => { if (!open) setPendingDefinition(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Change Data Definition</AlertDialogTitle><AlertDialogDescription>Existing row values stay stored. Review the new fields in Values before editing each row. Undo restores the previous Definition.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (pendingDefinition) setDefinition(pendingDefinition); setPendingDefinition(null); }}>Change Definition</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <NamePromptDialog open={renaming} onOpenChange={setRenaming} title="Rename Row" label="Name" confirmLabel="Rename" initialValue={selected?.name ?? ""} validate={(name) => nameError(sheet.rows, name, selectedRowId ?? undefined)} onSubmit={(name) => void run(() => state.changeSheet((current) => {
      const error = nameError(current.rows, name, selectedRowId ?? undefined); if (error) throw new Error(error);
      return { ...current, rows: current.rows.map((row) => row.id === selectedRowId ? { ...row, name: name.trim() } : row) };
    }))} />
  </PanelFrame>;
}

export function DataSheetValuesPanel(_props: IDockviewPanelProps) {
  void _props;
  const state = useDataAssetEditing();
  const { sheet, definition, catalog, rowInfo, selectedRowId, readOnly, focusRequest } = state;
  const row = sheet?.rows.find((entry) => entry.id === selectedRowId);
  const migration = row ? rowInfo.get(row.id)?.migration : null;
  const issues = row ? state.validation.filter((issue) => issue.rowId === row.id) : [];
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const recursive = useMemo(() => Boolean(definition && recursiveDefinition(definition.guid, catalog.schemas)), [definition, catalog.schemas]);
  const defaults = useMemo(() => definition && !recursive ? createDataRowForDefinition(definition.guid, definition.fields, catalog.schemas).values : {}, [definition, catalog.schemas, recursive]);
  const editable = !readOnly && !requiresApply(migration) && !migrationBlocked(migration);
  const changed = Boolean(migration?.changes.some((change) => change.kind !== "removed"));
  useEffect(() => { setError(null); setReview(false); }, [selectedRowId]);
  useEffect(() => {
    if (!focusRequest || focusRequest.rowId !== selectedRowId) return;
    const fields = Array.from(fieldsRef.current?.querySelectorAll<HTMLElement>("[data-data-field]") ?? []);
    const field = fields.find((entry) => entry.dataset.dataField === focusRequest.path) ?? fields.find((entry) => focusRequest.path.startsWith(`${entry.dataset.dataField}.`)) ?? fields[0];
    const control = field?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled])") ?? field?.querySelector<HTMLElement>('[id^="property-"]:not([disabled]), button:not([disabled]), [tabindex]');
    field?.scrollIntoView?.({ block: "nearest" }); control?.focus();
  }, [focusRequest, selectedRowId]);
  const run = (action: () => Promise<void>) => { setError(null); void action().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); };
  if (!row) return <PanelFrame data-testid="data-sheet-values-panel"><DataEmpty title="Select A Row">Select a row to edit its values.</DataEmpty></PanelFrame>;
  if (state.identityInvalid) return <PanelFrame data-testid="data-sheet-values-panel"><DataEmpty title="Invalid Row Identities">Rows need unique, non-empty IDs before this sheet can be edited. Restore the valid row identities; existing values are preserved.</DataEmpty></PanelFrame>;
  return <PanelFrame data-testid="data-sheet-values-panel">
    <div className="flex flex-col gap-2 p-2" ref={fieldsRef}>
      <p className="truncate text-xs font-medium" title={row.name}>{row.name}</p>
      <OperationError message={error} />
      {changed ? <Alert><AlertTitle>Definition Changed</AlertTitle><AlertDescription>{requiresApply(migration) ? "Review the field changes before editing this row." : "Edit or reset changed values to match the Definition."}<Button size="sm" variant="outline" className={TOUCH_ACTION} disabled={readOnly} onClick={() => setReview(true)}>Review Changes</Button></AlertDescription></Alert> : null}
      {recursive ? <Alert variant="destructive"><AlertTitle>Recursive Definition</AlertTitle><AlertDescription>Remove the circular record reference before editing these values.</AlertDescription></Alert> : null}
      {!definition ? <DataEmpty title="Definition Missing">Restore the Data Definition to edit this row. Stored values are preserved.</DataEmpty> : (recursive ? [] : definition.fields).map((field) => <DataValueEditor key={`${row.id}:${field.id ?? field.name}`} field={field} value={(migrationBlocked(migration) ? row.values : migration?.row.values ?? row.values)[field.name]} defaultValue={defaults[field.name]} onChange={(value) => run(() => changeRowValue(state, row.id, field, value))} label={humanizePropertyLabel(field.name)} path={field.name} disabled={!editable} catalog={catalog} issues={issues} />)}
      {issues.length ? <p className="text-xs text-muted-foreground">{issues.length} {issues.length === 1 ? "issue" : "issues"} in Validation.</p> : null}
    </div>
    <AlertDialog open={review} onOpenChange={setReview}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Update Row Fields</AlertDialogTitle><AlertDialogDescription>Apply the current Data Definition to this row. Removed fields remain stored for recovery. Undo restores the previous values.</AlertDialogDescription></AlertDialogHeader>
      <ul className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 text-sm">{migration?.changes.map((change, index) => <li key={index} className="py-1">{humanizePropertyLabel(change.kind)}: {change.previousPath ? `${change.previousPath} → ` : ""}{change.path}</li>)}</ul>
      {migrationBlocked(migration) ? <Alert variant="destructive"><AlertTitle>Resolve Definition Conflicts</AlertTitle><AlertDescription>{migration?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ")}</AlertDescription></Alert> : null}
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={migrationBlocked(migration)} onClick={() => {
        if (definition && !migrationBlocked(migration)) run(() => state.changeSheet((current) => ({ ...current, rows: current.rows.map((entry) => entry.id === row.id ? reconcileDataRow(entry, definition.guid, definition.fields, catalog.schemas).row : entry) })));
        setReview(false);
      }}>Apply Changes</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </PanelFrame>;
}

export function DataSheetValidationPanel(_props: IDockviewPanelProps) {
  void _props;
  const state = useDataAssetEditing();
  const { validation, sheet, definition, focusRequest } = state;
  const rows = useMemo(() => new Map(sheet?.rows.map((row) => [row.id, row]) ?? []), [sheet?.rows]);
  const errors = validation.filter((issue) => issue.severity === "error").length;
  return <PanelFrame data-testid="data-sheet-validation-panel">
    <div className="sticky top-0 z-10 flex h-7 items-center border-b border-border bg-panel-header px-2 text-xs text-muted-foreground">{errors} Errors · {validation.length - errors} Warnings</div>
    {!definition ? <DataEmpty title="Definition Unavailable">Choose an available Data Definition to validate rows.</DataEmpty> : validation.length === 0 ? <DataEmpty title="No Issues">All rows match the current Definition.</DataEmpty> : <WindowedList itemCount={validation.length} rowHeight={44}>{(index) => {
      const issue = validation[index]!;
      return <DiagnosticResultRow severity={issue.severity} message={issue.message} location={`${issue.rowId ? rows.get(issue.rowId)?.name ?? issue.rowId : "Sheet"}${issue.path ? ` · ${humanizePropertyLabel(issue.path)}` : ""}`} selected={focusRequest?.rowId === issue.rowId && focusRequest?.path === issue.path} onSelect={() => { if (issue.rowId) state.focusField(issue.rowId, issue.path); }} testId="data-validation-issue" />;
    }}</WindowedList>}
  </PanelFrame>;
}
