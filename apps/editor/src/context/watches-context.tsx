import { useState, type ReactNode } from "react";
import { parseWatchFile, serializeWatchFile, WatchStore } from "../services/watch-store";
import { useProjectDerivedList } from "./project-derived-list";
import { WatchStoreContext } from "./watch-store-context";

/** The project's watches, in its app-private derived data. */
const WATCHES_FILE = "watches.json";

/**
 * Owns the open project's watches: loads them when the project opens, saves them after each change,
 * and moves them with a Class asset that is renamed or moved. Mounted once per project.
 */
export function WatchesProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WatchStore());
  useProjectDerivedList(store, WATCHES_FILE, parseWatchFile, serializeWatchFile);
  return <WatchStoreProvider store={store}>{children}</WatchStoreProvider>;
}

/** Supplies a watch store as is, with no loading or saving: `WatchesProvider`'s core. */
export function WatchStoreProvider({ store, children }: { store: WatchStore; children: ReactNode }) {
  return <WatchStoreContext.Provider value={store}>{children}</WatchStoreContext.Provider>;
}
