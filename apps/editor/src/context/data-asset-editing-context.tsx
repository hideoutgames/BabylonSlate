import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const DataAssetEditingContext = createContext<{
  selectedGuid: string | null;
  select: (guid: string | null) => void;
} | null>(null);

/** Sheet selection is session state; values always belong to the object document. */
export function DataAssetEditingProvider({ children }: { children: ReactNode }) {
  const [selectedGuid, select] = useState<string | null>(null);
  const value = useMemo(() => ({ selectedGuid, select }), [selectedGuid]);
  return <DataAssetEditingContext.Provider value={value}>{children}</DataAssetEditingContext.Provider>;
}

// Context modules intentionally export their consumer hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useDataAssetEditing() {
  const context = useContext(DataAssetEditingContext);
  if (!context) throw new Error("Data assets require their document provider");
  return context;
}
