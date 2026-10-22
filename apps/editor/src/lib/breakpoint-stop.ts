import { useMemo } from "react";
import { BREAKPOINT_PAUSE_CODE, type SessionPauseCause } from "@haptic/bridge";
import { documentId } from "@haptic/core";
import { useBreakpointStore } from "../context/breakpoints-context";
import { useOpenDocument } from "../context/document-context";
import { classIdForGraphPath } from "../services/script-compiler";
import { sessionReportNodeTitle } from "./session-report-locations";

/** Where a Simulation stopped, named for the toolbar: Class, event or function, node and object. */
export type BreakpointStop = {
  className: string;
  /** The event or function the run started from. */
  entryName: string;
  nodeTitle: string;
  /** The object that reached the node; absent when the run had none. */
  objectName?: string;
};

/** The title the open Class's canvas shows for a node (catalog titles come from hydration). */
const titleOf = (content: unknown, nodeId: string | undefined) =>
  content && nodeId ? sessionReportNodeTitle("Class", content, nodeId) ?? undefined : undefined;

/**
 * The names of a breakpoint stop, from the breakpoint as it was set and the Class document the stop
 * opened (its event node's title). Null for any other pause.
 */
export function useBreakpointStop(cause: SessionPauseCause | null | undefined): BreakpointStop | null {
  const store = useBreakpointStore();
  const isStop = cause?.code === BREAKPOINT_PAUSE_CODE && !!cause.assetGuid && !!cause.nodeId;
  const doc = useOpenDocument(isStop ? documentId({ kind: "graph", path: cause!.assetGuid! }) : null);
  return useMemo(() => {
    if (!isStop || !cause) return null;
    const { assetGuid, graphId, nodeId, entryNodeId, instanceLabel } = cause;
    const entry = store?.get({ assetGuid: assetGuid!, graphId: graphId ?? "event-graph", nodeId: nodeId! });
    const content = doc?.content;
    return {
      className: entry?.label.className ?? classIdForGraphPath(assetGuid!),
      // A function's runs start at its entry, which is named for the function.
      entryName: graphId && graphId !== "event-graph"
        ? entry?.label.graphName ?? graphId
        : titleOf(content, entryNodeId) ?? "Event Graph",
      nodeTitle: titleOf(content, nodeId) ?? entry?.label.nodeTitle ?? nodeId!,
      ...(instanceLabel ? { objectName: instanceLabel } : {}),
    };
  }, [cause, doc?.content, isStop, store]);
}

/** One line for the toolbar and its tooltip. */
export function breakpointStopText(stop: BreakpointStop): string {
  return `${stop.className} › ${stop.entryName} › ${stop.nodeTitle}${stop.objectName ? ` on ${stop.objectName}` : ""}`;
}
