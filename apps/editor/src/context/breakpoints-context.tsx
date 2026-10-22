import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parseDocumentId } from "@haptic/core";
import { useDocumentActions, useRegistryState } from "./document-context";
import {
  BreakpointStore,
  parseBreakpointFile,
  serializeBreakpointFile,
  type BreakpointEntry,
} from "../services/breakpoint-store";

/** The project's breakpoints, in its app-private derived data. */
export const BREAKPOINTS_FILE = "breakpoints.json";
/** Toggling several breakpoints in a row writes the file once. */
const SAVE_DELAY_MS = 500;

const BreakpointStoreContext = createContext<BreakpointStore | null>(null);

/**
 * Owns the open project's node breakpoints: loads them when the project opens, saves them after
 * each change, and moves them with a Class asset that is renamed or moved. Mounted once per project
 * (EditorRoute mounts afresh for each).
 */
export function BreakpointsProvider({ children }: { children: ReactNode }) {
  const { readProjectDerivedText, writeProjectDerivedText, subscribeDocumentIdentity } = useDocumentActions();
  const { projectGuid } = useRegistryState();
  const [store] = useState(() => new BreakpointStore());

  useEffect(() => {
    if (!projectGuid) return;
    let current = true;
    void readProjectDerivedText(projectGuid, BREAKPOINTS_FILE).then((text) => {
      if (current && text !== null) store.hydrate(parseBreakpointFile(text));
    }, () => {});
    // Saved under this project's guid, even when the last write lands after the project closed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: readonly BreakpointEntry[] | null = null;
    const save = () => {
      timer = undefined;
      const entries = pending;
      pending = null;
      if (entries) void writeProjectDerivedText(projectGuid, BREAKPOINTS_FILE, serializeBreakpointFile(entries)).catch(() => {});
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
  }, [projectGuid, readProjectDerivedText, store, writeProjectDerivedText]);

  useEffect(
    () => subscribeDocumentIdentity((event) => {
      if (event.type !== "repathed") return;
      const from = parseDocumentId(event.oldId);
      const to = parseDocumentId(event.newId);
      if (from?.kind === "graph" && to?.kind === "graph") store.renameAsset(from.path, to.path);
    }),
    [store, subscribeDocumentIdentity],
  );

  return <BreakpointStoreProvider store={store}>{children}</BreakpointStoreProvider>;
}

/** Supplies a breakpoint store as is, with no loading or saving: `BreakpointsProvider`'s core. */
export function BreakpointStoreProvider({ store, children }: { store: BreakpointStore; children: ReactNode }) {
  return <BreakpointStoreContext.Provider value={store}>{children}</BreakpointStoreContext.Provider>;
}

/** The open project's breakpoints; null outside a project (the component gallery, isolated panels). */
export function useBreakpointStore(): BreakpointStore | null {
  return useContext(BreakpointStoreContext);
}
