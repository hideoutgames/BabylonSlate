import { useEffect, useMemo } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { GraphEditor } from "@babylonslate/graph-ui";
import type { PaletteNode } from "@babylonslate/graph-ui";
import { PanelFrame } from "@babylonslate/editor-kit";
import type { SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { usePlay } from "../context/play-context";
import { useValidation } from "../context/validation-context";
import {
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
  validateSerializedGraph,
  defaultNodeRegistry,
} from "../services/graph-validation";

const registry = defaultNodeRegistry;
const VALIDATION_DEBOUNCE_MS = 250;

export function GraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange } = useDocuments();
  const { focusedNodeId } = usePlay();
  const {
    diagnostics,
    setDiagnostics,
    focusDiagnostic,
    setFocusDiagnostic,
  } = useValidation();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph = useMemo(() => {
    const raw =
      doc?.ref.kind === "graph" && doc.content
        ? (doc.content as SerializedGraph)
        : createDefaultLogicGraphSerialized(registry);
    return hydrateSerializedGraphForEditor(raw, registry);
  }, [doc]);

  const assetGuid = doc?.ref.path ?? documentId;

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

  const paletteNodes = useMemo((): PaletteNode[] => {
    return registry.list().map((d) => {
      const defaultData: Record<string, unknown> = {};
      if (d.id === "debug.log") {
        defaultData.message = "";
        defaultData.severity = "log";
        defaultData.category = "Script";
      }
      return {
        id: d.id,
        title: d.title,
        category: d.category,
        pins: d.pins(defaultData),
        pure: d.pure,
        latent: d.latent,
        defaultData:
          Object.keys(defaultData).length > 0 ? defaultData : undefined,
      };
    });
  }, []);

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
        key={documentId}
        initialGraph={graph}
        focusedNodeId={focusId}
        diagnostics={graphDiagnostics}
        paletteNodes={paletteNodes}
        onNavigateRequest={() => setFocusDiagnostic(null)}
        onChange={(next) => {
          void applyGraphChange(documentId, next as SerializedGraph);
        }}
      />
    </PanelFrame>
  );
}
