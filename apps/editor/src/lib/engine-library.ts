import type { ProjectStorage } from "@haptic/core";

// Shared by the Engine Plugins and Engine Extensions libraries; each keeps its own entry format.

/** New-project enable defaults keyed by stable guid, beside the library entries. */
export const LIBRARY_DEFAULTS_FILE = "defaults.json";

interface NamedLibraryEntry {
  bundled: boolean;
  settings: { displayName: string };
}

/** Runs library operations one at a time; a failed operation never blocks the next. */
export function createLibraryQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => undefined);
    return next;
  };
}

export async function readLibraryDefaults(storage: ProjectStorage): Promise<Record<string, boolean>> {
  const defaults: Record<string, boolean> = Object.create(null);
  if (!(await storage.exists(LIBRARY_DEFAULTS_FILE))) return defaults;
  let value: unknown;
  try {
    value = JSON.parse(await storage.readText(LIBRARY_DEFAULTS_FILE));
  } catch {
    // Defaults are preferences: unreadable ones fall back to each entry's own.
    return defaults;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  for (const [guid, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") defaults[guid] = enabled;
  }
  return defaults;
}

export function writeLibraryDefaults(storage: ProjectStorage, defaults: Record<string, boolean>): Promise<void> {
  return storage.writeText(LIBRARY_DEFAULTS_FILE, JSON.stringify(defaults));
}

/** A file's bytes before an import, or `null` when it does not exist yet. */
export async function captureLibraryFile(storage: ProjectStorage, path: string): Promise<Uint8Array | null> {
  return await storage.exists(path) ? storage.readBinary(path) : null;
}

/** Undo a failed import: rewrite captured files, remove new ones, then rethrow its cause. */
export async function restoreLibraryFiles(
  storage: ProjectStorage,
  files: ReadonlyArray<readonly [path: string, previous: Uint8Array | null]>,
  cause: unknown,
  noun: "Plugin" | "Extension",
): Promise<never> {
  const restoreErrors: unknown[] = [];
  for (const [path, previous] of files) {
    try {
      if (previous) await storage.writeBinary(path, previous);
      else if (await storage.exists(path)) await storage.remove(path);
    } catch (restoreError) { restoreErrors.push(restoreError); }
  }
  if (restoreErrors.length > 0) {
    throw new AggregateError([cause, ...restoreErrors], `${noun} import failed and the previous library state could not be fully restored.`, { cause });
  }
  throw cause;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

/** Entries that share the guid or, ignoring case and outer spaces, the display name. */
export function sameLibraryIdentity<E extends NamedLibraryEntry>(
  entries: readonly E[],
  guidOf: (entry: E) => string,
  guid: string,
  displayName: string,
): E[] {
  const name = normalizedName(displayName);
  return entries.filter((entry) => guidOf(entry) === guid || normalizedName(entry.settings.displayName) === name);
}

/**
 * The user entry an import replaces. Replacing needs `replaceGuid` to confirm
 * that exact entry; bundled or ambiguous matches can never be replaced.
 */
export function resolveLibraryImport<E extends NamedLibraryEntry>(
  entries: readonly E[],
  guidOf: (entry: E) => string,
  incoming: { guid: string; displayName: string },
  replaceGuid: string | undefined,
  noun: "Plugin" | "Extension",
): { conflict: E } | { existing: E | undefined } {
  const conflicts = sameLibraryIdentity(entries, guidOf, incoming.guid, incoming.displayName);
  if (conflicts.some((entry) => entry.bundled)) {
    throw new Error(`A bundled Engine ${noun} already uses this name or ID and cannot be replaced.`);
  }
  if (conflicts.length > 1) {
    const lower = noun.toLowerCase();
    throw new Error(`The ${lower} name and ID match different Engine ${noun}s. Rename the ${lower} before exporting.`);
  }
  const existing = conflicts[0];
  if (existing && replaceGuid !== guidOf(existing)) return { conflict: existing };
  if (!existing && replaceGuid) {
    throw new Error(`The Engine ${noun} changed. Export again to confirm the replacement.`);
  }
  return { existing };
}
