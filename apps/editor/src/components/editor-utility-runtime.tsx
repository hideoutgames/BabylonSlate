import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ScriptHost, type ScriptHostServices } from "@haptic/runtime";
import { ClassRegistry } from "@haptic/object-model";
import { applyClipboardWrite, applyOpenUrl } from "@haptic/render";
import { deviceEnvironment } from "@haptic/vfs";
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
import { createRegistryCatalogSource } from "../services/asset-catalog";
import { useProjectTrust } from "./use-project-trust";
import { useRegisteredEditorUtilities } from "./use-registered-editor-utilities";

/** What the Output Log says when a registered Editor Utility is held back by Workspace Trust. */
export const UNTRUSTED_EDITOR_UTILITIES_MESSAGE =
  "Editor Utilities did not start: this project is not trusted on this computer. Turn on Trust This Project in Project Settings to run them.";

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
  const { projectGuid, assetRegistry } = useRegistryState();
  // What the data reader and authoring API read: actions and the registry.
  const documents = useMemo(() => ({ ...actions, assetRegistry }), [actions, assetRegistry]);
  const { appendLog } = usePlayDiagnosticsActions();
  // The host outlives renders: its callbacks read these at call time. Updated
  // after commit, never during render; open tabs come from the live getter.
  const latest = {
    appendLog,
    metadata: projectDocument?.metadata,
    buildNumber: projectDocument?.settings.appIdentity?.buildNumber ?? 1,
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
  const registeredKey = useRegisteredEditorUtilities().join("|");
  // Workspace Trust: Editor Utility graphs run project code in the editor, so they start only in a trusted project.
  const { ready: trustReady, trusted } = useProjectTrust();

  useEffect(() => {
    if (!projectName || !trustReady) {
      return;
    }
    if (!trusted) {
      // Registering a utility in an untrusted project says why nothing starts instead of doing nothing.
      if (registeredKey) latestRef.current.appendLog(UNTRUSTED_EDITOR_UTILITIES_MESSAGE);
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
      getAssetCatalog: createRegistryCatalogSource(() => latestRef.current.documents.assetRegistry),
      getProjectName: () => latestRef.current.metadata?.name ?? "",
      getProjectVersion: () => latestRef.current.metadata?.version ?? "",
      getBuildNumber: () => latestRef.current.buildNumber,
      environment: { ...deviceEnvironment(), inEditor: true, developmentBuild: true },
      copyToClipboard: (text) => applyClipboardWrite({ text }),
      openUrl: (url) => applyOpenUrl({ url }),
    });
    hostRef.current = host;
    void latestRef.current.collectScripts().then(async (scripts) => {
      for (const script of scripts) {
        // A replaced or unmounted host loads nothing further.
        if (cancelled) return;
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
    }).catch((error: unknown) => {
      if (!cancelled) latestRef.current.appendLog(`Editor utility scripts could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      cancelled = true;
      shutdownEditorUtilityHost(hostRef.current, startedRef.current);
      hostRef.current = null;
      startedRef.current = false;
    };
  }, [projectName, projectGuid, registeredKey, trustReady, trusted]);

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
