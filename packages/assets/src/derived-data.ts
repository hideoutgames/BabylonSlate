import type { ProjectStorage } from "@haptic/core";

const journalOperations = new WeakMap<
  ProjectStorage,
  Map<string, Promise<unknown>>
>();

/** Last segment written and its length in characters. */
interface JournalTail {
  index: number;
  chars: number;
}

/** Tail segment per storage/project, learned on first append. */
const journalTails = new WeakMap<ProjectStorage, Map<string, JournalTail>>();

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

function tailsFor(storage: ProjectStorage): Map<string, JournalTail> {
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

/** Names the segments sealed for the recovery offer: `{"through": <last segment index>}`. */
function sealMarkerPath(projectGuid: string): string {
  return `${journalSegmentsPath(projectGuid)}/sealed.json`;
}

/** Highest segment index sealed for recovery, or null when none is. */
async function sealedThrough(
  storage: ProjectStorage,
  projectGuid: string,
): Promise<number | null> {
  const path = sealMarkerPath(projectGuid);
  if (!(await storage.exists(path))) return null;
  try {
    const { through } = JSON.parse(await storage.readText(path)) as { through?: unknown };
    return typeof through === "number" && Number.isInteger(through) ? through : null;
  } catch {
    return null;
  }
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

async function removeJournalFiles(
  storage: ProjectStorage,
  projectGuid: string,
  exists: boolean,
): Promise<void> {
  tailsFor(storage).delete(projectGuid);
  if (exists) await storage.remove(journalSegmentsPath(projectGuid));
}

/**
 * Append `lines` after the tail segment's `text`, rolling at the size bound.
 * A segment is written only once it holds a new line (or as the empty stub),
 * so a full tail is never rewritten unchanged.
 */
async function writeSegments(
  storage: ProjectStorage,
  projectGuid: string,
  startIndex: number,
  startText: string,
  lines: readonly string[],
): Promise<void> {
  const write = async (index: number, text: string) => {
    await storage.writeText(segmentPath(projectGuid, index), text);
    tailsFor(storage).set(projectGuid, { index, chars: text.length });
  };
  let index = startIndex;
  let text =
    startText.length > 0 && !startText.endsWith("\n") ? `${startText}\n` : startText;
  let changed = false;
  for (const line of lines) {
    const chunk = `${line}\n`;
    if (text.length > 0 && text.length + chunk.length > JOURNAL_SEGMENT_MAX_CHARS) {
      if (changed) await write(index, text);
      index += 1;
      text = "";
    }
    text += chunk;
    changed = true;
  }
  await write(index, text);
}

/** True when a journal segment exists (an empty stub counts). */
export async function hasJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<boolean> {
  return journalOperation(derivedStorage, projectGuid, async () =>
    (await segmentIndices(derivedStorage, projectGuid)).length > 0,
  );
}

/**
 * Remove the live journal when `canClear()` still holds once every append
 * queued before this call has landed. Resolves false when it did not. Segments
 * sealed for recovery stay.
 */
export async function truncateJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  canClear: () => boolean = () => true,
): Promise<boolean> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const exists = await derivedStorage.exists(journalSegmentsPath(projectGuid));
    const through = exists ? await sealedThrough(derivedStorage, projectGuid) : null;
    const live =
      through === null
        ? []
        : (await segmentIndices(derivedStorage, projectGuid)).filter((index) => index > through);
    if (!canClear()) return false;
    if (through === null) {
      await removeJournalFiles(derivedStorage, projectGuid, exists);
    } else {
      tailsFor(derivedStorage).delete(projectGuid);
      for (const index of live) await derivedStorage.remove(segmentPath(projectGuid, index));
    }
    return true;
  });
}

/**
 * Hold every record written so far for the recovery offer. Truncation then
 * removes only the segments written after this call, so the held records
 * survive saves, autosaves and closes until `discardSealedJournal` or
 * `unsealJournal`. Calling it again also holds what was written since.
 */
export async function sealJournalForRecovery(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<void> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    // The next append starts a segment after the sealed ones.
    tailsFor(derivedStorage).delete(projectGuid);
    const last = (await segmentIndices(derivedStorage, projectGuid)).at(-1);
    if (last !== undefined) {
      await derivedStorage.writeText(
        sealMarkerPath(projectGuid),
        JSON.stringify({ through: last }),
      );
    } else if (await derivedStorage.exists(sealMarkerPath(projectGuid))) {
      await derivedStorage.remove(sealMarkerPath(projectGuid));
    }
  });
}

/** Remove the sealed segments (Discard). Records written after the seal stay. */
export async function discardSealedJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<void> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const through = await sealedThrough(derivedStorage, projectGuid);
    if (through === null) return;
    for (const index of await segmentIndices(derivedStorage, projectGuid)) {
      if (index <= through) await derivedStorage.remove(segmentPath(projectGuid, index));
    }
    // Last, so a failed removal leaves the rest sealed for a retry.
    await derivedStorage.remove(sealMarkerPath(projectGuid));
  });
}

/**
 * Return the sealed segments to the live journal (Recover): the next save that
 * writes the replayed edits truncates them with the rest.
 */
export async function unsealJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<void> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    if (await derivedStorage.exists(sealMarkerPath(projectGuid))) {
      await derivedStorage.remove(sealMarkerPath(projectGuid));
    }
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
      await derivedStorage.exists(journalSegmentsPath(projectGuid)),
    );
    await derivedStorage.mkdir(journalSegmentsPath(projectGuid), true);
    await writeSegments(derivedStorage, projectGuid, 0, "", lines);
  });
}

/**
 * Append JSONL lines to the recovery journal in order (creates it if missing).
 * Only the tail segment is read and rewritten, never the whole journal; a tail
 * already known to be too full for the first line is neither read nor rewritten.
 */
export async function appendJournalLines(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) return;
  return journalOperation(derivedStorage, projectGuid, async () => {
    await derivedStorage.mkdir(journalSegmentsPath(projectGuid), true);
    const known = tailsFor(derivedStorage).get(projectGuid);
    if (
      known &&
      known.chars > 0 &&
      known.chars + lines[0].length + 1 > JOURNAL_SEGMENT_MAX_CHARS
    ) {
      await writeSegments(derivedStorage, projectGuid, known.index + 1, "", lines);
      return;
    }
    const index =
      known?.index ??
      Math.max(
        (await segmentIndices(derivedStorage, projectGuid)).at(-1) ?? 0,
        // A sealed segment is never rewritten.
        ((await sealedThrough(derivedStorage, projectGuid)) ?? -1) + 1,
      );
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

async function readSegmentLines(
  storage: ProjectStorage,
  projectGuid: string,
  indices: readonly number[],
): Promise<string[]> {
  const texts: string[] = [];
  for (const index of indices) {
    texts.push(await storage.readText(segmentPath(projectGuid, index)));
  }
  return texts.flatMap((text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** Read non-empty journal lines in segment order, sealed segments included. */
export async function readJournalLines(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<string[]> {
  return journalOperation(derivedStorage, projectGuid, async () =>
    readSegmentLines(
      derivedStorage,
      projectGuid,
      await segmentIndices(derivedStorage, projectGuid),
    ),
  );
}

/** Read non-empty lines of the segments sealed for recovery, in order. */
export async function readSealedJournalLines(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<string[]> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const through = await sealedThrough(derivedStorage, projectGuid);
    if (through === null) return [];
    const sealed = (await segmentIndices(derivedStorage, projectGuid)).filter(
      (index) => index <= through,
    );
    return readSegmentLines(derivedStorage, projectGuid, sealed);
  });
}
