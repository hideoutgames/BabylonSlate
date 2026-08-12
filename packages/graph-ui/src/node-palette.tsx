import { useMemo, useState } from "react";
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
      <button
        type="button"
        className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-card-foreground shadow-sm touch-manipulation"
        onClick={() => setOpen(true)}
      >
        Add node
      </button>

      {open ? (
        <div
          className="absolute inset-0 z-20 bg-background/60"
          role="presentation"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <div
        className={`absolute inset-x-0 bottom-0 z-30 max-h-[min(70vh,28rem)] transform rounded-t-xl border border-border bg-card shadow-lg transition-transform duration-200 ${
          open ? "translate-y-0" : "translate-y-full pointer-events-none"
        }`}
        role="dialog"
        aria-label="Node palette"
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-card-foreground">
            Node palette
          </h2>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm text-muted-foreground touch-manipulation"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {grouped.map(([category, nodes]) => (
            <section key={category} className="mb-4 last:mb-0">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {category}
              </h3>
              <div className="flex flex-col gap-2">
                {nodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className="rounded-lg border border-border bg-background px-3 py-2 text-left text-sm text-foreground touch-manipulation hover:bg-accent"
                    onClick={() => {
                      onAddNode(node);
                      setOpen(false);
                    }}
                  >
                    {node.title}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
