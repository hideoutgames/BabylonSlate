import { userInterfaceClassId, type SerializedGraph } from "@babylonslate/core";
import { ScriptHost, type ScriptHostServices } from "@babylonslate/runtime";
import { ClassRegistry } from "@babylonslate/object-model";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import { uiWidgetEventExport } from "@babylonslate/bridge";
import type { UiWidgetEvent } from "@babylonslate/render";
import { asUiDocument, logicGraphFromUiPayload } from "./play-content";
import { compileGraphDocuments } from "../services/script-compiler";

export type NestedUtilityLogicSource = {
  slotId: string;
  guid: string;
  path: string;
  payload: unknown;
};

export type NestedUtilitySlot = {
  slotId: string;
  classId: string;
};

export function nestedUtilitySlots(
  nested: readonly NestedUtilityLogicSource[],
): NestedUtilitySlot[] {
  return nested.map((entry) => ({
    slotId: entry.slotId,
    classId: userInterfaceClassId(entry.guid),
  }));
}

/** Nested UserInterface / EUI payloads reachable from a host widget tree. */
export function collectNestedUtilityLogicSources(
  payload: unknown,
  resolve: (guid: string) => { path: string; payload: unknown } | null,
): NestedUtilityLogicSource[] {
  const sources: NestedUtilityLogicSource[] = [];
  const seen = new Set<string>();
  const visit = (docPayload: unknown, prefix: string) => {
    const doc = asUiDocument(docPayload);
    for (const widget of Object.values(doc.widgets)) {
      const nestedGuid = widget.nestedUiGuid?.trim();
      if (!nestedGuid || seen.has(nestedGuid)) continue;
      seen.add(nestedGuid);
      const resolved = resolve(nestedGuid);
      if (!resolved) continue;
      const slotId = prefix ? `${prefix}/${widget.id}` : widget.id;
      sources.push({
        slotId,
        guid: nestedGuid,
        path: resolved.path,
        payload: resolved.payload,
      });
      visit(resolved.payload, slotId);
    }
  };
  visit(payload, "");
  return sources;
}

export function compileEditorUtilityInterfaceLogic(
  path: string,
  payload: unknown,
  nested: readonly NestedUtilityLogicSource[] = [],
): ScriptBundleEntry[] {
  const documents: Array<{
    path: string;
    content: SerializedGraph;
    classId?: string;
    parentClassId?: string | null;
  }> = [];
  const host = logicGraphFromUiPayload(path, payload);
  if (host) {
    documents.push({
      path: host.path,
      content: host.content,
      parentClassId: "BObject",
    });
  }
  for (const entry of nested) {
    const graph = logicGraphFromUiPayload(entry.path, entry.payload, entry.guid);
    if (graph) {
      documents.push({
        path: graph.path,
        content: graph.content,
        classId: graph.classId,
        parentClassId: graph.parentClassId ?? "BObject",
      });
    }
  }
  return compileGraphDocuments(documents);
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
    classRegistry: new ClassRegistry(),
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
        host.invokeEvent(classId, "onEditorBeginPlay");
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

function widgetEventArgs(
  event: UiWidgetEvent,
  widgetId: string,
): Record<string, unknown> {
  if ("value" in event) {
    return { widgetId, value: event.value };
  }
  return { widgetId };
}

export function bindEditorUtilityWidgetEvent(
  host: Pick<ScriptHost, "classIds" | "invokeEvent">,
  event: UiWidgetEvent,
  nestedSlots: readonly NestedUtilitySlot[] = [],
): void {
  const name = uiWidgetEventExport(event.kind);
  const longest = [...nestedSlots]
    .filter(
      (slot) =>
        event.widgetId === slot.slotId ||
        event.widgetId.startsWith(`${slot.slotId}/`),
    )
    .sort((a, b) => b.slotId.length - a.slotId.length)[0];
  if (longest) {
    const local = event.widgetId.slice(longest.slotId.length + 1);
    host.invokeEvent(
      longest.classId,
      name,
      null,
      widgetEventArgs(event, local || event.widgetId),
    );
    return;
  }
  const nestedIds = new Set(nestedSlots.map((slot) => slot.classId));
  for (const classId of host.classIds()) {
    if (nestedIds.has(classId)) continue;
    host.invokeEvent(classId, name, null, widgetEventArgs(event, event.widgetId));
  }
}
