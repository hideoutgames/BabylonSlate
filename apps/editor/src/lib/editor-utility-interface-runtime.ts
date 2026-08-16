import { ScriptHost, type ScriptHostServices } from "@babylonslate/runtime";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { UiWidgetEvent } from "@babylonslate/render";
import { logicGraphFromUiPayload } from "./play-content";
import { compileGraphDocuments } from "../services/script-compiler";

export function compileEditorUtilityInterfaceLogic(
  path: string,
  payload: unknown,
): ScriptBundleEntry[] {
  const graph = logicGraphFromUiPayload(path, payload);
  if (!graph || graph.content.nodes.length === 0) return [];
  return compileGraphDocuments([
    { path: graph.path, content: graph.content, parentClassId: "BObject" },
  ]);
}

export function createEditorUtilityInterfaceHost(
  options: {
    log?: ScriptHostServices["log"];
    setWidgetVisible?: ScriptHostServices["setWidgetVisible"];
  } = {},
): {
  loadAll: (scripts: readonly ScriptBundleEntry[]) => Promise<void>;
  beginPlay: () => void;
  tick: () => void;
  dispose: () => void;
  host: ScriptHost;
} {
  const host = new ScriptHost({
    log:
      options.log ??
      ((_severity, _category, message) => {
        console.info(message);
      }),
    print: (message) => {
      options.log?.("log", "Print", String(message));
    },
    destroyActor: () => {},
    executeConsoleCommand: () => ({
      success: false,
      output: "Console commands are not available in the editor ScriptHost.",
    }),
    delay: (seconds) =>
      new Promise((resolve) => {
        window.setTimeout(resolve, Math.max(0, seconds) * 1000);
      }),
    reportError: (error) => {
      console.error(error);
    },
    setWidgetVisible: options.setWidgetVisible,
  });
  return {
    host,
    async loadAll(scripts) {
      for (const script of scripts) {
        await host.load(script);
      }
    },
    beginPlay() {
      for (const classId of host.classIds()) {
        host.invokeEvent(classId, "onBeginPlay");
      }
    },
    tick() {
      for (const classId of host.classIds()) {
        host.invokeEvent(classId, "onTick");
      }
    },
    dispose() {
      for (const classId of host.classIds()) {
        host.invokeEvent(classId, "onEndPlay");
      }
    },
  };
}

export function bindEditorUtilityWidgetEvent(
  host: Pick<ScriptHost, "classIds" | "invokeEvent">,
  event: UiWidgetEvent,
): void {
  const name =
    event.kind === "click"
      ? "onWidgetClick"
      : event.kind === "value"
        ? "onWidgetValue"
        : event.kind === "checked"
          ? "onWidgetChecked"
          : "onWidgetText";
  const args = { widgetId: event.widgetId, value: "value" in event ? event.value : undefined };
  for (const classId of host.classIds()) {
    host.invokeEvent(classId, name, null, args);
  }
}
