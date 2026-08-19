import { useCallback } from "react";

export type GraphSessionViewport = { x: number; y: number; zoom: number };

const viewports = new Map<string, GraphSessionViewport>();

export function graphSessionViewportKey(
  documentId: string,
  surface = "default",
): string {
  return `${documentId}:${surface}`;
}

export function loadGraphSessionViewport(
  key: string,
): GraphSessionViewport | null {
  return viewports.get(key) ?? null;
}

export function saveGraphSessionViewport(
  key: string,
  viewport: GraphSessionViewport,
): void {
  viewports.set(key, viewport);
}

export function useGraphSessionViewport(documentId: string, surface = "default") {
  const key = graphSessionViewportKey(documentId, surface);
  const sessionViewport = loadGraphSessionViewport(key);
  const onSessionViewportChange = useCallback(
    (viewport: GraphSessionViewport) => {
      saveGraphSessionViewport(key, viewport);
    },
    [key],
  );
  return { sessionViewport, onSessionViewportChange };
}
