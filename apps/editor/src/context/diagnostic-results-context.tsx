import { createContext, lazy, Suspense, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { DiagnosticResultsStore } from "../services/diagnostic-results-store";

const Results = createContext<DiagnosticResultsStore | null>(null);
const DiagnosticResultsDialog = lazy(() => import("../components/diagnostic-results-dialog"));
export const useDiagnosticResultsStore = () => useContext(Results);

export function DiagnosticResultsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new DiagnosticResultsStore());
  return <Results.Provider value={store}>{children}<DiagnosticResultsHost store={store} /></Results.Provider>;
}
function DiagnosticResultsHost({ store }: { store: DiagnosticResultsStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return snapshot.open ? <Suspense fallback={null}><DiagnosticResultsDialog store={store} /></Suspense> : null;
}
