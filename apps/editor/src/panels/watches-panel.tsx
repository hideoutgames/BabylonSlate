import { useSyncExternalStore } from "react";
import { Trash2Icon } from "lucide-react";
import {
  PanelFrame,
  TREE_ROW_HEIGHT,
  useTouchUi,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@haptic/ui/components/empty";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { cn } from "@haptic/ui/lib/utils";
import { IconActionButton } from "../components/icon-action-button";
import { useGraphDebugStore } from "../context/graph-debug-context";
import { useWatchStore } from "../context/watch-store-context";
import { useWatchReadings, watchReadingText } from "../lib/watch-readings";
import type { WatchEntry } from "../services/watch-store";

const NO_WATCHES: readonly WatchEntry[] = [];
const unsubscribed = () => () => {};
const noWatches = () => NO_WATCHES;

function watchName(entry: WatchEntry): { name: string; context: string } {
  return entry.kind === "pin"
    ? { name: entry.label.pinName, context: `${entry.label.className} › ${entry.label.graphName} › ${entry.label.nodeTitle}` }
    : { name: entry.name, context: `${entry.label.className} › Variable` };
}

/**
 * The project's watches: pins and Class variables whose value the followed object last had. Values
 * show while a Simulation, or stopped Play, debugs the watch's Class, and hold while it is paused.
 */
export function WatchesPanel() {
  const store = useWatchStore();
  const debug = useGraphDebugStore();
  const watches = useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.list ?? noWatches);
  const readings = useWatchReadings(watches, debug);
  const touch = useTouchUi();

  return (
    <PanelFrame
      data-testid="watches-panel"
      toolbar={
        <Button size="sm" variant="outline" disabled={watches.length === 0} onClick={() => store?.removeAll()}>
          Remove All
        </Button>
      }
    >
      {watches.length === 0 ? (
        <Empty>
          <EmptyTitle>No Watches</EmptyTitle>
          <EmptyDescription>
            Choose Watch Pin in a Class graph node&apos;s menu, or Add Watch in a variable&apos;s menu in the Class
            panel. Values show while a Simulation, or Play stopped in the editor, debugs that Class.
          </EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 pb-1">
          <WindowedList itemCount={watches.length} rowHeight={touch ? WINDOWED_LIST_TOUCH_ROW_HEIGHT : TREE_ROW_HEIGHT}>
            {(index) => {
              const entry = watches[index]!;
              const reading = readings[index] ?? { kind: "notDebugged" };
              const { name, context } = watchName(entry);
              const text = watchReadingText(reading);
              return (
                <div className="flex h-full items-center gap-2 border-b border-border px-2" data-testid="watch-row">
                  <span className="min-w-0 shrink truncate text-sm" title={`${context} › ${name}`}>{name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{context}</span>
                  <span
                    className={cn("max-w-[50%] shrink-0 truncate text-xs", reading.kind === "value" ? "font-mono" : "text-muted-foreground")}
                    title={text}
                    data-testid="watch-value"
                  >
                    {text}
                  </span>
                  <IconActionButton label="Remove Watch" variant="ghost" size="touch-icon" onClick={() => store?.remove(entry)}>
                    <Trash2Icon />
                  </IconActionButton>
                </div>
              );
            }}
          </WindowedList>
        </ScrollArea>
      )}
    </PanelFrame>
  );
}
