import { isEditorOnlyAsset, type SerializedGraph } from "@babylonslate/core";
import type { ScriptHost } from "@babylonslate/runtime";
import { classIdForGraphPath } from "../services/script-compiler";

export const EDITOR_UTILITY_EVENTS = {
  beginPlay: "onEditorBeginPlay",
  startup: "onEditorStartup",
  sceneOpen: "onSceneOpen",
  sceneSaved: "onSceneSaved",
  shutdown: "onEditorShutdown",
} as const;

export const EDITOR_UTILITY_LIFECYCLE_EVENT =
  "babylonslate:editor-utility-lifecycle";

export function emitEditorUtilityLifecycle(event: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(EDITOR_UTILITY_LIFECYCLE_EVENT, { detail: { event } }),
  );
}

export function selectEditorUtilityGraphs(
  graphs: ReadonlyArray<{ path: string; content: SerializedGraph }>,
  options: {
    headers: Record<string, { type: string; parentClass?: string | null }>;
    parentOf: (id: string) => string | null | undefined;
    registeredClassIds: readonly string[];
  },
): Array<{ path: string; content: SerializedGraph }> {
  const registered = new Set(
    options.registeredClassIds.map((id) => id.trim()).filter(Boolean),
  );
  return graphs.filter((graph) => {
    const header = options.headers[graph.path];
    if (!header) return false;
    if (!isEditorOnlyAsset(header, options.parentOf)) return false;
    // Class pickers register path class ids, so a display name never matches.
    return registered.has(classIdForGraphPath(graph.path));
  });
}

export function fireEditorUtilityEvent(
  host: Pick<ScriptHost, "classIds" | "invokeEvent">,
  event: string,
): void {
  for (const classId of host.classIds()) {
    host.invokeEvent(classId, event);
  }
}

/** Events to fire after the in-process host loads registered EUO graphs. */
export function editorUtilityBootEvents(hasOpenScene: boolean): string[] {
  const events: string[] = [
    EDITOR_UTILITY_EVENTS.beginPlay,
    EDITOR_UTILITY_EVENTS.startup,
  ];
  if (hasOpenScene) events.push(EDITOR_UTILITY_EVENTS.sceneOpen);
  return events;
}

export function shutdownEditorUtilityHost(
  host: Pick<ScriptHost, "classIds" | "invokeEvent"> | null,
  started: boolean,
): void {
  if (!host || !started) return;
  fireEditorUtilityEvent(host, EDITOR_UTILITY_EVENTS.shutdown);
}
