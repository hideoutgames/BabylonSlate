import {
  animGraphToSerialized,
  animPaletteNodes,
  hydrateAnimGraphForEditor,
  serializedToAnimGraph,
  validateAnimGraph,
  type AnimGraphDocument,
} from "@babylonslate/anim-graph";
import { GraphEditor } from "@babylonslate/graph-ui";

export function AnimGraphEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const doc = payload as unknown as AnimGraphDocument;
  const diagnostics = validateAnimGraph(doc).map((row) => ({
    nodeId: row.nodeId,
    severity: row.severity,
    message: row.message,
  }));
  return (
    <div className="flex min-h-0 flex-1" data-testid="anim-graph-editor">
      <GraphEditor
        initialGraph={hydrateAnimGraphForEditor(animGraphToSerialized(doc))}
        diagnostics={diagnostics}
        paletteNodes={animPaletteNodes()}
        onChange={(next) =>
          onChange(
            serializedToAnimGraph(next, doc) as unknown as Record<string, unknown>,
          )
        }
      />
    </div>
  );
}
