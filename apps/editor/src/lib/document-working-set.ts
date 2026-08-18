import { CONTENT_BROWSER_ID } from "@babylonslate/core";
import { useEffect, useRef, useState } from "react";
import { attachLifecyclePause } from "../services/lifecycle-pause";

/** Inactive chrome tabs stay mounted this long after last being active. */
export const DOCUMENT_IDLE_UNMOUNT_MS = 120_000;
/** Active + recently inactive non-Content-Browser workspaces. */
export const MAX_WARM_DOCUMENT_WORKSPACES = 3;

export type DocumentWorkingSetInput = {
  tabIds: readonly string[];
  activeId: string | null;
  lastActiveAt: ReadonlyMap<string, number>;
  now: number;
  contentBrowserId?: string;
  idleMs?: number;
  maxWarm?: number;
};

/**
 * Which open chrome tabs should keep their document workspace mounted.
 * Content Browser and the active tab always mount. Other tabs stay warm
 * until `idleMs` after `lastActiveAt`, capped at `maxWarm` non-CB ids.
 */
export function selectMountedDocumentIds(
  input: DocumentWorkingSetInput,
): Set<string> {
  const contentBrowserId = input.contentBrowserId ?? CONTENT_BROWSER_ID;
  const idleMs = input.idleMs ?? DOCUMENT_IDLE_UNMOUNT_MS;
  const maxWarm = input.maxWarm ?? MAX_WARM_DOCUMENT_WORKSPACES;
  const open = new Set(input.tabIds);
  const mounted = new Set<string>();

  if (open.has(contentBrowserId)) mounted.add(contentBrowserId);
  if (input.activeId && open.has(input.activeId)) mounted.add(input.activeId);

  const warmInactive = input.tabIds.filter((id) => {
    if (id === contentBrowserId || id === input.activeId) return false;
    const at = input.lastActiveAt.get(id);
    if (at === undefined) return false;
    return input.now - at < idleMs;
  });
  warmInactive.sort(
    (left, right) =>
      (input.lastActiveAt.get(right) ?? 0) - (input.lastActiveAt.get(left) ?? 0),
  );

  let remaining =
    maxWarm - [...mounted].filter((id) => id !== contentBrowserId).length;
  for (const id of warmInactive) {
    if (remaining <= 0) break;
    mounted.add(id);
    remaining -= 1;
  }
  return mounted;
}

/** Wall-clock helper that does not advance while the app is backgrounded. */
export function createIdleClock(now: () => number = () => Date.now()) {
  let pausedAt: number | null = null;
  let pausedMs = 0;
  return {
    now() {
      const wall = now();
      if (pausedAt !== null) return pausedAt - pausedMs;
      return wall - pausedMs;
    },
    setPaused(paused: boolean) {
      const wall = now();
      if (paused) {
        if (pausedAt === null) pausedAt = wall;
        return;
      }
      if (pausedAt !== null) {
        pausedMs += wall - pausedAt;
        pausedAt = null;
      }
    },
  };
}

export function useDocumentWorkingSet(
  tabIds: readonly string[],
  activeId: string | null,
): Set<string> {
  const clockRef = useRef(createIdleClock());
  const lastActiveAtRef = useRef(new Map<string, number>());
  const prevActiveRef = useRef<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [generation, setGeneration] = useState(0);

  if (prevActiveRef.current !== activeId) {
    const now = clockRef.current.now();
    if (prevActiveRef.current) {
      lastActiveAtRef.current.set(prevActiveRef.current, now);
    }
    if (activeId) lastActiveAtRef.current.set(activeId, now);
    prevActiveRef.current = activeId;
  }

  const open = new Set(tabIds);
  for (const id of [...lastActiveAtRef.current.keys()]) {
    if (!open.has(id)) lastActiveAtRef.current.delete(id);
  }

  useEffect(() => {
    return attachLifecyclePause((next) => {
      clockRef.current.setPaused(next);
      setPaused(next);
    });
  }, []);

  useEffect(() => {
    if (paused) return;
    const now = clockRef.current.now();
    const mounted = selectMountedDocumentIds({
      tabIds,
      activeId,
      lastActiveAt: lastActiveAtRef.current,
      now,
    });
    let soonest = Number.POSITIVE_INFINITY;
    for (const id of mounted) {
      if (id === CONTENT_BROWSER_ID || id === activeId) continue;
      const at = lastActiveAtRef.current.get(id);
      if (at === undefined) continue;
      const remaining = DOCUMENT_IDLE_UNMOUNT_MS - (now - at);
      if (remaining >= 0 && remaining < soonest) soonest = remaining;
    }
    if (!Number.isFinite(soonest)) return;
    const timer = window.setTimeout(
      () => setGeneration((current) => current + 1),
      soonest,
    );
    return () => window.clearTimeout(timer);
    // tabIds is hashed so a new array with the same ids does not reset the timer.
  }, [tabIds.join("\0"), activeId, paused, generation]);

  return selectMountedDocumentIds({
    tabIds,
    activeId,
    lastActiveAt: lastActiveAtRef.current,
    now: clockRef.current.now(),
  });
}
