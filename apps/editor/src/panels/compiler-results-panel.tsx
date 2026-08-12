import type { IDockviewPanelProps } from "dockview-react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Card } from "@babylonslate/ui/components/card";
import { SelectableText } from "@babylonslate/editor-kit";
import { useValidation } from "../context/validation-context";
import { usePlay } from "../context/play-context";

export function CompilerResultsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { diagnostics, setFocusDiagnostic } = useValidation();
  const { clearFocusedNode } = usePlay();

  const grouped = new Map<string, typeof diagnostics>();
  for (const d of diagnostics) {
    const list = grouped.get(d.graphId) ?? [];
    list.push(d);
    grouped.set(d.graphId, list);
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2" data-testid="compiler-results">
      <div className="text-sm font-medium text-foreground">Compiler Results</div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 pr-2">
          {diagnostics.length === 0 ? (
            <p className="text-sm text-muted-foreground">No diagnostics.</p>
          ) : (
            [...grouped.entries()].map(([graphId, list]) => (
              <Card key={graphId} className="gap-1 p-3">
                <div className="text-xs font-medium text-muted-foreground">
                  {graphId}
                </div>
                {list.map((d, i) => (
                  <button
                    key={`${d.code}-${d.nodeId ?? ""}-${i}`}
                    type="button"
                    className="flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left hover:bg-muted"
                    data-testid="compiler-result-row"
                    onClick={() => {
                      clearFocusedNode();
                      setFocusDiagnostic(d);
                    }}
                  >
                    <span
                      className={
                        d.severity === "error"
                          ? "text-sm text-destructive"
                          : "text-sm text-foreground"
                      }
                    >
                      {d.severity}: {d.code}
                    </span>
                    <SelectableText className="text-xs text-muted-foreground">
                      {d.message}
                      {d.nodeId ? ` @ ${d.nodeId}` : ""}
                      {d.pinId ? `.${d.pinId}` : ""}
                    </SelectableText>
                  </button>
                ))}
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
