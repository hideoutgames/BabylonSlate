import { useEffect } from "react";
import { parseDocumentId } from "@haptic/core";
import { useDocumentActions, useRegistryState } from "./document-context";

/** Changing several entries in a row writes the file once. */
const SAVE_DELAY_MS = 500;

/** A store of editor state kept per project: breakpoints, watches. */
export type ProjectDerivedListStore<T> = {
  hydrate(entries: readonly T[]): void;
  onChange(listener: (entries: readonly T[]) => void): () => void;
  /** A Class asset moved or was renamed. */
  renameAsset(fromPath: string, toPath: string): void;
};

/**
 * Loads `store` from the open project's app-private derived data when the project opens, saves it after
 * each change, and moves its entries with a Class asset that is renamed or moved.
 */
export function useProjectDerivedList<T>(
  store: ProjectDerivedListStore<T>,
  file: string,
  parse: (text: string) => T[],
  serialize: (entries: readonly T[]) => string,
): void {
  const { readProjectDerivedText, writeProjectDerivedText, subscribeDocumentIdentity } = useDocumentActions();
  const { projectGuid } = useRegistryState();

  useEffect(() => {
    if (!projectGuid) return;
    let current = true;
    void readProjectDerivedText(projectGuid, file).then((text) => {
      if (current && text !== null) store.hydrate(parse(text));
    }, () => {});
    // Saved under this project's guid, even when the last write lands after the project closed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: readonly T[] | null = null;
    const save = () => {
      timer = undefined;
      const entries = pending;
      pending = null;
      if (entries) void writeProjectDerivedText(projectGuid, file, serialize(entries)).catch(() => {});
    };
    const unsubscribe = store.onChange((entries) => {
      pending = entries;
      timer ??= setTimeout(save, SAVE_DELAY_MS);
    });
    return () => {
      current = false;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      save();
    };
  }, [file, parse, projectGuid, readProjectDerivedText, serialize, store, writeProjectDerivedText]);

  useEffect(
    () => subscribeDocumentIdentity((event) => {
      if (event.type !== "repathed") return;
      const from = parseDocumentId(event.oldId);
      const to = parseDocumentId(event.newId);
      if (from?.kind === "graph" && to?.kind === "graph") store.renameAsset(from.path, to.path);
    }),
    [store, subscribeDocumentIdentity],
  );
}
