import { useMemo } from "react";
import {
  ANIM_STATE_MACHINE_DEBUG_GRAPH_ID,
  BREAKPOINT_PAUSE_CODE,
  BT_DEBUG_GRAPH_ID,
  type BreakpointEvent,
  type SessionPauseCause,
} from "@haptic/bridge";
import { documentId, documentKindForAssetType } from "@haptic/core";
import { useBreakpointStore } from "../context/breakpoints-context";
import { useOpenDocument, useRegistryState } from "../context/document-context";
import { classIdForGraphPath } from "../services/script-compiler";
import { sessionReportNodeTitle } from "./session-report-locations";

/** Where a session stopped, named for the toolbar: asset, event or function, node and object. */
export type BreakpointStop = {
  /** The Class, Behaviour Tree or Animation Graph. */
  className: string;
  /** The event or function a Class run started from; a tree or state machine has none. */
  entryName?: string;
  nodeTitle: string;
  /** What a tree node or state machine did: Started, Failed, Entered or Taken. */
  eventName?: string;
  /** The object that reached the node; absent when the run had none. */
  objectName?: string;
};

const EVENT_NAMES: Record<BreakpointEvent, string> = {
  started: "Started",
  failed: "Failed",
  entered: "Entered",
  taken: "Taken",
};

/** A Behaviour Tree's or State Machine's breakpoints are keyed by the asset's guid, a Class's by its path. */
const isGuidKeyed = (graphId: string | undefined) =>
  graphId === BT_DEBUG_GRAPH_ID || graphId === ANIM_STATE_MACHINE_DEBUG_GRAPH_ID;

/**
 * The names of a breakpoint stop, from the breakpoint as it was set and the document the stop opened
 * (a Class's event node title, a tree node's title). Null for any other pause.
 */
export function useBreakpointStop(cause: SessionPauseCause | null | undefined): BreakpointStop | null {
  const store = useBreakpointStore();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const isStop = cause?.code === BREAKPOINT_PAUSE_CODE && !!cause.assetGuid && !!cause.nodeId;
  const byGuid = isStop && isGuidKeyed(cause!.graphId) ? cause!.assetGuid! : null;
  const asset = useMemo(() => {
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const found = byGuid ? assetRegistry?.getByGuid(byGuid) : undefined;
    return found && !found.placeholder ? found : undefined;
  }, [assetRegistry, byGuid, registryEpoch]);
  const assetKind = asset ? documentKindForAssetType(asset.header.type) : null;
  const openId = !isStop
    ? null
    : byGuid
      ? asset && assetKind ? documentId({ kind: assetKind, path: asset.path }) : null
      : documentId({ kind: "graph", path: cause!.assetGuid! });
  const doc = useOpenDocument(openId);
  return useMemo(() => {
    if (!isStop || !cause) return null;
    const { assetGuid, graphId, nodeId, entryNodeId, instanceLabel, breakpointEvent } = cause;
    const entry = store?.get({ assetGuid: assetGuid!, graphId: graphId ?? "event-graph", nodeId: nodeId! });
    const content = doc?.content;
    const objectName = instanceLabel ? { objectName: instanceLabel } : {};
    if (byGuid) {
      // A tree node's title comes from its document; a state's or transition's name is the one it was set with.
      const title = content && graphId === BT_DEBUG_GRAPH_ID
        ? sessionReportNodeTitle("BehaviourTree", content, nodeId!) ?? undefined
        : undefined;
      return {
        className: asset?.header.name ?? entry?.label.className ?? assetGuid!,
        nodeTitle: title ?? entry?.label.nodeTitle ?? nodeId!,
        ...(breakpointEvent ? { eventName: EVENT_NAMES[breakpointEvent] } : {}),
        ...objectName,
      };
    }
    // The title the open Class's canvas shows for a node (catalog titles come from hydration).
    const titleOf = (id: string | undefined) =>
      content && id ? sessionReportNodeTitle("Class", content, id) ?? undefined : undefined;
    return {
      className: entry?.label.className ?? classIdForGraphPath(assetGuid!),
      // A function's runs start at its entry, which is named for the function.
      entryName: graphId && graphId !== "event-graph"
        ? entry?.label.graphName ?? graphId
        : titleOf(entryNodeId) ?? "Event Graph",
      nodeTitle: titleOf(nodeId) ?? entry?.label.nodeTitle ?? nodeId!,
      ...objectName,
    };
  }, [asset, byGuid, cause, doc?.content, isStop, store]);
}

/** One line for the toolbar and its tooltip. */
export function breakpointStopText(stop: BreakpointStop): string {
  const entry = stop.entryName ? ` › ${stop.entryName}` : "";
  const event = stop.eventName ? ` (${stop.eventName})` : "";
  return `${stop.className}${entry} › ${stop.nodeTitle}${event}${stop.objectName ? ` on ${stop.objectName}` : ""}`;
}
