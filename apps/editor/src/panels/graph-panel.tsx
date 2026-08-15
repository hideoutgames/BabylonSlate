import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  GraphEditor,
  GRAPH_DEFAULT_ZOOM,
  type PaletteNode,
} from "@babylonslate/graph-ui";
import { PanelFrame } from "@babylonslate/editor-kit";
import type { SerializedGraph } from "@babylonslate/core";
import { createAppSettingsStore } from "@babylonslate/vfs";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { usePlay } from "../context/play-context";
import { useValidation } from "../context/validation-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { ENGINE_SETTINGS_CHANGED_EVENT } from "../lib/viewport-render-gate";
import { classParentLookup } from "../lib/content-browser-helpers";
import {
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
  scriptPaletteNodes,
  validateSerializedGraph,
  defaultNodeRegistry,
} from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";

const registry = defaultNodeRegistry;
const VALIDATION_DEBOUNCE_MS = 250;

export function GraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange, assetRegistry } = useDocuments();
  const { focusedNodeId } = usePlay();
  const { setSelectedNodeIds, activeFunctionId, setActiveFunctionId } =
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
  const parentClass = indexed?.header.parentClass ?? null;
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const classId = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : undefined;
  const graphContent =
    doc?.ref.kind === "graph" && doc.content
      ? (doc.content as SerializedGraph)
      : null;
  const otherClassGraphs = useMemo(() => {
    const graphs: Record<string, SerializedGraph> = {};
    for (const entry of openDocuments) {
      if (entry.ref.kind !== "graph" || !entry.content) continue;
      const id = classIdForGraphPath(entry.ref.path);
      if (!id || id === classId) continue;
      graphs[id] = entry.content as SerializedGraph;
    }
    return graphs;
  }, [classId, openDocuments]);
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
    const handle = window.setTimeout(() => {
      setDiagnostics(
        validateSerializedGraph(graph, { assetGuid, graphId: documentId }),
      );
    }, VALIDATION_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [graph, assetGuid, documentId, setDiagnostics]);

  const paletteNodes = useMemo(
    (): PaletteNode[] =>
      scriptPaletteNodes(registry, {
        parentClass,
        parentOf,
        classId,
        graph: graphContent ?? undefined,
        otherClassGraphs,
      }),
    [classId, graphContent, otherClassGraphs, parentClass, parentOf],
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

  return (
    <PanelFrame data-testid="graph-panel">
      <GraphEditor
        key={`${documentId}:${activeFunctionId ?? "event"}`}
        initialGraph={graph}
        colorMode="dark"
        defaultZoom={defaultZoom}
        focusedNodeId={focusId}
        diagnostics={graphDiagnostics}
        paletteNodes={paletteNodes}
        onNavigateRequest={() => setFocusDiagnostic(null)}
        onSelectionChange={setSelectedNodeIds}
        onChange={(next) => {
          const current =
            doc?.ref.kind === "graph"
              ? (doc.content as SerializedGraph)
              : null;
          if (!current) return;
          if (activeFunctionId) {
            void applyGraphChange(documentId, {
              ...current,
              functionGraphs: {
                ...current.functionGraphs,
                [activeFunctionId]: {
                  nodes: next.nodes,
                  edges: next.edges,
                },
              },
            });
            return;
          }
          void applyGraphChange(documentId, {
            ...next,
            members: next.members ?? current.members,
            components: next.components ?? current.components,
            functionGraphs: current.functionGraphs,
          } as SerializedGraph);
        }}
      />
    </PanelFrame>
  );
}
