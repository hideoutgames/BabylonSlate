import type { ProjectStorage } from "@babylonslate/core";

const journalOperations = new WeakMap<
  ProjectStorage,
  Map<string, Promise<unknown>>
>();

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

/**
 * Derived data lives outside the project folder, keyed by project guid
 * (compiled scripts, thumbnails, import cache, recovery journal, Play traces).
 */
export function derivedDataRoot(projectGuid: string): string {
  return `derived/${projectGuid}`;
}

export function journalPath(projectGuid: string): string {
  return `${derivedDataRoot(projectGuid)}/journal.jsonl`;
}

export async function hasJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<boolean> {
  return derivedStorage.exists(journalPath(projectGuid));
}

export async function truncateJournal(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  canClear: () => boolean = () => true,
): Promise<boolean> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const path = journalPath(projectGuid);
    const exists = await derivedStorage.exists(path);
    if (!canClear()) return false;
    if (exists) await derivedStorage.remove(path);
    return true;
  });
}

export async function writeJournalStub(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  lines: string[] = [],
): Promise<void> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const root = derivedDataRoot(projectGuid);
    await derivedStorage.mkdir(root, true);
    await derivedStorage.writeText(
      journalPath(projectGuid),
      lines.length ? `${lines.join("\n")}\n` : "",
    );
  });
}

/** Append one JSONL line to the recovery journal (creates the file if missing). */
export async function appendJournalLine(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  line: string,
): Promise<void> {
  return journalOperation(derivedStorage, projectGuid, async () => {
    const path = journalPath(projectGuid);
    const root = derivedDataRoot(projectGuid);
    await derivedStorage.mkdir(root, true);
    const existing = (await derivedStorage.exists(path))
      ? await derivedStorage.readText(path)
      : "";
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await derivedStorage.writeText(path, `${existing}${prefix}${line}\n`);
  });
}

/** Read non-empty journal lines in file order. */
export async function readJournalLines(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<string[]> {
  const path = journalPath(projectGuid);
  if (!(await derivedStorage.exists(path))) {
    return [];
  }
  const text = await derivedStorage.readText(path);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
