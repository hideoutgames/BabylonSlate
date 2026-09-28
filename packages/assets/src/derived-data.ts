import type { ProjectStorage } from "@babylonslate/core";

const journalOperations = new WeakMap<
  ProjectStorage,
  Map<string, Promise<unknown>>
>();

/** Tail segment index per storage/project, learned on first append. */
const journalTails = new WeakMap<ProjectStorage, Map<string, number>>();

function journalOperation<T>(
  storage: ProjectStorage,
  guid: string,
  operation: () => Promise<T>,
): Promise<T> {
  let projects = journalOperations.get(storage);
  if (!projects) {
    projects = new Map();
    journalOperations.set(storage, projects);
  }
  const queue = projects;
  const next = (queue.get(guid) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  queue.set(guid, next);
  const cleanup = () => {
    if (queue.get(guid) === next) queue.delete(guid);
  };
  void next.then(cleanup, cleanup);
  return next;
}

function tailsFor(storage: ProjectStorage): Map<string, number> {
  let tails = journalTails.get(storage);
  if (!tails) {
    tails = new Map();
    journalTails.set(storage, tails);
  }
  return tails;
}

/**
 * Derived data lives outside the project folder, keyed by project guid
 * (compiled scripts, thumbnails, import cache, recovery journal, Play traces).
 */
export function derivedDataRoot(projectGuid: string): string {
  return `derived/${projectGuid}`;
}

/**
 * Single-file journal written before segments existed. It is still read first
 * and cleared with the segments, so an older session's unsaved edits recover.
 */
export function journalPath(projectGuid: string): string {
  return `${derivedDataRoot(projectGuid)}/journal.jsonl`;
}

/** Directory of ordered journal segments (`00000000.jsonl`, `00000001.jsonl`, …). */
export function journalSegmentsPath(projectGuid: string): string {
  return `${derivedDataRoot(projectGuid)}/journal`;
}

/**
 * An append rewrites only the tail segment; the next line starts a new segment
 * once the tail would pass this many characters, so append cost stays bounded
 * however long the unsaved session runs. A longer single line gets a segment
 * of its own.
 */
export const JOURNAL_SEGMENT_MAX_CHARS = 64 * 1024;

const SEGMENT_NAME = /^(\d+)\.jsonl$/;

function segmentPath(projectGuid: string, index: number): string {
  return `${journalSegmentsPath(projectGuid)}/${String(index).padStart(8, "0")}.jsonl`;
}

async function segmentIndices(
  storage: ProjectStorage,
  projectGuid: string,
): Promise<number[]> {
  const dir = journalSegmentsPath(projectGuid);
  if (!(await storage.exists(dir))) return [];
  const indices: number[] = [];
  for (const entry of await storage.readdir(dir)) {
    const match = entry.isDir ? null : SEGMENT_NAME.exec(entry.name);
    if (match) indices.push(Number(match[1]));
  }
  return indices.sort((a, b) => a - b);
}

async function existingLayouts(
  storage: ProjectStorage,
  projectGuid: string,
): Promise<{ legacy: boolean; segments: boolean }> {
  const [legacy, segments] = await Promise.all([
    storage.exists(journalPath(projectGuid)),
    storage.exists(journalSegmentsPath(projectGuid)),
  ]);
  return { legacy, segments };
}

async function removeJournalFiles(
  storage: ProjectStorage,
  projectGuid: string,
  existing: { legacy: boolean; segments: boolean },
): Promise<void> {
  tailsFor(storage).delete(projectGuid);
  if (existing.legacy) await storage.remove(journalPath(projectGuid));
  if (existing.segments) await storage.remove(journalSegmentsPath(projectGuid));
}

/** Append `lines` after the tail segment's `text`, rolling at the size bound. */
async function writeSegments(
  storage: ProjectStorage,
  projectGuid: string,
  startIndex: number,
  startText: string,
  lines: readonly string[],
): Promise<void> {
  let index = startIndex;
  let text =
    startText.length > 0 && !startText.endsWith("\n") ? `${startText}\n` : startText;
  for (const line of lines) {
    const chunk = `${line}\n`;
    if (text.length > 0 && text.length + chunk.length > JOURNAL_SEGMENT_MAX_CHARS) {
      await storage.writeText(segmentPath(projectGuid, index), text);
      index += 1;
      text = "";
    }
    text += chunk;
  }
  await storage.writeText(segmentPath(projectGuid, index), text);
  tailsFor(storage).set(projectGuid, index);
}

/** True when either journal layout exists (an empty stub counts). */
export async function hasJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<boolean> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    if (await derivedStorage.exists(journalPath(projectGuid))) return true;
    return (await segmentIndices(derivedStorage, projectGuid)).length > 0;
  });
}

/**
 * Remove the journal in both layouts when `canClear()` still holds once every
 * append queued before this call has landed. Resolves false when it did not.
 */
export async function truncateJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  canClear: () => boolean = () => true,
): Promise<boolean> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const existing = await existingLayouts(derivedStorage, projectGuid);
    if (!canClear()) return false;
    await removeJournalFiles(derivedStorage, projectGuid, existing);
    return true;
  });
}

/** Replace the whole journal with `lines` (an empty list leaves an empty journal). */
export async function writeJournalStub(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  lines: string[] = [],
): Promise<void> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    await removeJournalFiles(
      derivedStorage,
      projectGuid,
      await existingLayouts(derivedStorage, projectGuid),
    );
    await derivedStorage.mkdir(journalSegmentsPath(projectGuid), true);
    await writeSegments(derivedStorage, projectGuid, 0, "", lines);
  });
}

/**
 * Append JSONL lines to the recovery journal in order (creates it if missing).
 * Only the tail segment is read and rewritten, never the whole journal.
 */
export async function appendJournalLines(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) return;
  return journalOperation(derivedStorage, projectGuid, async () => {
    await derivedStorage.mkdir(journalSegmentsPath(projectGuid), true);
    const index =
      tailsFor(derivedStorage).get(projectGuid) ??
      (await segmentIndices(derivedStorage, projectGuid)).at(-1) ??
      0;
    const tail = segmentPath(projectGuid, index);
    const text = (await derivedStorage.exists(tail))
      ? await derivedStorage.readText(tail)
      : "";
    await writeSegments(derivedStorage, projectGuid, index, text, lines);
  });
}

/** Append one JSONL line to the recovery journal (creates it if missing). */
export async function appendJournalLine(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  line: string,
): Promise<void> {
  return appendJournalLines(derivedStorage, projectGuid, [line]);
}

/** Read non-empty journal lines in order: the legacy file, then each segment. */
export async function readJournalLines(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<string[]> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const texts: string[] = [];
    const legacy = journalPath(projectGuid);
    if (await derivedStorage.exists(legacy)) {
      texts.push(await derivedStorage.readText(legacy));
    }
    for (const index of await segmentIndices(derivedStorage, projectGuid)) {
      texts.push(await derivedStorage.readText(segmentPath(projectGuid, index)));
    }
    return texts.flatMap((text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  });
}
