import { useMemo, useSyncExternalStore } from "react";
import { DebugConsole, type DebugConsoleProps } from "./debug-console";
import type { InspectWorldStore } from "../lib/inspect-world-store";
import { playConsoleCompletionContext } from "../lib/play-console";

export type PlayDebugConsoleProps = Omit<DebugConsoleProps, "completionContext"> & {
  /** The polled inspect snapshot, whose actors the console completes. */
  inspectStore: InspectWorldStore;
  sceneAssetGuid?: string;
  scene?: { name?: string };
  scenes?: ReadonlyArray<{ guid: string; scene: { name?: string } }>;
};

/**
 * The Play console with completion fed by the live inspect snapshot. It
 * subscribes to the snapshot's actors itself, so the Play overlay does not
 * re-render for each poll and the console re-renders only when an actor
 * appears, disappears or is renamed.
 */
export function PlayDebugConsole({
  inspectStore,
  sceneAssetGuid,
  scene,
  scenes,
  ...consoleProps
}: PlayDebugConsoleProps) {
  const actors = useSyncExternalStore(inspectStore.subscribe, inspectStore.getActors);
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
  return <DebugConsole {...consoleProps} completionContext={completionContext} />;
}
