import { useMemo, useSyncExternalStore } from "react";
import { DebugConsole, type DebugConsoleProps } from "./debug-console";
import type { InspectWorldStore } from "../lib/inspect-world-store";
import { playConsoleCompletionContext } from "../lib/play-console";
import {
  useShownDebugConsoleLogs,
  type DebugConsoleLogFeed,
} from "../lib/use-debug-console-logs";

const NO_LOGS: readonly never[] = [];
const NO_LOG_FEED: DebugConsoleLogFeed = {
  push: () => {},
  subscribe: () => () => {},
  getSnapshot: () => NO_LOGS,
};

export type PlayDebugConsoleProps = Omit<DebugConsoleProps, "completionContext" | "logs"> & {
  /** The session's lines; read here, so a flush re-renders only this console. */
  logFeed?: DebugConsoleLogFeed;
  /** The polled inspect snapshot, whose actors the console completes. */
  inspectStore: InspectWorldStore;
  sceneAssetGuid?: string;
  scene?: { name?: string };
  scenes?: ReadonlyArray<{ guid: string; scene: { name?: string } }>;
};

/**
 * The Play console with completion fed by the live inspect snapshot. It
 * subscribes to the snapshot's actors and the session's lines itself, so the
 * Play overlay does not re-render for each poll or printed line; the console
 * re-renders only when an actor appears, disappears or is renamed, or, while
 * it is open, when lines arrive.
 */
export function PlayDebugConsole({
  logFeed = NO_LOG_FEED,
  inspectStore,
  sceneAssetGuid,
  scene,
  scenes,
  ...consoleProps
}: PlayDebugConsoleProps) {
  const actors = useSyncExternalStore(inspectStore.subscribe, inspectStore.getActors);
  const logs = useShownDebugConsoleLogs(logFeed, consoleProps.open);
  const { commands } = consoleProps;
  const completionContext = useMemo(
    () =>
      playConsoleCompletionContext({
        commands,
        sceneAssetGuid,
        scene,
        scenes,
        inspectNodes: actors,
      }),
    [commands, sceneAssetGuid, scene, scenes, actors],
  );
  return <DebugConsole {...consoleProps} logs={logs} completionContext={completionContext} />;
}
