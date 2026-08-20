import type { IDockviewPanelProps } from "dockview-react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import {
  PanelFrame,
  SelectableText,
  TREE_ROW_HEIGHT,
  WindowedList,
} from "@babylonslate/editor-kit";
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
          <WindowedList itemCount={lines.length} rowHeight={TREE_ROW_HEIGHT}>
            {(index) => (
              <li
                data-testid="output-log-line"
                className="flex h-full items-center font-mono text-xs"
              >
                <SelectableText className="truncate">{lines[index]}</SelectableText>
              </li>
            )}
          </WindowedList>
        )}
      </ScrollArea>
    </PanelFrame>
  );
}
