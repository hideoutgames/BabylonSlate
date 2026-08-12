import { useMemo, useState } from "react";
import { CatalogDialog } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import type { PaletteNode } from "./graph-types";

export interface NodePaletteProps {
  paletteNodes?: PaletteNode[];
  onAddNode: (node: PaletteNode) => void;
}

function filterNodes(nodes: PaletteNode[], query: string): PaletteNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter((node) =>
    `${node.title} ${node.category}`.toLowerCase().includes(needle),
  );
}

export function NodePalette({ paletteNodes, onAddNode }: NodePaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");

  const allNodes = useMemo(() => paletteNodes ?? [], [paletteNodes]);

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

  if (!allNodes.length) return null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        className="absolute bottom-4 left-1/2 z-10 min-h-[var(--touch-target,44px)] -translate-x-1/2 touch-manipulation"
        onClick={() => {
          setSearch("");
          setActiveCategory("all");
          setOpen(true);
        }}
        data-testid="add-node-button"
      >
        Add node
      </Button>

      <CatalogDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setSearch("");
            setActiveCategory("all");
          }
        }}
        title="Add node"
        categories={categories}
        activeCategoryId={activeCategory}
        onCategoryChange={setActiveCategory}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search nodes"
        autoFocusSearch
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
                      className="h-auto min-h-[var(--touch-target,44px)] justify-start touch-manipulation"
                      data-testid={`node-palette-item-${node.id}`}
                      onClick={() => {
                        onAddNode(node);
                        setOpen(false);
                      }}
                    >
                      {node.title}
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </CatalogDialog>
    </>
  );
}
