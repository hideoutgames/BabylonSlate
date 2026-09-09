import { createContext, useContext, useState, type ReactNode } from "react";
const InputAssetEditingContext = createContext<{
  selectedId: string | null;
  select: (id: string | null) => void;
} | null>(null);

export function InputAssetEditingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [selectedId, select] = useState<string | null>(null);
  return (
    <InputAssetEditingContext.Provider value={{ selectedId, select }}>
      {children}
    </InputAssetEditingContext.Provider>
  );
}
// Context providers intentionally share their module with consumer hooks.
/* eslint-disable react-refresh/only-export-components */
export function useInputAssetEditing() {
  const context = useContext(InputAssetEditingContext);
  if (!context)
    throw new Error("Input asset editor requires its document provider");
  return context;
}
