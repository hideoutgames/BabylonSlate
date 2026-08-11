import type { SerializedGraph } from "@babylonslate/core";
import type { EditCommand } from "./command";
import {
  parseJournalLine,
  reviveCommand,
  type JournalLine,
} from "./journal";

export interface JournalReplayResult {
  /** Updated graph documents keyed by doc id. */
  documents: Map<string, SerializedGraph>;
  /** Lines skipped because the target document was not open or the command was unknown. */
  skipped: JournalLine[];
}

/**
 * Replay journal lines onto open graph documents using the same apply path as
 * live editing (revive → command.apply).
 */
export function replayJournalLines(
  lines: string[],
  openGraphs: Map<string, SerializedGraph>,
): JournalReplayResult {
  const documents = new Map(openGraphs);
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

    documents.set(
      line.docId,
      (command as EditCommand<SerializedGraph>).apply(doc),
    );
  }

  return { documents, skipped };
}
