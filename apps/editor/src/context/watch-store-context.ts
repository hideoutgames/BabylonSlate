import { createContext, useContext } from "react";
import type { WatchStore } from "../services/watch-store";

export const WatchStoreContext = createContext<WatchStore | null>(null);

/** The open project's watches; null outside a project. */
export function useWatchStore(): WatchStore | null {
  return useContext(WatchStoreContext);
}
