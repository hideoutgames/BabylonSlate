import { act, cleanup } from "@testing-library/react";
import {
  MemoryStorageAdapter,
  createReadOnlyProjectStorage,
} from "@babylonslate/vfs";
import { createMemoryOpfsRoot } from "../../../../packages/vfs/src/test-support/memory-opfs";

/*
 * Shared setup for tests that mount the real DocumentProvider. `vi.mock` is
 * hoisted per test file, so each file keeps its own module mocks and reads
 * these stand-ins from them with a dynamic import:
 * - `../lib/engine-plugins`, `../lib/engine-extensions` and their `-library`
 *   modules: engine plugins and extensions are fetched from the app's public
 *   folder, so projects here start without any.
 * - `@babylonslate/render`: the KTX2 transcoder probe and the scene loading
 *   paint wait need a GPU page.
 */

/** Read-only, empty engine plugin or extension storage. */
export async function emptyEngineStorage() {
  const storage = new MemoryStorageAdapter("opfs");
  await storage.openDocumentsProject("engine");
  return createReadOnlyProjectStorage(storage);
}

/** An engine plugin or extension library whose snapshots are empty. */
export async function emptyEngineLibrary() {
  return { createStorageSnapshot: emptyEngineStorage };
}

/** Backs project storage with a fresh in-memory OPFS root on `navigator.storage`. */
export function installMemoryOpfs(): void {
  const root = createMemoryOpfsRoot();
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => root },
  });
}

/**
 * Closes a project left open, which clears its autosave timer and recovery
 * journal, then unmounts and clears what the provider persisted: Engine
 * Settings (recent projects) in localStorage and the OPFS root.
 */
export async function unmountDocumentProvider(
  documents: { projectDocument: unknown } | null,
  actions: { forceCloseProject: () => Promise<void> } | null,
): Promise<void> {
  if (documents?.projectDocument && actions) {
    await act(() => actions.forceCloseProject());
  }
  cleanup();
  localStorage.clear();
  delete (navigator as { storage?: unknown }).storage;
}
