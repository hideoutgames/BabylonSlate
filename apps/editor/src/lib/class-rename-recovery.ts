import { documentId, parseDocumentId } from "@babylonslate/core";
import { replaceClassAssetReferences, type AssetRegistry, type ClassAssetReference } from "@babylonslate/assets";
import { JOURNAL_CHECKPOINT_TYPE, parseJournalLine, resolveJournalLines, serializeJournalLine } from "@babylonslate/edit";
import { classIdFromClassAsset } from "./class-asset-lookup";

/** Checkpoints survive both completed and rolled-back Class file operations. */
export function resolveClassRenameRecovery(lines: string[], registry: AssetRegistry | null): string[] {
  // Unreadable lines pass through so replay reports them instead of losing them here.
  const unreadable = lines.filter((line) => {
    try {
      parseJournalLine(line);
      return false;
    } catch {
      return true;
    }
  });
  return [...resolveJournalLines(lines).map((line) => {
    if (line.command.type !== JOURNAL_CHECKPOINT_TYPE) return serializeJournalLine(line);
    const asset = typeof line.command.assetGuid === "string" ? registry?.getByGuid(line.command.assetGuid) : undefined;
    const ref = parseDocumentId(line.docId);
    const references = Array.isArray(line.command.classReferences)
      ? line.command.classReferences.filter((value): value is ClassAssetReference =>
        !!value && typeof value === "object" && typeof value.guid === "string" && typeof value.classId === "string")
      : [];
    const replacements = references.flatMap((reference) => {
      const current = registry?.getByGuid(reference.guid);
      return current ? [{ ...reference, replacement: { guid: reference.guid, classId: classIdFromClassAsset(current) } }] : [];
    });
    const { value: content } = replaceClassAssetReferences(line.command.content, replacements, (guid) => {
      const header = registry?.getByGuid(guid)?.header;
      return header && ["DataDefinition", "Structure"].includes(header.type) && Array.isArray(header.payload.fields) ? header.payload.fields : undefined;
    });
    return serializeJournalLine({ ...line,
      docId: asset && ref ? documentId({ kind: ref.kind, path: asset.path }) : line.docId,
      command: { ...line.command, content },
    });
  }), ...unreadable];
}
