import { useCallback } from "react";
import { useEditorSessionState } from "../context/editor-session-state-context";
import type { GraphSessionViewport } from "./editor-session-state";

/**
 * Graph pan/zoom for one document surface, kept for the project session.
 * Read at render (GraphEditor `sessionViewport`), saved on move end without
 * re-rendering.
 */
export function useGraphSessionViewport(documentId: string, surface = "default") {
  const sessionState = useEditorSessionState();
  const sessionViewport = sessionState.loadGraphViewport(documentId, surface);
  const onSessionViewportChange = useCallback(
    (viewport: GraphSessionViewport) => {
      sessionState.saveGraphViewport(documentId, surface, viewport);
    },
    [documentId, sessionState, surface],
  );
  return { sessionViewport, onSessionViewportChange };
}
