import { useEffect, useId, useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogResultRow,
  humanizePropertyLabel,
  WindowedList,
  isCoarsePointerEnvironment,
} from "@babylonslate/editor-kit";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { Switch } from "@babylonslate/ui/components/switch";
import { cn } from "@babylonslate/ui/lib/utils";
import type { PaletteNode, SerializedPin } from "./graph-types";
import {
  filterPaletteForPin,
  type PinCompatibilityRule,
} from "./graph-connect";
import { nodeRoleClass, nodeVisualRole } from "./node-theme";

/** Matches `--touch-target` so header and item rows share one window. */
export const NODE_PALETTE_ROW_HEIGHT = 44;

export interface NodePaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paletteNodes?: PaletteNode[];
  onAddNode: (node: PaletteNode) => void;
  /** When set, only nodes with a compatible opposite pin are listed. */
  filterPin?: SerializedPin | null;
  /** Pins on the node the dragged pin belongs to (sibling overlap ranking). */
  sourcePins?: SerializedPin[];
  /** Host connection rule (material numeric conversion). Defaults to exact kinds. */
  pinCompatibility?: PinCompatibilityRule;
}

type PaletteRow =
  | { kind: "header"; key: string; category: string }
  | { kind: "item"; key: string; node: PaletteNode; striped: boolean };

function filterNodes(nodes: PaletteNode[], query: string): PaletteNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const formula = needle.replace(/\s+/g, "");
  const symbolsOnly = /^[^\p{L}\p{N}\s]+$/u.test(formula);
  return nodes.filter((node) => {
    const aliasMatch = node.searchAliases?.some((alias) => {
      const normalized = alias.toLowerCase().replace(/\s+/g, "");
      return symbolsOnly ? normalized === formula : normalized.includes(formula);
    });
    return aliasMatch || (
      !symbolsOnly &&
      `${node.title} ${node.category} ${humanizePropertyLabel(node.category)}`
        .toLowerCase()
        .includes(needle)
    );
  });
}

function flattenPaletteRows(
  grouped: Array<[string, PaletteNode[]]>,
  omitHeaders: boolean,
): PaletteRow[] {
  const rows: PaletteRow[] = [];
  let itemIndex = 0;
  for (const [category, nodes] of grouped) {
    if (!omitHeaders) {
      rows.push({ kind: "header", key: `header:${category}`, category });
    }
    for (const node of nodes) {
      rows.push({
        kind: "item",
        key: node.id,
        node,
        striped: itemIndex % 2 === 1,
      });
      itemIndex += 1;
    }
  }
  return rows;
}

function PaletteWindowedList({
  rows,
  activeId,
  listId,
  onActiveChange,
  onAddNode,
  onOpenChange,
}: {
  rows: PaletteRow[];
  activeId: string | null;
  listId: string;
  onActiveChange: (id: string) => void;
  onAddNode: (node: PaletteNode) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const activeIndex = rows.findIndex(
    (row) => row.kind === "item" && row.key === activeId,
  );
  return (
    <div role="listbox" id={listId} aria-label="Nodes">
      <WindowedList
        itemCount={rows.length}
        rowHeight={NODE_PALETTE_ROW_HEIGHT}
        activeIndex={activeIndex}
      >
        {(index) => {
          const row = rows[index]!;
          if (row.kind === "header")
            return (
              <h3 className="flex h-full items-center px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {humanizePropertyLabel(row.category)}
              </h3>
            );
          const node = row.node;
          const commit = () => {
            onAddNode(node);
            onOpenChange(false);
          };
          return (
            <CatalogResultRow
              role="option"
              id={`${listId}-${encodeURIComponent(node.id)}`}
              active={node.id === activeId}
              striped={row.striped}
              tabIndex={-1}
              className="h-full"
              data-testid={`node-palette-item-${node.id}`}
              onSelect={commit}
              onFocus={() => onActiveChange(node.id)}
              title={node.title}
              description={humanizePropertyLabel(node.category)}
              leading={
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-sm",
                    nodeRoleClass(
                      nodeVisualRole({
                        nodeType: node.id,
                        title: node.title,
                        category: node.category,
                        pure: node.pure,
                        material: node.defaultData?.__material === true,
                        latent: node.latent,
                      }),
                    ),
                  )}
                  aria-hidden="true"
                />
              }
            />
          );
        }}
      </WindowedList>
    </div>
  );
}
export function NodePalette({
  open,
  onOpenChange,
  paletteNodes,
  onAddNode,
  filterPin = null,
  sourcePins,
  pinCompatibility,
}: NodePaletteProps) {
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [contextSensitive, setContextSensitive] = useState(true);
  const pinFiltered = Boolean(filterPin && contextSensitive);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setActiveId(null);
    setActiveCategory("all");
  }, [open]);

  const allNodes = useMemo(() => {
    const nodes = paletteNodes ?? [];
    return filterPin && contextSensitive
      ? filterPaletteForPin(nodes, filterPin, pinCompatibility, sourcePins)
      : nodes;
  }, [contextSensitive, filterPin, paletteNodes, pinCompatibility, sourcePins]);

  const filteredBySearch = useMemo(
    () => filterNodes(allNodes, search),
    [allNodes, search],
  );

  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of filteredBySearch) {
      map.set(node.category, (map.get(node.category) ?? 0) + 1);
    }
    const listed = [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, count]) => ({ id, label: humanizePropertyLabel(id), count }));
    return [
      {
        id: "all",
        label: pinFiltered ? "Suggested" : "All",
        count: filteredBySearch.length,
      },
      ...listed,
    ];
  }, [filteredBySearch, pinFiltered]);

  useEffect(() => {
    if (
      activeCategory !== "all" &&
      !categories.some((category) => category.id === activeCategory)
    ) {
      setActiveCategory("all");
    }
  }, [activeCategory, categories]);

  const filtered = useMemo(() => {
    if (activeCategory === "all") return filteredBySearch;
    return filteredBySearch.filter((node) => node.category === activeCategory);
  }, [activeCategory, filteredBySearch]);

  const grouped = useMemo(() => {
    if (pinFiltered && activeCategory === "all") {
      return [["", filtered] as [string, PaletteNode[]]];
    }
    const map = new Map<string, PaletteNode[]>();
    for (const node of filtered) {
      const list = map.get(node.category) ?? [];
      list.push(node);
      map.set(node.category, list);
    }
    const entries = [...map.entries()];
    if (pinFiltered) return entries;
    return entries.sort(([a], [b]) => a.localeCompare(b));
  }, [activeCategory, filtered, pinFiltered]);

  const rows = useMemo(
    () => flattenPaletteRows(grouped, pinFiltered),
    [grouped, pinFiltered],
  );

  const options = rows.flatMap((row) =>
    row.kind === "item" ? [row.node] : [],
  );
  const activeIndex = options.findIndex((node) => node.id === activeId);

  if (!paletteNodes?.length) return null;

  return (
    <CatalogDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setSearch("");
          setActiveCategory("all");
        }
      }}
      title="Add Node"
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={(id) => {
        setActiveCategory(id);
        setActiveId(null);
      }}
      search={search}
      onSearchChange={(value) => {
        setSearch(value);
        setActiveId(null);
      }}
      autoFocusSearch={!isCoarsePointerEnvironment()}
      searchInputProps={{
        role: "combobox",
        "aria-label": "Search Nodes",
        "aria-autocomplete": "list",
        "aria-expanded": options.length > 0,
        "aria-controls": options.length > 0 ? listId : undefined,
        "aria-activedescendant":
          activeIndex >= 0
            ? `${listId}-${encodeURIComponent(options[activeIndex]!.id)}`
            : undefined,
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing || options.length === 0) return;
          let next = activeIndex;
          if (event.key === "ArrowDown")
            next = Math.min(options.length - 1, activeIndex + 1);
          else if (event.key === "ArrowUp")
            next =
              activeIndex < 0
                ? options.length - 1
                : Math.max(0, activeIndex - 1);
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = options.length - 1;
          else if (event.key === "Enter") {
            event.preventDefault();
            onAddNode(options[Math.max(0, activeIndex)]!);
            onOpenChange(false);
            return;
          } else return;
          event.preventDefault();
          setActiveId(options[next]!.id);
        },
      }}
      searchPlaceholder="Search nodes"
      data-testid="node-palette"
      footer={
        <Field
          orientation="horizontal"
          className="min-h-[var(--touch-target,44px)] items-center"
        >
          <Switch
            id="node-palette-context-sensitive"
            checked={contextSensitive}
            onCheckedChange={(checked) => setContextSensitive(checked === true)}
            data-testid="node-palette-context-sensitive"
          />
          <FieldLabel htmlFor="node-palette-context-sensitive">
            Context Sensitive
          </FieldLabel>
        </Field>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches</p>
      ) : (
        <PaletteWindowedList
          key={`${search}:${activeCategory}:${contextSensitive}`}
          rows={rows}
          activeId={activeId}
          listId={listId}
          onActiveChange={setActiveId}
          onAddNode={onAddNode}
          onOpenChange={onOpenChange}
        />
      )}
    </CatalogDialog>
  );
}
