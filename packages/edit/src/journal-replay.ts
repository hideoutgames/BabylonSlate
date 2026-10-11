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
  /** Raw lines that are not journal records, so their edits could not be recovered. */
  malformed: string[];
}

function parseJournal(lines: string[]): { parsed: JournalLine[]; malformed: string[] } {
  const parsed: JournalLine[] = [];
  const malformed: string[] = [];
  for (const raw of lines) {
    try {
      parsed.push(parseJournalLine(raw));
    } catch {
      malformed.push(raw);
    }
  }
  return { parsed, malformed };
}

/**
 * Parse journal lines for replay: malformed lines and rename markers are
 * dropped, and each edit carries the id its document has at the end of the
 * journal, so edits made before a rename replay onto the renamed file.
 * `replayJournalLines` reports the malformed lines.
 */
export function resolveJournalLines(lines: string[]): JournalLine[] {
  return resolveParsedLines(parseJournal(lines).parsed);
}

function resolveParsedLines(parsed: JournalLine[]): JournalLine[] {
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
 * markers are honoured through `resolveJournalLines`. Lines that do not parse
 * are returned in `malformed` rather than dropped silently.
 */
export function replayJournalLines<TDoc extends ReplayableDocument>(
  lines: string[],
  openDocuments: Map<string, TDoc>,
): JournalReplayResult<TDoc> {
  const documents = new Map(openDocuments);
  const skipped: JournalLine[] = [];
  const { parsed, malformed } = parseJournal(lines);

  for (const line of resolveParsedLines(parsed)) {
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

  return { documents, skipped, malformed };
}
