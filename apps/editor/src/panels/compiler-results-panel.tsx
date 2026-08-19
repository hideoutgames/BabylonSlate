import type { IDockviewPanelProps } from "dockview-react";
import { useEffect } from "react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Card } from "@babylonslate/ui/components/card";
import { Button } from "@babylonslate/ui/components/button";
import { PanelFrame, SelectableText } from "@babylonslate/editor-kit";
import type { SerializedScene } from "@babylonslate/core";
import { useValidation } from "../context/validation-context";
import { usePlay } from "../context/play-context";
import { useDocuments } from "../context/document-context";
import { useOptionalDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { documentIdToRevealForDiagnostic } from "../services/diagnostic-navigation";
import { physicsPairingDiagnostics } from "../lib/physics-pairing-diagnostics";

export function CompilerResultsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { diagnostics, setDiagnostics, setFocusDiagnostic } = useValidation();
  const { clearFocusedNode } = usePlay();
  const { openDocuments, setActiveDocument, activeDocumentId } = useDocuments();
  const workspace = useOptionalDocumentWorkspace();
  const sceneEditing = useOptionalSceneEditing();
  const documentId = workspace?.documentId;

  useEffect(() => {
    if (!documentId || documentId !== activeDocumentId) return;
    const doc = openDocuments.find((entry) => entry.id === documentId);
    if (doc?.ref.kind !== "scene") return;
    const scene = doc.content as SerializedScene | null;
    setDiagnostics(
      physicsPairingDiagnostics(scene?.actors ?? [], {
        assetGuid: doc.ref.path,
        graphId: documentId,
      }),
    );
  }, [activeDocumentId, documentId, openDocuments, setDiagnostics]);

  const grouped = new Map<string, typeof diagnostics>();
  for (const d of diagnostics) {
    const list = grouped.get(d.graphId) ?? [];
    list.push(d);
    grouped.set(d.graphId, list);
  }

  return (
    <PanelFrame data-testid="compiler-results">
      <ScrollArea className="min-h-0 flex-1 p-2">
        <div className="flex flex-col gap-2 pr-2">
          {diagnostics.length === 0 ? (
            <p className="text-sm text-muted-foreground">No diagnostics.</p>
          ) : (
            [...grouped.entries()].map(([graphId, list]) => (
              <Card key={graphId} className="gap-1 p-3">
                <div className="text-xs font-medium text-muted-foreground">
                  {graphId}
                </div>
                {list.map((d, i) => (
                  <Button
                    key={`${d.code}-${d.nodeId ?? ""}-${i}`}
                    type="button"
                    variant="ghost"
                    size="touch"
                    className="h-auto w-full flex-col items-start justify-center gap-0.5 px-2 py-2 text-left"
                    data-testid="compiler-result-row"
                    onClick={() => {
                      clearFocusedNode();
                      setFocusDiagnostic(d);
                      if (d.actorId) sceneEditing?.selectActor(d.actorId);
                      const revealId = documentIdToRevealForDiagnostic(
                        d,
                        openDocuments.map((doc) => doc.id),
                      );
                      if (revealId) setActiveDocument(revealId);
                    }}
                  >
                    <span
                      className={
                        d.severity === "error"
                          ? "text-sm text-destructive"
                          : "text-sm text-foreground"
                      }
                    >
                      {d.severity}: {d.code}
                    </span>
                    <SelectableText className="text-xs text-muted-foreground">
                      {d.message}
                      {d.nodeId ? ` @ ${d.nodeId}` : ""}
                      {d.pinId ? `.${d.pinId}` : ""}
                    </SelectableText>
                  </Button>
                ))}
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelFrame>
  );
}
