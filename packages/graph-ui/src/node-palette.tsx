import { useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@babylonslate/ui/components/sheet";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Button } from "@babylonslate/ui/components/button";
import type { PaletteNode } from "./graph-types";

export interface NodePaletteProps {
  paletteNodes?: PaletteNode[];
  onAddNode: (node: PaletteNode) => void;
}

export function NodePalette({ paletteNodes, onAddNode }: NodePaletteProps) {
  const [open, setOpen] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, PaletteNode[]>();
    for (const node of paletteNodes ?? []) {
      const list = map.get(node.category) ?? [];
      list.push(node);
      map.set(node.category, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [paletteNodes]);

  if (!paletteNodes?.length) return null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 touch-manipulation"
        onClick={() => setOpen(true)}
      >
        Add node
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[min(70vh,28rem)]">
          <SheetHeader>
            <SheetTitle>Node palette</SheetTitle>
          </SheetHeader>
          <ScrollArea className="max-h-[min(55vh,22rem)] pr-2">
            {grouped.map(([category, nodes]) => (
              <section key={category} className="mb-4 last:mb-0">
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
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
}
