import { useId, useMemo, useState } from "react";
import { ChevronDownIcon, FolderTreeIcon } from "lucide-react";
import { SearchDialog } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import type { DataGraphTreeEntry } from "../lib/data-graph";

type Entry = Pick<DataGraphTreeEntry, "id" | "path" | "effectiveDefinitionGuid">;

/** A shared searchable path picker; callers supply allowed destinations. */
export function DataTreeEntryPicker({ open, onOpenChange, entries, onPick, includeRoot = false,
  title = "Pick Data Entry", testId = "data-tree-entry-picker" }: {
  open: boolean; onOpenChange: (open: boolean) => void; entries: readonly Entry[];
  onPick: (path: string) => void; includeRoot?: boolean; title?: string; testId?: string;
}) {
  const items = useMemo(() => [
    ...(includeRoot ? [{ id: "/", label: "Tree Root", description: "All Root Entries" }] : []),
    ...entries.map((entry) => ({ id: entry.path, label: entry.path,
      description: entry.effectiveDefinitionGuid ? "Data Entry" : "Untyped Entry" })),
  ], [entries, includeRoot]);
  return <SearchDialog open={open} onOpenChange={onOpenChange} title={title} items={items}
    placeholder="Search Entry Paths" emptyLabel="No Entries" onSelect={(path) => {
      onPick(path === "/" ? "" : path); onOpenChange(false);
    }} data-testid={testId} />;
}

/** Compact path identity, shared by graph node pins and Inspector Defaults. */
export function DataTreeEntryField({ value, onChange, entries, includeRoot = false, disabled = false,
  id, testId, label = "Entry Path", hideLabel = false }: {
  value: string; onChange: (path: string) => void; entries: readonly Entry[]; includeRoot?: boolean;
  disabled?: boolean; id?: string; testId?: string; label?: string; hideLabel?: boolean;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  const text = !value ? (includeRoot ? "Tree Root" : "Select Entry")
    : entries.some((entry) => entry.path === value) ? value : `Missing Entry (${value})`;
  return <Field className="min-w-0 gap-1">
    <FieldLabel htmlFor={controlId} className={hideLabel ? "sr-only" : undefined}>{label}</FieldLabel>
    <Button id={controlId} type="button" role="combobox" aria-label={label} aria-expanded={open && !disabled}
      variant="outline" size="sm" disabled={disabled} data-testid={testId} title={text}
      className="min-w-24 max-w-full justify-start" onClick={() => { if (!disabled) setOpen(true); }}>
      <FolderTreeIcon className="size-3.5" /><span className="min-w-0 flex-1 truncate">{text}</span><ChevronDownIcon className="size-3.5" />
    </Button>
    <DataTreeEntryPicker open={open && !disabled} onOpenChange={setOpen} entries={entries} includeRoot={includeRoot}
      onPick={(path) => { if (!disabled) onChange(path); }} testId={testId ? `${testId}-picker` : undefined} />
  </Field>;
}
