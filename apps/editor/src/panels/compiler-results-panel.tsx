import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useMemo } from "react";
import { documentSceneMode } from "../shell/scene-document-layout";
import { isDockviewDocumentKind, primaryDockPanel } from "../shell/window-catalog";
import {
  EVENT_GRAPH_PANEL_ID,
  functionGraphPanelId,
  openFunctionGraphPanel,
} from "../shell/function-graph-panels";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { Empty, EmptyDescription, EmptyTitle } from "@haptic/ui/components/empty";
import {
  PanelFrame,
  SelectableText,
  TREE_ROW_HEIGHT,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
} from "@haptic/editor-kit";
import {
  documentKindLabel,
  isAssetDocumentKind,
  normalizeTimelineClipAsset,
  parseDocumentId,
  type SerializedScene,
  isAnimGraphDocumentKind,
} from "@haptic/core";
import type { Diagnostic } from "@haptic/scripting";
import { useValidation } from "../context/validation-context";
import { usePlay } from "../context/play-context";
import {
  useDocumentActions,
  useActiveDocumentId,
  useActiveDocumentState,
  useOpenDocumentTabs,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useOptionalDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { focusDiagnosticNode } from "../services/diagnostic-navigation";
import { useEndFocusOnDeselect } from "../lib/use-end-focus-on-deselect";
import { claimFocusRouting, graphOwningNode } from "../lib/function-graph-focus";
import { serializedGraphFromDocument } from "../lib/logic-graph-document";
import { hidesResults, mayRevealOnChoice, revealResultWindow } from "../lib/reveal-result-window";
import {
  MODEL_DOCUMENT_KINDS,
  modelSimpleColliderCounter,
  physicsPairingDiagnostics,
} from "../lib/physics-pairing-diagnostics";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { actorTransformDiagnostics } from "../lib/actor-transform-diagnostics";
import { timelineClipAssetDiagnostics, timelineClipBindingDiagnostics, timelineClipDiagnostics, timelineTrackDiagnostics } from "../lib/timeline-clip-diagnostics";
import { timelineProxyScene } from "../lib/timeline-proxy-scene";
import { useTimelinePropertyContext } from "../context/use-timeline-clip";
import { registryClassParentLookup } from "../lib/class-asset-lookup";
import { projectTimelineClips } from "../lib/timeline-asset-index";
import { MessageDetails } from "../components/message-details";
import { DiagnosticResultRow } from "../components/diagnostic-result-row";

/** Diagnostic Details for a row, also its **Copy Details** text. */
function compilerResultDetails(d: Diagnostic): string {
  return `${d.severity}: ${d.code}\n${d.message}\n${d.graphId}${d.nodeId ? `\nNode: ${d.nodeId}` : ""}${d.pinId ? `\nPin: ${d.pinId}` : ""}`;
}

/**
 * The rows a Scene's or Clip's live checks own: this document's rows that name
 * no node (Actors, components, clips, tracks). Its script's rows and the rows
 * Play or Compile reported for other assets stay.
 */
function ownLiveCheckRow(documentId: string, path: string) {
  return (d: Diagnostic) => !d.nodeId && (d.graphId === documentId || d.assetGuid === path);
}

/**
 * Whether a row is about this document: its own graph, functions, script or
 * Actors, rather than another asset Play or Compile reported here.
 */
function belongsToDocument(d: Diagnostic, documentId: string | undefined, path: string | undefined): boolean {
  return d.graphId === documentId || (!!path && d.assetGuid === path) || d.assetGuid === documentId;
}

/** Document kinds whose Actor rows point at the primary viewport. */
const VIEWPORT_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "scene",
  "scene-layer",
  "timeline-clip-2d",
  "timeline-clip-3d",
]);

type CompilerRow =
  | { kind: "header"; graphId: string; assetGuid: string; errors: number; warnings: number }
  | { kind: "item"; diagnostic: Diagnostic };

function flattenCompilerRows(diagnostics: readonly Diagnostic[]): CompilerRow[] {
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const list = grouped.get(diagnostic.graphId) ?? [];
    list.push(diagnostic);
    grouped.set(diagnostic.graphId, list);
  }
  const rows: CompilerRow[] = [];
  for (const [graphId, list] of grouped) {
    const errors = list.filter((diagnostic) => diagnostic.severity === "error").length;
    const warnings = list.filter((diagnostic) => diagnostic.severity === "warning").length;
    rows.push({ kind: "header", graphId, assetGuid: list[0]!.assetGuid, errors, warnings });
    for (const diagnostic of list) {
      rows.push({ kind: "item", diagnostic });
    }
  }
  return rows;
}

const SCENE_DOCUMENT_KINDS = ["scene", "scene-layer"] as const;
const NO_ACTORS: readonly string[] = [];

/**
 * The open document's diagnostics, grouped by graph. Choosing a row focuses its
 * node or Actor; a double-click, double-tap or **Open** also brings the window
 * that shows it forward (`revealResultWindow`) and frames an Actor.
 */
export function CompilerResultsPanel(props: IDockviewPanelProps) {
  const { diagnostics, setDiagnostics, focusDiagnostic, setFocusDiagnostic } = useValidation();
  const { clearFocusedNode, openSessionSource } = usePlay();
  const { setSceneMode, toggleDockWindow } = useDocumentActions();
  const activeDocumentId = useActiveDocumentId();
  const { sceneMode } = useActiveDocumentState();
  // Labels and ids for the result headers; content edits elsewhere skip them.
  const openDocuments = useOpenDocumentTabs();
  const workspace = useOptionalDocumentWorkspace();
  const sceneEditing = useOptionalSceneEditing();
  const documentId = workspace?.documentId;
  const doc = useOpenDocument(documentId);
  // In Script mode the graph publishes its own diagnostics into this list.
  const sceneKind = (doc?.ref.kind === "scene" || doc?.ref.kind === "scene-layer") &&
    documentSceneMode(doc.ref.kind, doc.layout) !== "script";
  const mainScene = doc?.ref.kind === "scene";
  const scenePath = doc?.ref.path;
  const sceneContent = doc?.content;
  // A Model's simple collision shapes come from its open tab first, then the registry.
  const { assetRegistry, registryEpoch } = useRegistryState();
  const modelDocuments = useOpenDocumentsOfKinds(MODEL_DOCUMENT_KINDS);
  const sceneDocuments = useOpenDocumentsOfKinds(SCENE_DOCUMENT_KINDS);
  // Class graphs for the Timeline track checks: a track whose Class variable or component is gone.
  const { graphs: classGraphs, parentOf: classParentOf } = useTimelinePropertyContext();
  const timelineProperties = useMemo(() => ({ graphs: classGraphs, parentOf: classParentOf }), [classGraphs, classParentOf]);

  useEffect(() => {
    if (!documentId || documentId !== activeDocumentId) return;
    if (!sceneKind) return;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const scene = sceneContent as SerializedScene | null;
    const actors = scene?.actors ?? [];
    const options = { assetGuid: scenePath!, graphId: documentId };
    const replaces = ownLiveCheckRow(documentId, scenePath!);
    setDiagnostics([
      ...(mainScene ? physicsPairingDiagnostics(actors, {
        ...options,
        physicsWorld: scene?.settings.physicsWorld,
        modelSimpleColliderCount: modelSimpleColliderCounter(assetRegistry, modelDocuments),
      }) : []),
      ...(mainScene ? actorTransformDiagnostics(actors, options) : []),
      ...timelineClipDiagnostics(scene?.timelineClips, options),
      ...(scene ? timelineTrackDiagnostics(scene, timelineProperties, options) : []),
      ...timelineClipBindingDiagnostics(
        projectTimelineClips(assetRegistry?.list() ?? [], sceneDocuments), scenePath!, options,
        (guid) => assetRegistry?.getByGuid?.(guid)?.header.name,
      ),
    ], { replaces });
  }, [activeDocumentId, assetRegistry, documentId, mainScene, modelDocuments, registryEpoch, sceneContent, sceneDocuments, sceneKind, scenePath, setDiagnostics, timelineProperties]);

  // A 2D or 3D Timeline Clip asset: its Timeline Asset and its proxies' names, Classes and placement.
  const clipKind = doc?.ref.kind === "timeline-clip-2d" || doc?.ref.kind === "timeline-clip-3d" ? doc.ref.kind : undefined;
  useEffect(() => {
    if (!documentId || documentId !== activeDocumentId || !clipKind || !sceneContent) return;
    void registryEpoch;
    const parentOf = registryClassParentLookup(assetRegistry);
    const payload = normalizeTimelineClipAsset(sceneContent);
    const twoD = clipKind === "timeline-clip-2d";
    const anchor = { assetGuid: scenePath!, graphId: documentId };
    const name = assetRegistry?.getByPath?.(scenePath!)?.header.name ?? "Clip";
    setDiagnostics([...timelineClipAssetDiagnostics(payload, {
      twoD,
      timelineAssetName: (guid) => {
        const asset = assetRegistry?.getByGuid?.(guid);
        return asset?.header.type === "Timeline" ? asset.header.name : undefined;
      },
      classExists: (classId) => parentOf(classId) !== null,
    }, anchor),
    // The proxies as the Timeline lists them: a component a proxy's Class lost, or a variable it dropped.
    ...timelineTrackDiagnostics(timelineProxyScene(payload, name, timelineProperties.graphs, twoD), timelineProperties, anchor)],
    { replaces: ownLiveCheckRow(documentId, scenePath!) });
  }, [activeDocumentId, assetRegistry, clipKind, documentId, registryEpoch, sceneContent, scenePath, setDiagnostics, timelineProperties]);

  const rows = useMemo(() => flattenCompilerRows(diagnostics), [diagnostics]);
  // Stable per row list, so the windowed list can reuse its row offsets.
  const rowHeight = useCallback(
    (index: number) =>
      rows[index]?.kind === "header" ? TREE_ROW_HEIGHT : WINDOWED_LIST_TOUCH_ROW_HEIGHT,
    [rows],
  );
  // The row the editor is focused on is the selected one; it unselects when the focus ends.
  const selected = focusDiagnostic && diagnostics.includes(focusDiagnostic) ? focusDiagnostic : null;
  const endFocus = useCallback(() => setFocusDiagnostic(null), [setFocusDiagnostic]);
  // An Actor row's focus ends once the user selects something else in the scene;
  // a node row's ends in its graph.
  useEndFocusOnDeselect(
    focusDiagnostic?.actorId,
    sceneEditing?.selectedActorIds ?? NO_ACTORS,
    endFocus,
  );

  /**
   * Brings forward the window that shows `d` in this document: the Class
   * function tab or graph that holds its node, or the viewport for an Actor.
   * False when a Scene switches to Script mode, whose graph routes the focus.
   */
  const revealLocation = (d: Diagnostic, open: boolean): boolean => {
    const kind = doc?.ref.kind;
    if (!kind || !isDockviewDocumentKind(kind)) return true;
    const dock = props.containerApi as IDockviewPanelProps["containerApi"] | undefined;
    const resultsGroupId = props.api?.group?.id;
    const graph = d.nodeId ? serializedGraphFromDocument(kind, doc?.content) : null;
    const owner = graph && d.nodeId ? graphOwningNode(graph, d.nodeId) : null;
    if ((kind === "scene" || kind === "scene-layer") && owner && sceneMode !== "script") {
      // A Scene's script shows in Script mode: Open switches to it, and its graph routes the focus.
      if (open && documentId) setSceneMode(documentId, "script");
      return false;
    }
    if (owner?.kind === "function") {
      if (!dock) return true;
      const panel = dock.getPanel(functionGraphPanelId(owner.functionId));
      // A closed function tab opens beside the Event Graph.
      const beside = panel ?? dock.getPanel(EVENT_GRAPH_PANEL_ID);
      const reveal = open || (panel
        ? mayRevealOnChoice(dock, panel, resultsGroupId)
        : !hidesResults(dock, beside?.group.id, resultsGroupId));
      if (!reveal) return true;
      const name = graph?.members?.find((member) => member.id === owner.functionId)?.name;
      openFunctionGraphPanel(dock, owner.functionId, name ?? owner.functionId);
      return true;
    }
    // A node shows in the graph that holds it (an Animation Graph's states in its
    // State Machine); an Actor in the viewport.
    const shown = owner?.kind === "event" || (d.nodeId && isAnimGraphDocumentKind(kind)) ||
      (!d.nodeId && d.actorId && VIEWPORT_DOCUMENT_KINDS.has(kind));
    if (!shown) return true;
    revealResultWindow({
      dock,
      resultsGroupId,
      panelId: primaryDockPanel(kind, { sceneMode }),
      open,
      reopen: toggleDockWindow,
    });
    return true;
  };

  const focusHost = { currentFocus: () => focusDiagnostic, setFocusDiagnostic };
  const choose = (d: Diagnostic, open: boolean) => {
    clearFocusedNode();
    if (!belongsToDocument(d, documentId, doc?.ref.path)) {
      // Another asset's row (Play or Compile reported it here). A tap shows its
      // details; Open opens that asset at the node, as a Session Report row does.
      if (open) {
        void openSessionSource({
          severity: d.severity,
          code: d.code,
          message: d.message,
          assetGuid: d.assetGuid || parseDocumentId(d.graphId)?.path,
          graphId: d.graphId,
          nodeId: d.nodeId,
          bodyLine: d.bodyLine,
        });
      } else {
        void focusDiagnosticNode(focusHost, d);
      }
      return;
    }
    if (d.actorId) sceneEditing?.selectActor(d.actorId);
    // This panel brings the owning tab forward every time a row is chosen, so
    // graph panels leave the request alone, unless a mode switch hands it to them.
    if (revealLocation(d, open)) claimFocusRouting(d);
    // Choosing the focused row again frames its node again.
    void focusDiagnosticNode(focusHost, d).then(() => {
      if (open && d.actorId) sceneEditing?.frameActor(d.actorId);
    });
  };

  /** A group's name: its open tab's, the asset's (`FT DataProbe Class`), or its Class and function. */
  const groupLabel = (graphId: string, assetGuid: string) => {
    const open = openDocuments.find((entry) => entry.id === graphId);
    if (open) return open.ref.label;
    const parsed = parseDocumentId(graphId);
    const named = parsed && isAssetDocumentKind(parsed.kind)
      ? assetRegistry?.getByPath?.(parsed.path)?.header.name
      : undefined;
    if (parsed && named && isAssetDocumentKind(parsed.kind)) return `${named} ${documentKindLabel(parsed.kind)}`;
    // A function's rows are grouped under the function's id.
    const owner = openDocuments.find((entry) => entry.ref.path === assetGuid || entry.id === assetGuid);
    if (!owner) return graphId;
    const member = serializedGraphFromDocument(owner.ref.kind, owner.content)?.members
      ?.find((entry) => entry.id === graphId);
    return `${owner.ref.label} › ${member?.name ?? graphId}`;
  };

  return (
    <PanelFrame data-testid="compiler-results">
      {diagnostics.length === 0 ? (
        <Empty>
          <EmptyTitle>No Issues</EmptyTitle>
          <EmptyDescription>Compiler diagnostics appear here.</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 pb-1">
          <WindowedList
            itemCount={rows.length}
            rowHeight={rowHeight}
          >
            {(index) => {
              const row = rows[index]!;
              if (row.kind === "header") {
                return (
                  <div
                    className="flex h-full items-center gap-2 border-b border-border px-2 text-[11px] font-medium text-muted-foreground"
                    title={row.graphId}
                  >
                    <SelectableText className="truncate text-foreground">
                      {groupLabel(row.graphId, row.assetGuid)}
                    </SelectableText>
                    <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
                      {row.errors > 0 ? (
                        <span className="text-destructive">
                          {row.errors} {row.errors === 1 ? "Error" : "Errors"}
                        </span>
                      ) : null}
                      {row.warnings > 0 ? (
                        <span className="text-(--warning)">
                          {row.warnings} {row.warnings === 1 ? "Warning" : "Warnings"}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              }
              const d = row.diagnostic;
              return (
                <DiagnosticResultRow
                  severity={d.severity}
                  message={d.message}
                  code={d.code}
                  location={d.nodeId ? `${d.nodeId}${d.pinId ? `.${d.pinId}` : ""}` : undefined}
                  selected={d === selected}
                  testId="compiler-result-row"
                  details={compilerResultDetails(d)}
                  onSelect={() => choose(d, false)}
                  onOpen={() => choose(d, true)}
                />
              );
            }}
          </WindowedList>
        </ScrollArea>
      )}
      {selected ? <MessageDetails title="Diagnostic Details" message={compilerResultDetails(selected)} onClose={endFocus} /> : null}
    </PanelFrame>
  );
}
