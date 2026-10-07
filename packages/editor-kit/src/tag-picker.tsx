import { createContext, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { isValidTagPath, type Tag, type TagContainer, type TagDefinition } from "@babylonslate/core";
import { ChevronDownIcon, MinusIcon, TagsIcon, TagIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@babylonslate/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Separator } from "@babylonslate/ui/components/separator";
import { cn } from "@babylonslate/ui/lib/utils";
import { popupMenuFrame } from "./catalog-menu";
import { isCoarsePointerEnvironment } from "./prevent-document-overscroll";
import { SearchInput } from "./search-input";
import { TreeView, type TreeViewNode } from "./tree-view";

export interface TagApi {
  entries: readonly TagDefinition[];
  onCreate?: (path: string) => Tag | Promise<Tag>;
}

const EMPTY_TAGS: readonly TagDefinition[] = [];
const TagContext = createContext<TagApi>({ entries: EMPTY_TAGS });

/** Shares the current project's Tags and its persistent creation operation. */
export function TagProvider({ entries, onCreate, children }: TagApi & { children: ReactNode }) {
  const value = useMemo(() => ({ entries, onCreate }), [entries, onCreate]);
  return <TagContext.Provider value={value}>{children}</TagContext.Provider>;
}

export function useTags(): TagApi {
  return useContext(TagContext);
}

export function tagDisplayName(entries: readonly TagDefinition[], tag: Tag): string {
  return tag === 0 ? "None" : entries.find((entry) => entry.id === tag)?.path ?? "Missing Tag";
}

interface TagPickerBaseProps {
  entries?: readonly TagDefinition[];
  onCreate?: TagApi["onCreate"];
  disabled?: boolean;
  mixed?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

export type TagPickerProps = TagPickerBaseProps & (
  | { mode: "single"; value: Tag; onChange: (tag: Tag) => void }
  | { mode: "multiple"; value: TagContainer; onChange: (tags: TagContainer) => void }
);

/** Compact readonly identity with a searchable, hierarchical selection popup. */
export function TagPicker(props: TagPickerProps) {
  const context = useTags();
  const entries = props.entries ?? context.entries;
  const onCreate = props.onCreate ?? (props.entries === undefined ? context.onCreate : undefined);
  const testId = props["data-testid"] ?? "tag-picker";
  const multiple = props.mode === "multiple";
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const createId = useId();
  const coarse = isCoarsePointerEnvironment();
  const selected = useMemo(
    () => new Set(props.mode === "single" ? (props.value ? [props.value] : []) : props.value.Tags),
    [props.mode, props.value],
  );
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const indexed = useMemo(() => {
    if (!open) return null;
    const children = new Map<number, TagDefinition[]>();
    for (const entry of entries) {
      const parent = byId.has(entry.parentId) ? entry.parentId : 0;
      const list = children.get(parent) ?? [];
      list.push(entry);
      children.set(parent, list);
    }
    for (const list of children.values()) list.sort((a, b) => a.path.localeCompare(b.path));
    const ordered: Array<{ entry: TagDefinition; depth: number }> = [];
    const starts = new Map<number, number>();
    const subtreeSizes = new Map<number, number>();
    const pending = [...(children.get(0) ?? [])].reverse().map((entry) => ({ entry, depth: 0 }));
    while (pending.length) {
      const current = pending.pop()!;
      if (starts.has(current.entry.id)) continue;
      starts.set(current.entry.id, ordered.length);
      ordered.push(current);
      const nested = children.get(current.entry.id) ?? [];
      for (let index = nested.length - 1; index >= 0; index--) {
        pending.push({ entry: nested[index]!, depth: current.depth + 1 });
      }
    }
    for (let index = ordered.length - 1; index >= 0; index--) {
      const { entry } = ordered[index]!;
      let size = 1;
      for (const child of children.get(entry.id) ?? []) size += subtreeSizes.get(child.id) ?? 0;
      subtreeSizes.set(entry.id, size);
    }
    const descendants = (id: number): number[] => {
      const start = starts.get(id);
      return start === undefined ? [] : ordered.slice(start, start + (subtreeSizes.get(id) ?? 1)).map(({ entry }) => entry.id);
    };
    return { children, ordered, subtreeSizes, descendants };
  }, [byId, entries, open]);
  const selectionCounts = useMemo(() => {
    const counts = new Map<number, number>();
    if (!indexed) return counts;
    for (let index = indexed.ordered.length - 1; index >= 0; index--) {
      const { entry } = indexed.ordered[index]!;
      const count = (counts.get(entry.id) ?? 0) + (selected.has(entry.id) ? 1 : 0);
      counts.set(entry.id, count);
      if (byId.has(entry.parentId)) counts.set(entry.parentId, (counts.get(entry.parentId) ?? 0) + count);
    }
    return counts;
  }, [byId, indexed, selected]);
  const nodes = useMemo(() => {
    if (!indexed) return [];
    const needle = query.trim().toLowerCase();
    const visible = new Set<number>();
    if (needle) {
      for (const entry of entries) {
        if (!entry.path.toLowerCase().includes(needle)) continue;
        let current: TagDefinition | undefined = entry;
        while (current && !visible.has(current.id)) {
          visible.add(current.id);
          current = byId.get(current.parentId);
        }
      }
    }
    const rows: TreeViewNode[] = [];
    for (let index = 0; index < indexed.ordered.length; index++) {
      const { entry, depth } = indexed.ordered[index]!;
      const subtreeSize = indexed.subtreeSizes.get(entry.id) ?? 1;
      if (needle && !visible.has(entry.id)) {
        index += subtreeSize - 1;
        continue;
      }
      const count = selectionCounts.get(entry.id) ?? 0;
      const checked = multiple ? count === subtreeSize : selected.has(entry.id);
      const indeterminate = count > 0 && !checked;
      const hasChildren = (indexed.children.get(entry.id)?.length ?? 0) > 0;
      const expanded = needle.length > 0 || !collapsed.has(entry.id);
      rows.push({
        id: String(entry.id),
        label: entry.path.slice(entry.path.lastIndexOf(".") + 1),
        depth,
        hasChildren,
        expanded,
        icon: <span className="pointer-events-none relative flex" title={entry.path}>
          <Checkbox checked={checked} indeterminate={indeterminate} readOnly tabIndex={-1} aria-label={`${entry.path} Selection`} className={indeterminate ? "[&_svg]:hidden" : undefined} />
          {indeterminate ? <MinusIcon className="absolute inset-0 size-4 text-foreground" aria-hidden="true" /> : null}
        </span>,
        preview: hasChildren ? <span className="text-xs text-muted-foreground tabular-nums">{subtreeSize - 1}</span> : undefined,
      });
      if (!expanded) index += subtreeSize - 1;
    }
    return rows;
  }, [byId, collapsed, entries, indexed, multiple, query, selected, selectionCounts]);
  const names = [...selected].map((id) => id === 0 ? "None" : byId.get(id)?.path ?? "Missing Tag");
  const summary = props.mixed ? "Mixed" : names.length ? names.join(", ") : multiple ? "No Tags" : "None";

  const select = (tag: number) => {
    if (props.disabled || busy || !indexed) return;
    if (props.mode === "single") {
      props.onChange(!props.mixed && props.value === tag ? 0 : tag);
      setOpen(false);
      return;
    }
    const subtree = indexed.descendants(tag);
    const remove = subtree.every((id) => selected.has(id));
    const next = new Set(selected);
    for (const id of subtree) {
      if (remove) next.delete(id);
      else next.add(id);
    }
    props.onChange({ Tags: [...next] });
  };
  const create = async () => {
    const path = draft.trim();
    if (!onCreate || busy || props.disabled) return;
    if (!isValidTagPath(path)) {
      setError("Use dot-separated names with letters, numbers, or underscores. Each name must start with a letter or underscore.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const tag = await onCreate(path);
      if (props.mode === "single") {
        props.onChange(tag);
        setOpen(false);
      } else {
        props.onChange({ Tags: [...new Set([...props.value.Tags, tag])] });
      }
      setDraft("");
      setQuery("");
      setCollapsed(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could Not Create Tag");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button ref={triggerRef} id={props.id} type="button" variant="outline" size="sm"
      disabled={props.disabled} className={cn("min-w-0 justify-start", props.className)}
      data-testid={testId} aria-label={props["aria-label"] ?? (multiple ? "Select Tags" : "Select Tag")}
      aria-haspopup="dialog" aria-expanded={open} title={summary}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor({ x: rect.left, y: rect.bottom + 4 });
        setQuery(""); setDraft(""); setError(""); setCollapsed(new Set()); setOpen(true);
      }}>
      {multiple ? <TagsIcon data-icon="inline-start" /> : <TagIcon data-icon="inline-start" />}
      <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
      {multiple && selected.size > 0 ? <span className="text-muted-foreground tabular-nums">{selected.size}</span> : null}
      <ChevronDownIcon data-icon="inline-end" />
    </Button>
    {open ? <Dialog open onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} overlayClassName="catalog-menu-overlay bg-transparent" finalFocus={triggerRef}
        initialFocus={(interaction) => coarse && interaction !== "keyboard" ? bodyRef.current : searchRef.current}
        className="catalog-menu catalog-menu-popup flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-none"
        style={popupMenuFrame(anchor, { width: 400, height: 470 })} data-testid={`${testId}-dialog`}>
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
          <DialogTitle className="text-sm">{multiple ? "Select Tags" : "Select Tag"}</DialogTitle>
          <span className="text-xs text-muted-foreground">{selected.size} Selected</span>
        </div>
        <Field className="shrink-0 gap-1.5 px-3 pb-2" data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={createId} className="text-xs">Create Tag</FieldLabel>
          <div className="flex gap-2">
            <Input id={createId} value={draft} placeholder="Example.Tag" disabled={!onCreate || busy || props.disabled}
              aria-invalid={Boolean(error)} className="h-7 min-h-7 text-xs" data-testid={`${testId}-create-input`}
              onChange={(event) => { setDraft(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void create(); } }} />
            <Button type="button" size="sm" disabled={!onCreate || busy || !draft.trim() || props.disabled}
              onClick={() => void create()} data-testid={`${testId}-create`}>{busy ? "Creating…" : "Create"}</Button>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <div className="shrink-0 px-3 pb-2">
          <SearchInput ref={searchRef} value={query} onChange={setQuery} placeholder="Search Tags" aria-label="Search Tags"
            className="h-7 min-h-7" data-testid={`${testId}-search`}
            onKeyDown={(event) => {
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.nativeEvent.isComposing) {
                event.preventDefault();
                bodyRef.current?.querySelector<HTMLElement>('[role="tree"]')?.focus();
              }
            }} />
        </div>
        <Separator />
        <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 p-1 outline-none" aria-busy={busy}>
          <TreeView nodes={nodes} selectionFollowsFocus={false} selectedId={props.mode === "single" && props.value ? String(props.value) : null}
            selectedIds={multiple ? [...selected].map(String) : undefined} onSelect={(id) => select(Number(id))}
            onToggleExpanded={(id) => setCollapsed((previous) => {
              const next = new Set(previous); const tag = Number(id);
              if (next.has(tag)) next.delete(tag); else next.add(tag);
              return next;
            })} rowHeight={coarse ? 44 : 28} emptyLabel={query ? "No Matching Tags" : "Create Your First Tag"}
            aria-label="Tags" data-testid={`${testId}-tree`} />
        </div>
        <Separator />
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <Button type="button" size="sm" variant="ghost" disabled={selected.size === 0 || busy || props.disabled}
            data-testid={`${testId}-clear`} onClick={() => props.mode === "single" ? props.onChange(0) : props.onChange({ Tags: [] })}>
            {multiple ? "Deselect All" : "Clear Selection"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog> : null}
  </>;
}
