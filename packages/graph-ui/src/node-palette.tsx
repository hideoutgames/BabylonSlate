import { useMemo, useState } from "react";
import { CatalogDialog } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";
import type { PaletteNode, SerializedPin } from "./graph-types";
import { filterPaletteForPin } from "./graph-connect";
import { nodeRoleClass, nodeVisualRole } from "./node-theme";

export interface NodePaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paletteNodes?: PaletteNode[];
  onAddNode: (node: PaletteNode) => void;
  /** When set, only nodes with a compatible opposite pin are listed. */
  filterPin?: SerializedPin | null;
}

function filterNodes(nodes: PaletteNode[], query: string): PaletteNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter((node) =>
    `${node.title} ${node.category}`.toLowerCase().includes(needle),
  );
}

export function NodePalette({
  open,
  onOpenChange,
  paletteNodes,
  onAddNode,
  filterPin = null,
}: NodePaletteProps) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");

  const allNodes = useMemo(() => {
    const nodes = paletteNodes ?? [];
    return filterPin ? filterPaletteForPin(nodes, filterPin) : nodes;
  }, [filterPin, paletteNodes]);

  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of allNodes) {
      map.set(node.category, (map.get(node.category) ?? 0) + 1);
    }
    const listed = [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, count]) => ({ id, label: id, count }));
    return [{ id: "all", label: "All", count: allNodes.length }, ...listed];
  }, [allNodes]);

  const filtered = useMemo(() => {
    const bySearch = filterNodes(allNodes, search);
    if (activeCategory === "all") return bySearch;
    return bySearch.filter((node) => node.category === activeCategory);
  }, [activeCategory, allNodes, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, PaletteNode[]>();
    for (const node of filtered) {
      const list = map.get(node.category) ?? [];
      list.push(node);
      map.set(node.category, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

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
      title={filterPin ? "Add node" : "Add node"}
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={setActiveCategory}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search nodes"
      data-testid="node-palette"
    >
      {grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches</p>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map(([category, nodes]) => (
            <section key={category}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {category}
              </h3>
              <div className="flex flex-col gap-2">
                {nodes.map((node) => (
                  <Button
                    key={node.id}
                    type="button"
                    variant="outline"
                    className="h-auto min-h-[var(--touch-target,44px)] justify-start gap-2 touch-manipulation"
                    data-testid={`node-palette-item-${node.id}`}
                    onClick={() => {
                      onAddNode(node);
                      onOpenChange(false);
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
                    {node.title}
                  </Button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </CatalogDialog>
  );
}
