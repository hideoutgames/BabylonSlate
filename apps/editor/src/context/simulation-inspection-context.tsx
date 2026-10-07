import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { SimulationInspectionStore } from "../services/simulation-inspection-store";
import { useDocumentWorkspace } from "./document-workspace-context";
import { useActiveDocumentId } from "./document-context";

const SimulationInspectionContext = createContext<SimulationInspectionStore | null>(null);
export function SimulationInspectionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SimulationInspectionStore());
  return <SimulationInspectionContext.Provider value={store}>{children}</SimulationInspectionContext.Provider>;
}
/* eslint-disable react-refresh/only-export-components -- context module */
export function useSimulationInspectionStore(): SimulationInspectionStore | null { return useContext(SimulationInspectionContext); }
export function useSimulationInspection(store: SimulationInspectionStore, props: IDockviewPanelProps, kind: "identities" | "selection") {
  const { documentId } = useDocumentWorkspace();
  const activeDocumentId = useActiveDocumentId();
  const [visible, setVisible] = useState(props.api?.isVisible ?? true);
  useEffect(() => {
    if (!props.api) return;
    setVisible(props.api.isVisible);
    const subscription = props.api.onDidVisibilityChange(event => setVisible(event.isVisible));
    return () => subscription.dispose();
  }, [props.api]);
  useEffect(() => {
    if (visible && activeDocumentId === documentId) return store.consume(kind);
  }, [store, visible, activeDocumentId, documentId, kind]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
/* eslint-enable react-refresh/only-export-components */
