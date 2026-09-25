import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  clampOverlayMenuPosition,
  humanizePropertyLabel,
  isCoarsePointerEnvironment,
  SearchInput,
  WindowedList,
} from "@babylonslate/editor-kit";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Kbd } from "@babylonslate/ui/components/kbd";
import { cn } from "@babylonslate/ui/lib/utils";
import type { PaletteNode, SerializedPin } from "./graph-types";
import {
  filterPaletteForPin,
  type PinCompatibilityRule,
} from "./graph-connect";
import { nodeRoleClass, nodeVisualRole } from "./node-theme";

/** Desktop rows match `--chrome-row`; coarse pointers use `--touch-target`. */
export const NODE_PALETTE_ROW_HEIGHT = 28;
export const NODE_PALETTE_TOUCH_ROW_HEIGHT = 44;

const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 460;
const POPUP_MARGIN = 8;

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
  /**
   * Viewport point the menu opens from (pointer, double tap, or under the Add
   * Node button). Without one the menu is centered.
   */
  anchor?: { x: number; y: number } | null;
}

type PaletteRow =
  | {
      kind: "category";
      key: string;
      category: string;
      count: number;
      expanded: boolean;
    }
  | { kind: "item"; key: string; node: PaletteNode; nested: boolean };

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

function rowId(listId: string, key: string): string {
  return `${listId}-${encodeURIComponent(key)}`;
}

function cssPixels(name: string): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return Number.isFinite(value) ? value : 0;
}

function popupFrame(anchor: { x: number; y: number } | null | undefined) {
  const insets = {
    top: cssPixels("--safe-top"),
    right: cssPixels("--safe-right"),
    bottom: cssPixels("--safe-bottom"),
    left: cssPixels("--safe-left"),
  };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(POPUP_WIDTH, vw - insets.left - insets.right - POPUP_MARGIN * 2);
  const height = Math.min(POPUP_HEIGHT, vh - insets.top - insets.bottom - POPUP_MARGIN * 2);
  const origin = anchor ?? { x: (vw - width) / 2, y: (vh - height) / 2 };
  const { x, y } = clampOverlayMenuPosition({
    ...origin,
    width,
    height,
    viewportWidth: vw,
    viewportHeight: vh,
    margin: POPUP_MARGIN,
    insets,
  });
  return { left: x, top: y, width, height };
}

function NodeRoleMark({ node }: { node: PaletteNode }) {
  return (
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
  );
}

/**
 * Unreal-style Add Node menu: a pointer-anchored popup with search, a
 * collapsible category tree, and Context Sensitive filtering for pin drags.
 */
export function NodePalette({
  open,
  onOpenChange,
  paletteNodes,
  onAddNode,
  filterPin = null,
  sourcePins,
  pinCompatibility,
  anchor,
}: NodePaletteProps) {
  const [search, setSearch] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Categories the user flipped from their default open state. */
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [contextSensitive, setContextSensitive] = useState(true);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinFiltered = Boolean(filterPin && contextSensitive);
  const searching = search.trim().length > 0;
  const coarse = isCoarsePointerEnvironment();
  const rowHeight = coarse ? NODE_PALETTE_TOUCH_ROW_HEIGHT : NODE_PALETTE_ROW_HEIGHT;

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setActiveKey(null);
    setToggled(new Set());
  }, [open]);

  const allNodes = useMemo(() => {
    const nodes = paletteNodes ?? [];
    return pinFiltered
      ? filterPaletteForPin(nodes, filterPin!, pinCompatibility, sourcePins)
      : nodes;
  }, [filterPin, paletteNodes, pinCompatibility, pinFiltered, sourcePins]);

  const filtered = useMemo(() => filterNodes(allNodes, search), [allNodes, search]);

  const rows = useMemo((): PaletteRow[] => {
    // Pin suggestions keep their relevance order instead of a category tree.
    if (pinFiltered) {
      return filtered.map((node) => ({ kind: "item", key: node.id, node, nested: false }));
    }
    const groups = new Map<string, PaletteNode[]>();
    for (const node of filtered) {
      const list = groups.get(node.category) ?? [];
      list.push(node);
      groups.set(node.category, list);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) =>
      humanizePropertyLabel(a).localeCompare(humanizePropertyLabel(b)),
    );
    const openByDefault = searching || sorted.length === 1;
    const result: PaletteRow[] = [];
    for (const [category, nodes] of sorted) {
      const expanded = toggled.has(category) ? !openByDefault : openByDefault;
      result.push({
        kind: "category",
        key: `category:${category}`,
        category,
        count: nodes.length,
        expanded,
      });
      if (!expanded) continue;
      for (const node of nodes) {
        result.push({ kind: "item", key: node.id, node, nested: true });
      }
    }
    return result;
  }, [filtered, pinFiltered, searching, toggled]);

  const activeIndex = rows.findIndex((row) => row.key === activeKey);
  const firstItemIndex = rows.findIndex((row) => row.kind === "item");

  if (!paletteNodes?.length) return null;

  const close = () => onOpenChange(false);
  const commit = (node: PaletteNode) => {
    onAddNode(node);
    close();
  };
  const toggleCategory = (category: string) => {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const activate = (row: PaletteRow) => {
    if (row.kind === "item") commit(row.node);
    else toggleCategory(row.category);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || rows.length === 0) return;
    const active = activeIndex >= 0 ? rows[activeIndex]! : null;
    let next = activeIndex;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(rows.length - 1, activeIndex + 1);
        break;
      case "ArrowUp":
        next = activeIndex < 0 ? rows.length - 1 : Math.max(0, activeIndex - 1);
        break;
      case "Home":
        if (activeIndex < 0) return;
        next = 0;
        break;
      case "End":
        if (activeIndex < 0) return;
        next = rows.length - 1;
        break;
      case "ArrowRight":
        if (active?.kind !== "category" || active.expanded) return;
        event.preventDefault();
        toggleCategory(active.category);
        return;
      case "ArrowLeft":
        if (!active) return;
        event.preventDefault();
        if (active.kind === "category") {
          if (active.expanded) toggleCategory(active.category);
          return;
        }
        if (active.nested) {
          setActiveKey(`category:${active.node.category}`);
        }
        return;
      case "Enter": {
        event.preventDefault();
        const target = active ?? (firstItemIndex >= 0 ? rows[firstItemIndex]! : null);
        if (target) activate(target);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    setActiveKey(rows[next]!.key);
  };

  const frame = open ? popupFrame(anchor) : null;
  const activeDescendant = activeIndex >= 0 ? rowId(listId, rows[activeIndex]!.key) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="node-palette"
        showCloseButton={false}
        overlayClassName="bg-transparent"
        initialFocus={(interaction) =>
          coarse && interaction !== "keyboard" ? bodyRef.current : searchRef.current
        }
        className="node-palette-popup flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-none"
        style={frame ?? undefined}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-2 pb-1.5">
          <DialogTitle className="text-sm">Add Node</DialogTitle>
          <label className="node-palette-context flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
            <Checkbox
              checked={contextSensitive}
              onCheckedChange={(checked) => setContextSensitive(checked === true)}
              data-testid="node-palette-context-sensitive"
            />
            Context Sensitive
          </label>
        </div>
        <div className="shrink-0 border-b px-2 pb-2">
          <SearchInput
            ref={searchRef}
            role="combobox"
            aria-label="Search Nodes"
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls={rows.length > 0 ? listId : undefined}
            aria-activedescendant={activeDescendant}
            value={search}
            onChange={(value) => {
              setSearch(value);
              setActiveKey(null);
              setToggled(new Set());
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search nodes"
            className="h-7 min-h-[var(--chrome-row,28px)]"
            data-testid="node-palette-search"
          />
        </div>
        <div
          ref={bodyRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-1 outline-none"
          style={{ overflowY: "auto" }}
          data-testid="node-palette-body"
        >
          {rows.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No matches</p>
          ) : (
            <div
              role="tree"
              id={listId}
              aria-label={pinFiltered ? "Suggested Nodes" : "Nodes"}
            >
              <WindowedList
                key={`${search}:${contextSensitive}`}
                itemCount={rows.length}
                rowHeight={rowHeight}
                activeIndex={activeIndex}
              >
                {(index) => {
                  const row = rows[index]!;
                  const active = row.key === activeKey;
                  if (row.kind === "category") {
                    return (
                      <div
                        role="treeitem"
                        id={rowId(listId, row.key)}
                        aria-expanded={row.expanded}
                        aria-selected={active}
                        aria-level={1}
                        tabIndex={-1}
                        data-active={active ? "true" : undefined}
                        data-testid={`node-palette-category-${row.category}`}
                        className="node-palette-row node-palette-category"
                        onClick={() => {
                          setActiveKey(row.key);
                          toggleCategory(row.category);
                        }}
                      >
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="node-palette-chevron"
                          data-expanded={row.expanded ? "true" : undefined}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {humanizePropertyLabel(row.category)}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.count}
                        </span>
                      </div>
                    );
                  }
                  const node = row.node;
                  return (
                    <div
                      role="treeitem"
                      id={rowId(listId, row.key)}
                      aria-selected={active}
                      aria-level={row.nested ? 2 : 1}
                      aria-description={node.description}
                      title={node.description}
                      tabIndex={-1}
                      data-active={active ? "true" : undefined}
                      data-nested={row.nested ? "true" : undefined}
                      data-testid={`node-palette-item-${node.id}`}
                      className="node-palette-row node-palette-item"
                      onClick={() => commit(node)}
                      onFocus={() => setActiveKey(row.key)}
                    >
                      <NodeRoleMark node={node} />
                      <span className="min-w-0 flex-1 truncate">{node.title}</span>
                      {row.nested ? null : (
                        <span className="truncate text-xs text-muted-foreground">
                          {humanizePropertyLabel(node.category)}
                        </span>
                      )}
                    </div>
                  );
                }}
              </WindowedList>
            </div>
          )}
        </div>
        <div className="node-palette-hints shrink-0 items-center gap-3 border-t px-2 py-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            Collapse / Expand
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd>
            Add
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
