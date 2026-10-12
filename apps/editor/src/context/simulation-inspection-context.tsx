import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { SimulationInspectionStore } from "../services/simulation-inspection-store";
import { useDockPanelShown } from "../lib/use-dock-panel-shown";

const SimulationInspectionContext = createContext<SimulationInspectionStore | null>(null);
export function SimulationInspectionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SimulationInspectionStore());
  return <SimulationInspectionContext.Provider value={store}>{children}</SimulationInspectionContext.Provider>;
}
/* eslint-disable react-refresh/only-export-components -- context module */
export function useSimulationInspectionStore(): SimulationInspectionStore | null { return useContext(SimulationInspectionContext); }
export function useSimulationInspection(store: SimulationInspectionStore, props: IDockviewPanelProps, kind: "identities" | "selection") {
  const shown = useDockPanelShown(props.api);
  useEffect(() => {
    if (shown) return store.consume(kind);
  }, [store, shown, kind]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
/* eslint-enable react-refresh/only-export-components */
