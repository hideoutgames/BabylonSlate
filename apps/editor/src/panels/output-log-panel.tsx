import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Button } from "@babylonslate/ui/components/button";
import {
  PanelFrame,
  SelectableText,
  TREE_ROW_HEIGHT,
  WindowedList,
} from "@babylonslate/editor-kit";
import { useOutputLog } from "../context/play-context";
import { MessageDetails } from "../components/message-details";
import { useCoarsePointer } from "../shell/use-platform-layout";

export function OutputLogPanel(_props: IDockviewPanelProps) {
  void _props;
  const { lines } = useOutputLog();
  const coarsePointer = useCoarsePointer();
  const [selectedMessage, setSelectedMessage] = useState<string | null>(null);
  const selected = selectedMessage && lines.includes(selectedMessage) ? selectedMessage : null;
  return (
    <PanelFrame data-testid="output-log-panel">
      <ScrollArea className="min-h-0 flex-1 p-2">
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No log output yet.</p>
        ) : (
          <WindowedList itemCount={lines.length} rowHeight={coarsePointer ? 44 : TREE_ROW_HEIGHT}>
            {(index) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="output-log-line"
                className="h-full min-h-0 w-full justify-start rounded-none px-1 font-mono text-xs touch-pan-y"
                onClick={() => setSelectedMessage(lines[index] ?? null)}
              >
                <SelectableText className="truncate">{lines[index]}</SelectableText>
              </Button>
            )}
          </WindowedList>
        )}
      </ScrollArea>
      {selected ? <MessageDetails title="Log Details" message={selected} onClose={() => setSelectedMessage(null)} /> : null}
    </PanelFrame>
  );
}
