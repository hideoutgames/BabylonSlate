import type { IDockviewPanelProps } from "dockview-react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Card } from "@babylonslate/ui/components/card";
import { Button } from "@babylonslate/ui/components/button";
import { PanelFrame, SelectableText } from "@babylonslate/editor-kit";
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
    <PanelFrame data-testid="compiler-results">
      <ScrollArea className="min-h-0 flex-1 p-2">
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
                  <Button
                    key={`${d.code}-${d.nodeId ?? ""}-${i}`}
                    type="button"
                    variant="ghost"
                    size="touch"
                    className="h-auto w-full flex-col items-start justify-center gap-0.5 px-2 py-2 text-left"
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
                  </Button>
                ))}
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelFrame>
  );
}
