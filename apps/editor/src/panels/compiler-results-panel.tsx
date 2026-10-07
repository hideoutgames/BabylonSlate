import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useState } from "react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Empty, EmptyDescription, EmptyTitle } from "@babylonslate/ui/components/empty";
import {
  PanelFrame,
  SelectableText,
  TREE_ROW_HEIGHT,
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
import { actorTransformDiagnostics } from "../lib/actor-transform-diagnostics";
import { MessageDetails } from "../components/message-details";
import { DiagnosticResultRow } from "../components/diagnostic-result-row";

type CompilerRow =
  | { kind: "header"; graphId: string; errors: number; warnings: number }
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
    rows.push({ kind: "header", graphId, errors, warnings });
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
    const actors = scene?.actors ?? [];
    const options = { assetGuid: doc.ref.path, graphId: documentId };
    setDiagnostics([
      ...physicsPairingDiagnostics(actors, options),
      ...actorTransformDiagnostics(actors, options),
    ]);
  }, [activeDocumentId, documentId, openDocuments, setDiagnostics]);

  const rows = useMemo(() => flattenCompilerRows(diagnostics), [diagnostics]);
  const [selectedDiagnostic, setSelectedDiagnostic] = useState<Diagnostic | null>(null);
  const selected = selectedDiagnostic && diagnostics.includes(selectedDiagnostic) ? selectedDiagnostic : null;

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
            rowHeight={(index) =>
              rows[index]?.kind === "header" ? TREE_ROW_HEIGHT : WINDOWED_LIST_TOUCH_ROW_HEIGHT
            }
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
                      {openDocuments.find((doc) => doc.id === row.graphId)?.ref.label ?? row.graphId}
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
                  onSelect={() => {
                    setSelectedDiagnostic(d);
                    clearFocusedNode();
                    if (d.actorId) sceneEditing?.selectActor(d.actorId);
                    const revealId = documentIdToRevealForDiagnostic(
                      d,
                      openDocuments.map((doc) => doc.id),
                    );
                    setFocusDiagnostic(d, revealId ?? undefined);
                    if (revealId) setActiveDocument(revealId);
                  }}
                />
              );
            }}
          </WindowedList>
        </ScrollArea>
      )}
      {selected ? <MessageDetails title="Diagnostic Details" message={`${selected.severity}: ${selected.code}\n${selected.message}\n${selected.graphId}${selected.nodeId ? `\nNode: ${selected.nodeId}` : ""}${selected.pinId ? `\nPin: ${selected.pinId}` : ""}`} onClose={() => setSelectedDiagnostic(null)} /> : null}
    </PanelFrame>
  );
}
