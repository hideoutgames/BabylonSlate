import { useSyncExternalStore } from "react";
import { Trash2Icon } from "lucide-react";
import { BREAKPOINT_PAUSE_CODE } from "@haptic/bridge";
import {
  PanelFrame,
  ShortcutKeys,
  TREE_ROW_HEIGHT,
  useTouchUi,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Checkbox } from "@haptic/ui/components/checkbox";
import { Empty, EmptyDescription, EmptyTitle } from "@haptic/ui/components/empty";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { useBreakpointStore } from "../context/breakpoints-context";
import { useKeybindChord } from "../context/keybind-context";
import { usePlay } from "../context/play-context";
import { IconActionButton } from "../components/icon-action-button";
import type { BreakpointEntry } from "../services/breakpoint-store";

const NO_BREAKPOINTS: readonly BreakpointEntry[] = [];
const unsubscribed = () => () => {};
const noBreakpoints = () => NO_BREAKPOINTS;

/**
 * Every node breakpoint of the project, including those in assets that are not open: switch one
 * on or off, remove it, or open its node. Set them from a node's menu or the Toggle Breakpoint key.
 */
export function BreakpointsPanel() {
  const store = useBreakpointStore();
  const breakpoints = useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.list ?? noBreakpoints);
  const { openSessionSource } = usePlay();
  const touch = useTouchUi();
  const toggleChord = useKeybindChord("graph.toggleBreakpoint");
  const anyEnabled = breakpoints.some((entry) => entry.enabled);
  const anyDisabled = breakpoints.some((entry) => !entry.enabled);

  return (
    <PanelFrame
      data-testid="breakpoints-panel"
      toolbar={
        <>
          <Button size="sm" variant="outline" disabled={!anyDisabled} onClick={() => store?.setAllEnabled(true)}>
            Enable All
          </Button>
          <Button size="sm" variant="outline" disabled={!anyEnabled} onClick={() => store?.setAllEnabled(false)}>
            Disable All
          </Button>
          <Button size="sm" variant="outline" disabled={breakpoints.length === 0} onClick={() => store?.removeAll()}>
            Remove All
          </Button>
        </>
      }
    >
      {breakpoints.length === 0 ? (
        <Empty>
          <EmptyTitle>No Breakpoints</EmptyTitle>
          <EmptyDescription>
            Add one from a node&apos;s menu in a Class graph or a Behaviour Tree
            {toggleChord ? <>, or select the node and press <ShortcutKeys chord={toggleChord} /></> : null}.
            A Simulation or Play stops at the end of the tick that reaches it.
          </EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 pb-1">
          <WindowedList itemCount={breakpoints.length} rowHeight={touch ? WINDOWED_LIST_TOUCH_ROW_HEIGHT : TREE_ROW_HEIGHT}>
            {(index) => {
              const entry = breakpoints[index]!;
              const { className, graphName, nodeTitle } = entry.label;
              return (
                <div className="flex h-full items-center gap-1 border-b border-border px-2" data-testid="breakpoint-row">
                  <Checkbox
                    checked={entry.enabled}
                    aria-label={`${nodeTitle} Enabled`}
                    onCheckedChange={(enabled) => store?.setEnabled(entry, enabled === true)}
                  />
                  <Button
                    variant="ghost"
                    size="touch"
                    className="min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal"
                    title={`${className} › ${graphName} › ${nodeTitle}`}
                    onClick={() => void openSessionSource({
                      severity: "info",
                      code: BREAKPOINT_PAUSE_CODE,
                      message: "Breakpoint",
                      assetGuid: entry.assetGuid,
                      graphId: entry.graphId,
                      nodeId: entry.nodeId,
                    })}
                  >
                    <span className="truncate">{nodeTitle}</span>
                    <span className="truncate text-xs text-muted-foreground">{className} › {graphName}</span>
                  </Button>
                  <IconActionButton
                    label="Remove Breakpoint"
                    variant="ghost"
                    size="touch-icon"
                    onClick={() => store?.remove(entry)}
                  >
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
