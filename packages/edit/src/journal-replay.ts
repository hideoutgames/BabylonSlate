import type { SerializedGraph, SerializedScene } from "@babylonslate/core";
import type { EditCommand } from "./command";
import {
  parseJournalLine,
  reviveCommand,
  type JournalLine,
} from "./journal";

/** Any document kind the command layer can replay onto. */
export type ReplayableDocument = SerializedGraph | SerializedScene;

export interface JournalReplayResult<TDoc = ReplayableDocument> {
  /** Updated documents keyed by doc id. */
  documents: Map<string, TDoc>;
  /** Lines skipped because the target document was not open or the command was unknown. */
  skipped: JournalLine[];
}

/**
 * Replay journal lines onto open documents using the same apply path as live
 * editing (revive → command.apply). Graph and scene documents share one stream,
 * keyed by doc id, so recovery is not a second serialisation path.
 */
export function replayJournalLines<TDoc extends ReplayableDocument>(
  lines: string[],
  openDocuments: Map<string, TDoc>,
): JournalReplayResult<TDoc> {
  const documents = new Map(openDocuments);
  const skipped: JournalLine[] = [];

  for (const raw of lines) {
    let line: JournalLine;
    try {
      line = parseJournalLine(raw);
    } catch {
      continue;
    }

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
