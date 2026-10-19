import { BlackboardEditor } from "./blackboard-editor";
import {
  useDocumentActions,
  useOpenDocument,
} from "../context/document-context";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function AssetDocumentWorkspace({ documentId }: { documentId: string }) {
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  if (!doc) return null;
  const payload = asRecord(doc.content);
  const commit = (next: Record<string, unknown>, mergeKey?: string) => {
    void applyAssetDocumentChange(documentId, next, mergeKey);
  };
  if (doc.ref.kind === "blackboard") {
    return <BlackboardEditor payload={payload} onChange={commit} />;
  }
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Unsupported document
    </div>
  );
}
