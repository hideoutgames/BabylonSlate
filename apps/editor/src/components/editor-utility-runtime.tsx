import { useEffect, useRef } from "react";
import { ScriptHost, type ScriptHostServices } from "@babylonslate/runtime";
import { useDocuments } from "../context/document-context";
import { usePlay } from "../context/play-context";
import {
  EDITOR_UTILITY_EVENTS,
  EDITOR_UTILITY_LIFECYCLE_EVENT,
  editorUtilityBootEvents,
  fireEditorUtilityEvent,
  shutdownEditorUtilityHost,
} from "../lib/editor-utility-scripts";

function editorHostServices(appendLog: (line: string) => void): ScriptHostServices {
  return {
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
  const {
    projectDocument,
    collectEditorUtilityScripts,
    projectName,
    openDocuments,
  } = useDocuments();
  const { appendLog } = usePlay();
  const appendLogRef = useRef(appendLog);
  appendLogRef.current = appendLog;
  const hostRef = useRef<ScriptHost | null>(null);
  const startedRef = useRef(false);
  const openDocumentsRef = useRef(openDocuments);
  openDocumentsRef.current = openDocuments;
  const collectScriptsRef = useRef(collectEditorUtilityScripts);
  collectScriptsRef.current = collectEditorUtilityScripts;
  const registeredKey = (
    projectDocument?.settings.editorUtilityObjects ?? []
  ).join("|");

  useEffect(() => {
    if (!projectName) {
      return;
    }
    let cancelled = false;
    const host = new ScriptHost(
      editorHostServices((line) => appendLogRef.current(line)),
    );
    hostRef.current = host;
    void collectScriptsRef.current().then(async (scripts) => {
      if (cancelled) return;
      for (const script of scripts) {
        await host.load(script);
      }
      if (cancelled) return;
      const hasOpenScene = openDocumentsRef.current.some(
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
  }, [projectName, registeredKey]);

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
