import { useEffect, useRef, useState } from "react";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import { createInspectWorldStore, type InspectWorldStore } from "./inspect-world-store";

const INSPECT_POLL_MS = 200;
/** An inspect request this old is abandoned: the next poll asks again and the late answer is ignored. */
export const INSPECT_REQUEST_TIMEOUT_MS = 3000;

/**
 * ~5 Hz inspect snapshots while the Play inspector overlay is open. They land
 * in the returned store, not in this hook's owner's state, so the owner does
 * not re-render per poll; a consumer reads them with `useSyncExternalStore`
 * and re-renders only when a snapshot's content differs from the last one.
 */
export function useInspectWorldPoll(
  enabled: boolean,
  inspectWorld: () => Promise<DebugInspectSnapshot>,
): InspectWorldStore {
  const inspectRef = useRef(inspectWorld);
  inspectRef.current = inspectWorld;
  const [store] = useState(createInspectWorldStore);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    // The newest request; an answer from an older one is dropped.
    let latest = 0;
    let startedAt = 0;
    let inFlight = false;
    const pull = async () => {
      // A request that never settles (a stalled worker) must not stop polling for good.
      if (inFlight && Date.now() - startedAt < INSPECT_REQUEST_TIMEOUT_MS) return;
      const request = ++latest;
      inFlight = true;
      startedAt = Date.now();
      try {
        const next = await inspectRef.current();
        if (!cancelled && request === latest) {
          store.publish(next);
        }
      } catch {
        // Keep the last snapshot; the next poll asks again.
      } finally {
        if (request === latest) inFlight = false;
      }
    };
    void pull();
    const timer = window.setInterval(() => {
      void pull();
    }, INSPECT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, store]);

  return store;
}
