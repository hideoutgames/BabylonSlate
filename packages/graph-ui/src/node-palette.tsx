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
