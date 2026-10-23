import {
  documentId,
  documentKindForAssetType,
  type DocumentRef,
} from "@haptic/core";
import type { SessionReportEntry } from "@haptic/runtime";
import type { Diagnostic } from "@haptic/scripting";
import type { SessionReportAsset } from "../lib/session-report-locations";
import type { AnimEditorMode } from "../shell/anim-document-layout";

/**
 * Play / Compiler Results tap-to-navigate should show the graph that owns the
 * diagnostic. `graphId` is the open document id (`documentId({ kind: "graph", path })`).
 * Session-report rows also open the owning Class / BehaviourTree asset by guid or path.
 */
export function documentIdToRevealForDiagnostic(
  diagnostic: { graphId: string },
  openDocumentIds: readonly string[],
): string | null {
  return openDocumentIds.includes(diagnostic.graphId)
    ? diagnostic.graphId
    : null;
}

type NavigationEntry = Pick<
  SessionReportEntry,
  "assetGuid" | "bodyLine" | "btNodeId" | "nodeId"
>;

export interface SessionReportNavigation {
  focusedNodeId: string;
  bodyLine?: number;
  /** The asset document that owns the entry. */
  document?: DocumentRef;
  /** Why `document` is absent, worded for the report. */
  unavailable?: string;
}

/**
 * The document a session-report entry opens. `findAsset` resolves the entry's
 * `assetGuid`, which is a guid or, for runtime Class scripts, an asset path.
 */
export function sessionReportNavigation(
  entry: NavigationEntry,
  findAsset: (ref: string) => SessionReportAsset | undefined,
): SessionReportNavigation {
  const focusedNodeId = entry.btNodeId ?? entry.nodeId ?? "";
  const base = { focusedNodeId, bodyLine: entry.bodyLine };
  if (!entry.assetGuid) {
    return { ...base, unavailable: "This entry names no asset, so there is no source to open." };
  }
  let asset: SessionReportAsset | undefined;
  try {
    asset = findAsset(entry.assetGuid);
  } catch {
    asset = undefined;
  }
  if (!asset) {
    return { ...base, unavailable: "The asset this entry names is no longer in the project." };
  }
  const kind = documentKindForAssetType(asset.type);
  if (!kind) {
    return { ...base, unavailable: `${asset.name} is a ${asset.type} asset, which has no editor to open.` };
  }
  return { ...base, document: { kind, path: asset.path, label: asset.name } };
}

export type SessionReportNavigationResult =
  | { opened: true }
  | { opened: false; message: string };

export interface SessionReportNavigationHost {
  findAsset(ref: string): SessionReportAsset | undefined;
  /** The focus the editor holds now, read when a row is chosen. */
  currentFocus(): Diagnostic | null;
  setFocusDiagnostic(diagnostic: Diagnostic | null, destinationScopeKey?: string): void;
  setFocusedNodeId(nodeId: string | null): void;
  openDocument(ref: DocumentRef): Promise<void>;
  isDocumentOpen(id: string): boolean;
  setActiveDocument(id: string): void;
  setAnimEditorMode(id: string, mode: AnimEditorMode): void;
  requestDocumentFocus(id: string): void;
  log(line: string): void;
}

/** Lets React commit a cleared focus before the same node is focused again. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Open the entry's source and focus the node. The report stays open either
 * way: the caller shows `message` when the entry cannot be opened.
 */
export async function navigateToSessionReportEntry(
  // A Simulation stopped at a breakpoint opens its node the same way, as `info`.
  entry: Pick<SessionReportEntry, "code" | "message" | "assetGuid" | "graphId" | "nodeId" | "btNodeId" | "bodyLine"> & {
    severity: Diagnostic["severity"];
  },
  host: SessionReportNavigationHost,
): Promise<SessionReportNavigationResult> {
  const nav = sessionReportNavigation(entry, (ref) => host.findAsset(ref));
  host.setFocusedNodeId(nav.focusedNodeId || null);
  const { document } = nav;
  if (!document) {
    const message = nav.unavailable ?? "There is no source to open.";
    host.log(`${entry.code}: ${message}`);
    return { opened: false, message };
  }

  const id = documentId(document);
  const focus: Diagnostic = {
    severity: entry.severity,
    code: entry.code,
    message: entry.message,
    assetGuid: entry.assetGuid ?? "",
    graphId: entry.graphId ?? "",
    nodeId: nav.focusedNodeId || undefined,
    bodyLine: nav.bodyLine,
  };
  // The graph frames a node when its focus changes; choosing the same row again
  // after panning away must change it back.
  const held = host.currentFocus();
  if (focus.nodeId && held?.nodeId === focus.nodeId && held.assetGuid === focus.assetGuid) {
    host.setFocusDiagnostic(null);
    await nextTask();
  }
  host.setFocusDiagnostic(focus, id);

  const fail = (message: string): SessionReportNavigationResult => {
    host.setFocusDiagnostic(null);
    host.log(message);
    return { opened: false, message };
  };
  try {
    await host.openDocument(document);
  } catch (error) {
    return fail(`Could not open ${document.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!host.isDocumentOpen(id)) return fail(`${document.label} was not opened.`);
  // A tab change that raced the open would leave the new tab in the background.
  host.setActiveDocument(id);
  if (document.kind === "anim-graph" && entry.graphId === "animation-object") {
    host.setAnimEditorMode(id, "animationObject");
  }
  host.requestDocumentFocus(id);
  host.log(nav.focusedNodeId ? `Navigate to node ${nav.focusedNodeId}` : `Opened ${document.label}`);
  return { opened: true };
}
