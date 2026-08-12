import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
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

  const allNodes = paletteNodes ?? [];

  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of allNodes) {
      map.set(node.category, (map.get(node.category) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, count]) => ({ id, label: id, count }));
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
        className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 touch-manipulation"
        onClick={() => {
          setSearch("");
          setActiveCategory("all");
          setOpen(true);
        }}
        data-testid="add-node-button"
      >
        Add node
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setSearch("");
            setActiveCategory("all");
          }
        }}
      >
        <DialogContent
          data-testid="node-palette-dialog"
          className="flex h-[min(90vh,52rem)] w-[min(96vw,64rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
            <DialogTitle>Add node</DialogTitle>
          </DialogHeader>
          <div className="shrink-0 border-b px-4 py-3">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search nodes"
              className="min-h-11"
              data-testid="node-palette-search"
              autoFocus
            />
          </div>
          <div className="flex min-h-0 flex-1">
            <nav
              className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 sm:w-52"
              data-testid="node-palette-categories"
            >
              <Button
                type="button"
                size="sm"
                variant={activeCategory === "all" ? "secondary" : "ghost"}
                className="min-h-11 justify-between"
                onClick={() => setActiveCategory("all")}
                data-testid="node-palette-category-all"
              >
                <span>All</span>
                <span className="text-xs text-muted-foreground">
                  {allNodes.length}
                </span>
              </Button>
              {categories.map((category) => (
                <Button
                  key={category.id}
                  type="button"
                  size="sm"
                  variant={
                    activeCategory === category.id ? "secondary" : "ghost"
                  }
                  className="min-h-11 justify-between capitalize"
                  onClick={() => setActiveCategory(category.id)}
                  data-testid={`node-palette-category-${category.id}`}
                >
                  <span className="truncate">{category.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {category.count}
                  </span>
                </Button>
              ))}
            </nav>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-4 p-4">
                {grouped.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No matches</p>
                ) : (
                  grouped.map(([category, nodes]) => (
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
                            className="h-auto min-h-11 justify-start touch-manipulation"
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
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
