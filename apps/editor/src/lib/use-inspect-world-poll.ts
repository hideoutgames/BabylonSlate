import { useEffect, useRef, useState } from "react";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";

const INSPECT_POLL_MS = 200;

const EMPTY_SNAPSHOT: DebugInspectSnapshot = { tickIndex: 0, nodes: [] };

/** ~5 Hz inspect snapshots while the Play inspector overlay is open. */
export function useInspectWorldPoll(
  enabled: boolean,
  inspectWorld: () => Promise<DebugInspectSnapshot>,
): DebugInspectSnapshot {
  const inspectRef = useRef(inspectWorld);
  inspectRef.current = inspectWorld;
  const [snapshot, setSnapshot] = useState<DebugInspectSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    const pull = async () => {
      const next = await inspectRef.current();
      if (!cancelled) {
        setSnapshot(next);
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
  }, [enabled]);

  return snapshot;
}
