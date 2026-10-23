import { createContext, useContext, useState, type ReactNode } from "react";
import { BreakpointStore, parseBreakpointFile, serializeBreakpointFile } from "../services/breakpoint-store";
import { useProjectDerivedList } from "./project-derived-list";

/** The project's breakpoints, in its app-private derived data. */
export const BREAKPOINTS_FILE = "breakpoints.json";

const BreakpointStoreContext = createContext<BreakpointStore | null>(null);

/**
 * Owns the open project's node breakpoints: loads them when the project opens, saves them after
 * each change, and moves them with a Class asset that is renamed or moved. Mounted once per project
 * (EditorRoute mounts afresh for each).
 */
export function BreakpointsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new BreakpointStore());
  useProjectDerivedList(store, BREAKPOINTS_FILE, parseBreakpointFile, serializeBreakpointFile);
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
