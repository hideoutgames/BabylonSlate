import { useCallback, useSyncExternalStore } from "react";
import type { ResolvedRenderingPipeline } from "@babylonslate/core";

type Entry = { status?: ResolvedRenderingPipeline };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function scenePipelineKey(
  projectGuid: string | null,
  documentId: string | null,
): string | null {
  return projectGuid && documentId
    ? JSON.stringify([projectGuid, documentId])
    : null;
}

/** A viewport generation owns its status; stale callbacks/cleanup cannot replace its successor. */
export function registerScenePipelineStatus(key: string | null) {
  const entry: Entry = {};
  if (key) {
    entries.set(key, entry);
    emit();
  }
  return {
    publish(status: ResolvedRenderingPipeline) {
      if (!key || entries.get(key) !== entry) return;
      entry.status = status;
      emit();
    },
    dispose() {
      if (!key || entries.get(key) !== entry) return;
      entries.delete(key);
      emit();
    },
  };
}

export function readScenePipelineStatus(
  key: string | null,
): ResolvedRenderingPipeline | undefined {
  return key ? entries.get(key)?.status : undefined;
}

export function useScenePipelineStatus(
  key: string | null,
): ResolvedRenderingPipeline | undefined {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => readScenePipelineStatus(key), [key]),
    () => undefined,
  );
}
