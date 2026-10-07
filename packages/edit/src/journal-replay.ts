import type { SerializedGraph, SerializedScene } from "@babylonslate/core";
import type { EditCommand } from "./command";
import {
  JOURNAL_REPATH_TYPE,
  JOURNAL_DISCARD_TYPE,
  JOURNAL_CHECKPOINT_TYPE,
  parseJournalLine,
  reviveCommand,
  type JournalLine,
} from "./journal";

/** Any document kind the command layer can replay onto. */
export type ReplayableDocument = SerializedGraph | SerializedScene | Record<string, unknown>;

export interface JournalReplayResult<TDoc = ReplayableDocument> {
  /** Updated documents keyed by doc id. */
  documents: Map<string, TDoc>;
  /** Lines skipped because the target document was not open or the command was unknown. */
  skipped: JournalLine[];
}

/**
 * Parse journal lines for replay: malformed lines and rename markers are
 * dropped, and each edit carries the id its document has at the end of the
 * journal, so edits made before a rename replay onto the renamed file.
 */
export function resolveJournalLines(lines: string[]): JournalLine[] {
  const parsed: JournalLine[] = [];
  for (const raw of lines) {
    try {
      parsed.push(parseJournalLine(raw));
    } catch {
      // Malformed lines are not replayable.
    }
  }
  // Walk backwards so chained renames (A → B → C) resolve to the final id.
  const finalIds = new Map<string, string | null>();
  const resolved: JournalLine[] = [];
  for (let index = parsed.length - 1; index >= 0; index--) {
    const line = parsed[index]!;
    if (line.command.type === JOURNAL_DISCARD_TYPE) {
      finalIds.set(line.docId, null);
      continue;
    }
    if (line.command.type === JOURNAL_REPATH_TYPE) {
      const from = line.command.from;
      if (typeof from === "string" && from !== line.docId) {
        const target = finalIds.has(line.docId) ? finalIds.get(line.docId)! : line.docId;
        // Earlier lines under the new id belonged to another document.
        finalIds.delete(line.docId);
        finalIds.set(from, target);
      }
      continue;
    }
    const docId = finalIds.has(line.docId) ? finalIds.get(line.docId)! : line.docId;
    if (docId === null) continue;
    resolved.push(docId === line.docId ? line : { ...line, docId });
    if (line.command.type === JOURNAL_CHECKPOINT_TYPE) finalIds.set(line.docId, null);
  }
  return resolved.reverse();
}

/**
 * Replay journal lines onto open documents using the same apply path as live
 * editing (revive → command.apply). All asset documents share one stream,
 * keyed by doc id, so recovery is not a second serialisation path. Rename
 * markers are honoured through `resolveJournalLines`.
 */
export function replayJournalLines<TDoc extends ReplayableDocument>(
  lines: string[],
  openDocuments: Map<string, TDoc>,
): JournalReplayResult<TDoc> {
  const documents = new Map(openDocuments);
  const skipped: JournalLine[] = [];

  for (const line of resolveJournalLines(lines)) {
    const doc = documents.get(line.docId);
    if (!doc) {
      skipped.push(line);
      continue;
    }

    const command = reviveCommand(line.command);
    if (!command) {
      skipped.push(line);
      continue;
    }

    documents.set(line.docId, (command as EditCommand<TDoc>).apply(doc));
  }

  return { documents, skipped };
}
