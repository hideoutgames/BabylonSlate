import type { ProjectStorage } from "@babylonslate/core";

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
): Promise<void> {
  const path = journalPath(projectGuid);
  if (await derivedStorage.exists(path)) {
    await derivedStorage.remove(path);
  }
}

export async function writeJournalStub(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  lines: string[] = [],
): Promise<void> {
  const root = derivedDataRoot(projectGuid);
  await derivedStorage.mkdir(root, true);
  await derivedStorage.writeText(
    journalPath(projectGuid),
    lines.length ? `${lines.join("\n")}\n` : "",
  );
}

/** Append one JSONL line to the recovery journal (creates the file if missing). */
export async function appendJournalLine(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  line: string,
): Promise<void> {
  const path = journalPath(projectGuid);
  const root = derivedDataRoot(projectGuid);
  await derivedStorage.mkdir(root, true);
  const existing = (await derivedStorage.exists(path))
    ? await derivedStorage.readText(path)
    : "";
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await derivedStorage.writeText(path, `${existing}${prefix}${line}\n`);
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
