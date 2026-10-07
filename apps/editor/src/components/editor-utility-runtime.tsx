import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ScriptHost, type ScriptHostServices } from "@babylonslate/runtime";
import { ClassRegistry } from "@babylonslate/object-model";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import { usePlayDiagnosticsActions } from "../context/play-context";
import {
  EDITOR_UTILITY_EVENTS,
  EDITOR_UTILITY_LIFECYCLE_EVENT,
  editorUtilityBootEvents,
  fireEditorUtilityEvent,
  shutdownEditorUtilityHost,
} from "../lib/editor-utility-scripts";
import { createEditorDataReader } from "../services/editor-data-reader";
import { createEditorDataAuthoringApi } from "../services/editor-data-authoring";
import { mergePluginEditorUtilityObjects } from "../lib/plugin-ui";

function editorHostServices(
  appendLog: (line: string) => void,
): ScriptHostServices {
  return {
    classRegistry: new ClassRegistry(),
    log: (_severity, category, message) => {
      appendLog(`[${category}] ${message}`);
    },
    print: (message) => {
      appendLog(message);
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
      appendLog(error instanceof Error ? error.message : String(error));
    },
  };
}

/** In-process ScriptHost for registered EditorUtilityObject classes. */
export function EditorUtilityRuntime() {
  const actions = useDocumentActions();
  const { collectEditorUtilityScripts, getOpenDocuments } = actions;
  const { projectDocument, projectName } = useProjectState();
  const { projectGuid, pluginDescriptors, assetRegistry } = useRegistryState();
  // What the data reader and authoring API read: actions and the registry.
  const documents = useMemo(() => ({ ...actions, assetRegistry }), [actions, assetRegistry]);
  const { appendLog } = usePlayDiagnosticsActions();
  // The host outlives renders: its callbacks read these at call time. Updated
  // after commit, never during render; open tabs come from the live getter.
  const latest = {
    appendLog,
    metadata: projectDocument?.metadata,
    collectScripts: collectEditorUtilityScripts,
    getOpenDocuments,
    documents,
  };
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  });
  const hostRef = useRef<ScriptHost | null>(null);
  const startedRef = useRef(false);
  const registeredKey = mergePluginEditorUtilityObjects(
    projectDocument?.settings.editorUtilityObjects ?? [],
    pluginDescriptors
      .filter((plugin) => assetRegistry?.getRoot(`plugin:${plugin.pluginGuid}`))
      .map((plugin) => plugin.settings),
  ).join("|");

  useEffect(() => {
    if (!projectName) {
      return;
    }
    let cancelled = false;
    const host = new ScriptHost({
      ...editorHostServices((line) => latestRef.current.appendLog(line)),
      data: createEditorDataReader(() => latestRef.current.documents, () => !cancelled),
      editorData: createEditorDataAuthoringApi(
        () => latestRef.current.documents,
        () => !cancelled,
      ),
      getProjectName: () => latestRef.current.metadata?.name ?? "",
      getProjectVersion: () => latestRef.current.metadata?.version ?? "",
    });
    hostRef.current = host;
    void latestRef.current.collectScripts().then(async (scripts) => {
      if (cancelled) return;
      for (const script of scripts) {
        await host.load(script);
      }
      if (cancelled) return;
      const hasOpenScene = latestRef.current.getOpenDocuments().some(
        (doc) => doc.ref.kind === "scene",
      );
      for (const event of editorUtilityBootEvents(hasOpenScene)) {
        fireEditorUtilityEvent(host, event);
      }
      startedRef.current = true;
    });
    return () => {
      cancelled = true;
      shutdownEditorUtilityHost(hostRef.current, startedRef.current);
      hostRef.current = null;
      startedRef.current = false;
    };
  }, [projectName, projectGuid, registeredKey]);

  useEffect(() => {
    const onLifecycle = (event: Event) => {
      const detail = (event as CustomEvent<{ event?: string }>).detail;
      const name = detail?.event;
      const host = hostRef.current;
      if (!name || !host) return;
      fireEditorUtilityEvent(host, name);
      if (name === EDITOR_UTILITY_EVENTS.shutdown) {
        startedRef.current = false;
      }
    };
    window.addEventListener(EDITOR_UTILITY_LIFECYCLE_EVENT, onLifecycle);
    return () => {
      window.removeEventListener(EDITOR_UTILITY_LIFECYCLE_EVENT, onLifecycle);
    };
  }, []);

  return null;
}
