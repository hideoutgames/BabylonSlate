import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  GraphEditor,
  GRAPH_DEFAULT_ZOOM,
  type PaletteNode,
} from "@babylonslate/graph-ui";
import { PanelFrame } from "@babylonslate/editor-kit";
import type { SerializedGraph } from "@babylonslate/core";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { createAppSettingsStore } from "@babylonslate/vfs";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { usePlay } from "../context/play-context";
import { useValidation } from "../context/validation-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { ENGINE_SETTINGS_CHANGED_EVENT } from "../lib/viewport-render-gate";
import { classParentLookup } from "../lib/content-browser-helpers";
import { functionLibraryShowsEventGraphEmpty } from "../lib/class-members";
import {
  classHierarchyFromParentOf,
  classMemberSymbolsFromGraphs,
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
  knownClassIdSet,
  scriptPaletteNodes,
  scriptPinCompatibility,
  validateSerializedGraph,
  defaultNodeRegistry,
} from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { shouldPublishGraphDiagnostics } from "../lib/graph-diagnostics-scope";
import {
  collectClassGraphsForPalette,
  collectFunctionLibrariesForPalette,
  commitLogicGraph,
  serializedGraphFromDocument,
} from "../lib/logic-graph-document";

const registry = defaultNodeRegistry;
const VALIDATION_DEBOUNCE_MS = 250;

export function GraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const {
    openDocuments,
    applyGraphChange,
    applyAssetDocumentChange,
    assetRegistry,
    activeDocumentId,
    uiEditorMode,
    animEditorMode,
  } = useDocuments();
  const { focusedNodeId } = usePlay();
  const { setSelectedNodeIds, activeFunctionId, setActiveFunctionId, setCanvasDropApi } =
    useGraphEditing();
  const {
    diagnostics,
    setDiagnostics,
    focusDiagnostic,
    setFocusDiagnostic,
  } = useValidation();
  const [defaultZoom, setDefaultZoom] = useState(GRAPH_DEFAULT_ZOOM);

  useEffect(() => {
    const store = createAppSettingsStore();
    void store.load().then((settings) => {
      setDefaultZoom(settings.graphDefaultZoom);
    });
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ graphDefaultZoom?: number }>)
        .detail;
      if (detail && typeof detail.graphDefaultZoom === "number") {
        setDefaultZoom(detail.graphDefaultZoom);
      }
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () =>
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  }, []);

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const indexed = (assetRegistry?.list() ?? []).find(
    (asset) => asset.path === doc?.ref.path,
  );
  const parentClass =
    indexed?.header.parentClass ??
    (doc?.ref.kind === "ui" || doc?.ref.kind === "anim-graph" ? "BObject" : null);
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const classId = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : undefined;
  const graphContent = serializedGraphFromDocument(
    doc?.ref.kind ?? "",
    doc?.content,
  );
  const otherClassGraphs = useMemo(
    () =>
      collectClassGraphsForPalette({
        assets: assetRegistry?.list() ?? [],
        openDocuments,
        classIdForPath: classIdForGraphPath,
      }),
    [assetRegistry, openDocuments],
  );
  const functionLibraries = useMemo(
    () =>
      collectFunctionLibrariesForPalette({
        assets: assetRegistry?.list() ?? [],
        openDocuments,
        parentOf,
        classIdForPath: classIdForGraphPath,
      }),
    [assetRegistry, openDocuments, parentOf],
  );
  const hierarchy = useMemo(
    () => classHierarchyFromParentOf(parentOf),
    [parentOf],
  );
  const memberSymbols = useMemo(() => {
    const graphs = { ...otherClassGraphs };
    if (classId && graphContent) graphs[classId] = graphContent;
    return classMemberSymbolsFromGraphs(graphs);
  }, [classId, graphContent, otherClassGraphs]);
  const knownClassIds = useMemo(
    () => knownClassIdSet(parentOf, Object.keys(otherClassGraphs)),
    [otherClassGraphs, parentOf],
  );
  const pinCompatibility = useMemo(
    () => scriptPinCompatibility(hierarchy),
    [hierarchy],
  );
  const graph = useMemo(() => {
    const slice =
      activeFunctionId && graphContent?.functionGraphs?.[activeFunctionId]
        ? graphContent.functionGraphs[activeFunctionId]
        : null;
    const visible: SerializedGraph | null = slice
      ? {
          nodes: slice.nodes,
          edges: slice.edges,
          members: graphContent?.members,
          components: graphContent?.components,
        }
      : graphContent;
    return hydrateSerializedGraphForEditor(
      visible ??
        createDefaultLogicGraphSerialized(registry, { parentClass, parentOf }),
      registry,
      { parentOf },
    );
  }, [activeFunctionId, graphContent, parentClass, parentOf]);

  const assetGuid = doc?.ref.path ?? documentId;

  useEffect(() => {
    if (activeFunctionId && !graphContent?.functionGraphs?.[activeFunctionId]) {
      setActiveFunctionId(null);
    }
  }, [activeFunctionId, graphContent, setActiveFunctionId]);

  // Edit-time validation is debounced so typing in a node does not re-run the
  // whole pass on every keystroke; save and pre-Preview sweeps are immediate.
  useEffect(() => {
    if (
      !shouldPublishGraphDiagnostics({
        documentId,
        activeDocumentId,
        documentKind: doc?.ref.kind ?? "",
        uiEditorMode: doc?.ref.kind === "ui" ? uiEditorMode : undefined,
        animEditorMode:
          doc?.ref.kind === "anim-graph" ? animEditorMode : undefined,
      })
    ) {
      return;
    }
    const handle = window.setTimeout(() => {
      setDiagnostics(
        validateSerializedGraph(graph, {
          assetGuid,
          graphId: documentId,
          hierarchy,
          classId,
          activeFunctionId,
          members: memberSymbols,
          knownClassIds,
        }),
      );
    }, VALIDATION_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    activeDocumentId,
    activeFunctionId,
    assetGuid,
    classId,
    doc?.ref.kind,
    documentId,
    graph,
    hierarchy,
    knownClassIds,
    memberSymbols,
    setDiagnostics,
    uiEditorMode,
    animEditorMode,
  ]);

  const paletteNodes = useMemo(
    (): PaletteNode[] =>
      scriptPaletteNodes(registry, {
        parentClass,
        parentOf,
        classId,
        graph: graphContent ?? undefined,
        otherClassGraphs,
        activeFunctionId,
        assetType: indexed?.header.type,
        functionLibraries,
        animationGraphHost:
          doc?.ref.kind === "anim-graph" ? "object" : undefined,
      }),
    [
      activeFunctionId,
      classId,
      functionLibraries,
      graphContent,
      indexed?.header.type,
      otherClassGraphs,
      parentClass,
      parentOf,
      doc?.ref.kind,
    ],
  );

  const focusId = focusDiagnostic?.nodeId ?? focusedNodeId ?? undefined;
  const graphDiagnostics = useMemo(
    () =>
      diagnostics.map((d) => ({
        nodeId: d.nodeId,
        pinId: d.pinId,
        severity: d.severity,
        message: d.message,
      })),
    [diagnostics],
  );

  const showLibraryEmpty = functionLibraryShowsEventGraphEmpty({
    parentClass,
    parentOf,
    activeFunctionId,
  });

  return (
    <PanelFrame data-testid="graph-panel">
      {showLibraryEmpty ? (
        <Empty data-testid="function-library-event-graph-empty">
          <EmptyHeader>
            <EmptyTitle>No Event Graph</EmptyTitle>
            <EmptyDescription>
              Function libraries only have functions. Add one in the Class panel.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <GraphEditor
          key={`${documentId}:${activeFunctionId ?? "event"}`}
          initialGraph={graph}
          colorMode="dark"
          defaultZoom={defaultZoom}
          focusedNodeId={focusId}
          diagnostics={graphDiagnostics}
          paletteNodes={paletteNodes}
          pinCompatibility={pinCompatibility}
          onCanvasApi={setCanvasDropApi}
          onNavigateRequest={() => setFocusDiagnostic(null)}
          onSelectionChange={setSelectedNodeIds}
          onChange={(next) => {
            if (!doc) return;
            const current = graphContent ?? { nodes: [], edges: [] };
            const merged: SerializedGraph = activeFunctionId
              ? {
                  ...current,
                  functionGraphs: {
                    ...current.functionGraphs,
                    [activeFunctionId]: {
                      nodes: next.nodes,
                      edges: next.edges,
                    },
                  },
                }
              : {
                  ...next,
                  members: next.members ?? current.members,
                  components: next.components ?? current.components,
                  functionGraphs: current.functionGraphs,
                };
            const commit = commitLogicGraph(doc.ref.kind, doc.content, merged);
            if (commit.kind !== "graph") {
              void applyAssetDocumentChange(documentId, commit.payload);
              return;
            }
            void applyGraphChange(documentId, commit.graph);
          }}
        />
      )}
    </PanelFrame>
  );
}
