import type { ProjectStorage } from "@babylonslate/core";

/**
 * Derived data lives outside the project folder, keyed by project guid
 * (compiled scripts, thumbnails, import cache, recovery journal).
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
