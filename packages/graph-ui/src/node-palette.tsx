import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CatalogDialog,
  humanizePropertyLabel,
  windowedSlice,
} from "@babylonslate/editor-kit";
import { buttonVariants } from "@babylonslate/ui/components/button";
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
  /** Host connection rule (material Float splat). Defaults to exact kinds. */
  pinCompatibility?: PinCompatibilityRule;
}

type PaletteRow =
  | { kind: "header"; key: string; category: string }
  | { kind: "item"; key: string; node: PaletteNode };

function filterNodes(nodes: PaletteNode[], query: string): PaletteNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter((node) =>
    `${node.title} ${node.category}`.toLowerCase().includes(needle),
  );
}

function flattenPaletteRows(
  grouped: Array<[string, PaletteNode[]]>,
  omitHeaders: boolean,
): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const [category, nodes] of grouped) {
    if (!omitHeaders) {
      rows.push({ kind: "header", key: `header:${category}`, category });
    }
    for (const node of nodes) {
      rows.push({ kind: "item", key: node.id, node });
    }
  }
  return rows;
}

function PaletteWindowedList({
  rows,
  onAddNode,
  onOpenChange,
}: {
  rows: PaletteRow[];
  onAddNode: (node: PaletteNode) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const body = listRef.current?.closest(
      '[data-testid="node-palette-body"]',
    );
    if (!(body instanceof HTMLElement)) return;
    const read = () => {
      setViewportHeight(body.clientHeight);
      setScrollTop(body.scrollTop);
    };
    read();
    const onScroll = () => setScrollTop(body.scrollTop);
    body.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(body);
    return () => {
      body.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [rows.length]);

  const { firstIndex, lastIndex } = windowedSlice({
    itemCount: rows.length,
    rowHeight: NODE_PALETTE_ROW_HEIGHT,
    scrollTop,
    viewportHeight,
  });
  const visibleRows = rows.slice(firstIndex, lastIndex);

  return (
    <div
      ref={listRef}
      className="relative"
      style={{ height: rows.length * NODE_PALETTE_ROW_HEIGHT }}
    >
      {visibleRows.map((row, index) => {
        const top = (firstIndex + index) * NODE_PALETTE_ROW_HEIGHT;
        if (row.kind === "header") {
          return (
            <h3
              key={row.key}
              className="absolute right-0 left-0 flex items-center px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
              style={{ top, height: NODE_PALETTE_ROW_HEIGHT }}
            >
              {row.category}
            </h3>
          );
        }
        const node = row.node;
        const commit = () => {
          onAddNode(node);
          onOpenChange(false);
        };
        return (
          <div
            key={row.key}
            role="option"
            tabIndex={0}
            className={cn(
              buttonVariants({ variant: "ghost", size: "touch" }),
              "absolute right-0 left-0 h-auto min-h-[var(--touch-target,44px)] justify-start gap-2 overflow-hidden touch-pan-y",
            )}
            style={{ top, height: NODE_PALETTE_ROW_HEIGHT }}
            data-testid={`node-palette-item-${node.id}`}
            onClick={commit}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              commit();
            }}
          >
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-sm",
                nodeRoleClass(
                  nodeVisualRole({
                    nodeType: node.id,
                    title: node.title,
                    category: node.category,
                    pure: node.pure,
                    latent: node.latent,
                  }),
                ),
              )}
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-col items-start leading-tight">
              <span className="truncate">{node.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {humanizePropertyLabel(node.category)}
              </span>
            </span>
          </div>
        );
      })}
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
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [contextSensitive, setContextSensitive] = useState(true);
  const pinFiltered = Boolean(filterPin && contextSensitive);

  useEffect(() => {
    if (!open) return;
    setSearch("");
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
      .map(([id, count]) => ({ id, label: id, count }));
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
      onCategoryChange={setActiveCategory}
      search={search}
      onSearchChange={setSearch}
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
            onCheckedChange={(checked) =>
              setContextSensitive(checked === true)
            }
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
          rows={rows}
          onAddNode={onAddNode}
          onOpenChange={onOpenChange}
        />
      )}
    </CatalogDialog>
  );
}
