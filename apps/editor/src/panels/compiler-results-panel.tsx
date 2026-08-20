import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo } from "react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Button } from "@babylonslate/ui/components/button";
import {
  PanelFrame,
  SelectableText,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
} from "@babylonslate/editor-kit";
import type { SerializedScene } from "@babylonslate/core";
import type { Diagnostic } from "@babylonslate/scripting";
import { useValidation } from "../context/validation-context";
import { usePlay } from "../context/play-context";
import { useDocuments } from "../context/document-context";
import { useOptionalDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { documentIdToRevealForDiagnostic } from "../services/diagnostic-navigation";
import { physicsPairingDiagnostics } from "../lib/physics-pairing-diagnostics";

type CompilerRow =
  | { kind: "header"; graphId: string }
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
    rows.push({ kind: "header", graphId });
    for (const diagnostic of list) {
      rows.push({ kind: "item", diagnostic });
    }
  }
  return rows;
}

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

  const rows = useMemo(() => flattenCompilerRows(diagnostics), [diagnostics]);

  return (
    <PanelFrame data-testid="compiler-results">
      <ScrollArea className="min-h-0 flex-1 p-2">
        {diagnostics.length === 0 ? (
          <p className="text-sm text-muted-foreground">No diagnostics.</p>
        ) : (
          <WindowedList
            itemCount={rows.length}
            rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}
          >
            {(index) => {
              const row = rows[index]!;
              if (row.kind === "header") {
                return (
                  <div className="flex h-full items-center px-2 text-xs font-medium text-muted-foreground">
                    <SelectableText className="truncate">{row.graphId}</SelectableText>
                  </div>
                );
              }
              const d = row.diagnostic;
              return (
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  className="h-full w-full min-h-0 flex-col items-start justify-center gap-0 px-2 py-0 text-left"
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
                        ? "truncate text-sm text-destructive"
                        : "truncate text-sm text-foreground"
                    }
                  >
                    {d.severity}: {d.code}
                  </span>
                  <SelectableText className="truncate text-xs text-muted-foreground">
                    {d.message}
                    {d.nodeId ? ` @ ${d.nodeId}` : ""}
                    {d.pinId ? `.${d.pinId}` : ""}
                  </SelectableText>
                </Button>
              );
            }}
          </WindowedList>
        )}
      </ScrollArea>
    </PanelFrame>
  );
}
