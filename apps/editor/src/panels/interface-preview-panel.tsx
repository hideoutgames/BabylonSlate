import { useMemo } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { PanelFrame } from "@babylonslate/editor-kit";
import { GraphEditor } from "@babylonslate/graph-ui";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useTypeAssetEditing } from "../context/type-asset-editing-context";
import { interfacePreviewGraph } from "../lib/interface-preview";
import { useGraphSessionViewport } from "../lib/graph-session-viewport";
import {
  asScriptInterfaceAsset,
  parseMemberIndex,
  pinKey,
} from "../lib/type-asset-payload";

export function InterfacePreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const { selectedMemberId, setSelectedPinId } = useTypeAssetEditing();
  const { sessionViewport, onSessionViewportChange } = useGraphSessionViewport(
    documentId,
    selectedMemberId ?? "preview",
  );
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const previewGraph = useMemo(() => {
    const index = parseMemberIndex(selectedMemberId);
    if (index === null) return null;
    const method = asScriptInterfaceAsset(
      (doc?.content ?? {}) as Record<string, unknown>,
    ).methods[index];
    return method ? interfacePreviewGraph(method) : null;
  }, [doc?.content, selectedMemberId]);

  return (
    <PanelFrame data-testid="interface-preview-panel">
      {!previewGraph ? (
        <p className="p-3 text-sm text-muted-foreground">
          Select a method to preview its signature.
        </p>
      ) : (
        <GraphEditor
          key={selectedMemberId ?? "none"}
          readOnly
          initialGraph={previewGraph}
          sessionViewport={sessionViewport}
          onSessionViewportChange={onSessionViewportChange}
          onPinSelect={(_nodeId, pinId) => {
            const index = parseMemberIndex(selectedMemberId);
            if (index === null || !pinId.startsWith("data-")) return;
            const pinIndex = Number(pinId.slice("data-".length));
            if (!Number.isInteger(pinIndex)) return;
            setSelectedPinId(pinKey(index, pinIndex));
          }}
        />
      )}
    </PanelFrame>
  );
}
