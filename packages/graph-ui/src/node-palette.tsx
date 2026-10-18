import { useCallback, useMemo, useState } from "react";
import {
  CATALOG_MENU_ROW_HEIGHT,
  CATALOG_MENU_TOUCH_ROW_HEIGHT,
  CatalogMenu,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { cn } from "@babylonslate/ui/lib/utils";
import type { PaletteNode, SerializedPin } from "./graph-types";
import {
  filterPaletteForPin,
  type PinCompatibilityRule,
} from "./graph-connect";
import { nodeRoleClass, nodeVisualRole } from "./node-theme";

/** Desktop rows match `--chrome-row`; coarse pointers use `--touch-target`. */
export const NODE_PALETTE_ROW_HEIGHT = CATALOG_MENU_ROW_HEIGHT;
export const NODE_PALETTE_TOUCH_ROW_HEIGHT = CATALOG_MENU_TOUCH_ROW_HEIGHT;

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
  /** `modal` fills the viewport like other large catalogs and ignores `anchor`. */
  presentation?: "popup" | "modal";
}

const compact = (text: string) => text.toLowerCase().replace(/\s+/g, "");
const wordsOf = (text: string) =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const startsAnyWord = (words: readonly string[], word: string) =>
  words.some((candidate) => candidate.startsWith(word));

/** Search tiers, best first; a node outside every tier is dropped. */
const MATCH = {
  exactTitle: 0,
  titlePrefix: 1,
  wordPrefixes: 2,
  wordsInTitle: 3,
  alias: 4,
  detail: 5,
} as const;

/**
 * Ranks nodes for a typed query: exact title, title prefix, every query word
 * starting a title word, every query word inside the title (any order), alias,
 * then category or description. Stable within a tier by catalog order.
 */
function filterNodes(nodes: PaletteNode[], query: string): PaletteNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const formula = compact(needle);
  const symbolsOnly = /^[^\p{L}\p{N}\s]+$/u.test(formula);
  const queryWords = needle.split(/\s+/);

  const tierOf = (node: PaletteNode): number | null => {
    if (!symbolsOnly) {
      // Spaces are optional against the Title Case title, so `BeginPlay`
      // finds Event Begin Play.
      const title = compact(node.title);
      if (title === formula) return MATCH.exactTitle;
      if (title.startsWith(formula)) return MATCH.titlePrefix;
      const titleWords = wordsOf(node.title);
      if (queryWords.every((word) => startsAnyWord(titleWords, word))) {
        return MATCH.wordPrefixes;
      }
      if (queryWords.every((word) => title.includes(word))) return MATCH.wordsInTitle;
    }
    const aliasMatch = node.searchAliases?.some((alias) => {
      const normalized = compact(alias);
      return symbolsOnly ? normalized === formula : normalized.includes(formula);
    });
    if (aliasMatch) return MATCH.alias;
    if (symbolsOnly) return null;
    const detail = `${node.title} ${node.category} ${humanizePropertyLabel(node.category)} ${node.description ?? ""}`.toLowerCase();
    if (detail.includes(needle)) return MATCH.detail;
    if (queryWords.length > 1) {
      const detailWords = wordsOf(detail);
      if (queryWords.every((word) => startsAnyWord(detailWords, word))) return MATCH.detail;
    }
    return null;
  };

  const ranked: Array<{ node: PaletteNode; tier: number; order: number }> = [];
  nodes.forEach((node, order) => {
    const tier = tierOf(node);
    if (tier !== null) ranked.push({ node, tier, order });
  });
  return ranked
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .map((entry) => entry.node);
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
            particleRole:
              typeof node.defaultData?.__particleRole === "string"
                ? node.defaultData.__particleRole
                : undefined,
          }),
        ),
      )}
      aria-hidden="true"
    />
  );
}

/**
 * Unreal-style Add Node menu: a pointer-anchored popup with search, a
 * collapsible category tree, and Context Sensitive filtering. With a dragged
 * pin the list is pin-compatible rows; without one it hides `outOfContext`
 * rows (members reached only through a Target on another object).
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
  presentation = "popup",
}: NodePaletteProps) {
  const [contextSensitive, setContextSensitive] = useState(true);
  const pinFiltered = Boolean(filterPin && contextSensitive);

  const allNodes = useMemo(() => {
    const nodes = paletteNodes ?? [];
    if (pinFiltered) {
      return filterPaletteForPin(nodes, filterPin!, pinCompatibility, sourcePins);
    }
    return contextSensitive
      ? nodes.filter((node) => node.outOfContext !== true)
      : nodes;
  }, [contextSensitive, filterPin, paletteNodes, pinCompatibility, pinFiltered, sourcePins]);

  const filterItems = useCallback(
    (nodes: readonly PaletteNode[], query: string) => filterNodes([...nodes], query),
    [],
  );

  if (!paletteNodes?.length) return null;

  return (
    <CatalogMenu
      open={open}
      onOpenChange={onOpenChange}
      title="Add Node"
      items={allNodes}
      onSelect={onAddNode}
      anchor={anchor}
      presentation={presentation}
      filterItems={filterItems}
      rankedSearch
      flat={pinFiltered}
      renderLeading={(node) => <NodeRoleMark node={node} />}
      headerAccessory={
        <label className="node-palette-context flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
          <Checkbox
            checked={contextSensitive}
            onCheckedChange={(checked) => setContextSensitive(checked === true)}
            data-testid="node-palette-context-sensitive"
          />
          Context Sensitive
        </label>
      }
      searchLabel="Search Nodes"
      searchPlaceholder="Search nodes"
      treeLabel={pinFiltered ? "Suggested Nodes" : "Nodes"}
      listKey={String(contextSensitive)}
      data-testid="node-palette"
    />
  );
}
