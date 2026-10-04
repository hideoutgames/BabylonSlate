import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import { CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Button } from "@babylonslate/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@babylonslate/ui/components/empty";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  PanelFrame,
  SelectableText,
  TREE_ROW_HEIGHT,
  WindowedList,
} from "@babylonslate/editor-kit";
import { useOutputLog } from "../context/play-context";
import { MessageDetails } from "../components/message-details";
import { parseOutputLogLine } from "../lib/output-log-line";
import { useCoarsePointer } from "../shell/use-platform-layout";

export function OutputLogPanel(_props: IDockviewPanelProps) {
  void _props;
  const { lines } = useOutputLog();
  const coarsePointer = useCoarsePointer();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<string | null>(null);
  const selected = selectedMessage && lines.includes(selectedMessage) ? selectedMessage : null;
  return (
    <PanelFrame data-testid="output-log-panel">
      {lines.length === 0 ? (
        <Empty>
          <EmptyTitle>No Log Output</EmptyTitle>
          <EmptyDescription>Engine and Play messages appear here.</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 py-1">
          <WindowedList itemCount={lines.length} rowHeight={coarsePointer ? 44 : TREE_ROW_HEIGHT}>
            {(index) => {
              const line = lines[index] ?? "";
              const entry = parseOutputLogLine(line);
              const isSelected = selected !== null && selectedIndex === index && lines[index] === selected;
              return (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="output-log-line"
                  data-severity={entry.severity}
                  aria-pressed={isSelected}
                  className={cn(
                    "h-full min-h-0 w-full justify-start gap-2 rounded-none px-2 font-mono text-[11px] font-normal touch-pan-y",
                    index % 2 === 1 && "bg-list-stripe",
                    entry.severity === "error" && "bg-destructive/6 text-destructive hover:bg-destructive/10 hover:text-destructive",
                    entry.severity === "warning" && "bg-(--warning)/8 text-(--warning) hover:bg-(--warning)/12 hover:text-(--warning)",
                    isSelected && "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={() => {
                    setSelectedIndex(index);
                    setSelectedMessage(line);
                  }}
                >
                  {entry.severity === "error" ? (
                    <CircleXIcon aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
                  ) : entry.severity === "warning" ? (
                    <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-(--warning)" />
                  ) : (
                    <span aria-hidden="true" className="size-3.5 shrink-0" />
                  )}
                  {entry.source ? (
                    <span className="shrink-0 rounded-sm bg-muted px-1 font-sans text-[10px] leading-4 font-medium text-muted-foreground">
                      {entry.source}
                    </span>
                  ) : null}
                  <SelectableText className={cn("truncate", entry.severity === "info" && "text-foreground")}>
                    {entry.message}
                  </SelectableText>
                </Button>
              );
            }}
          </WindowedList>
        </ScrollArea>
      )}
      {selected ? <MessageDetails title="Log Details" message={selected} onClose={() => setSelectedMessage(null)} /> : null}
    </PanelFrame>
  );
}
