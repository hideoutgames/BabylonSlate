import type { IDockviewPanelProps } from "dockview-react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { PanelFrame, SelectableText } from "@babylonslate/editor-kit";
import { useOutputLog } from "../context/play-context";

export function OutputLogPanel(_props: IDockviewPanelProps) {
  void _props;
  const { lines } = useOutputLog();
  return (
    <PanelFrame data-testid="output-log-panel">
      <ScrollArea className="flex-1 p-2">
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No log output yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {lines.map((line, i) => (
              <li key={`${i}-${line}`}>
                <SelectableText>{line}</SelectableText>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </PanelFrame>
  );
}
