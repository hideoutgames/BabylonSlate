import { createContext, useContext, useState, type ReactNode } from "react";

const SaveGameEditingContext = createContext<{
  selectedId: string | null;
  select: (id: string | null) => void;
} | null>(null);

export function SaveGameEditingProvider({ children }: { children: ReactNode }) {
  const [selectedId, select] = useState<string | null>(null);
  return <SaveGameEditingContext.Provider value={{ selectedId, select }}>{children}</SaveGameEditingContext.Provider>;
}

// Context providers intentionally share their module with consumer hooks.
// eslint-disable-next-line react-refresh/only-export-components
export function useSaveGameEditing() {
  const context = useContext(SaveGameEditingContext);
  if (!context) throw new Error("Save Game editor requires its document provider");
  return context;
}
