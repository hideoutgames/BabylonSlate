import { createContext, useContext, useState, type ReactNode } from "react";

/** The Blackboard key the Keys and Inspector panels share, by index. */
const BlackboardEditingContext = createContext<{
  selected: number | null;
  select: (index: number | null) => void;
} | null>(null);

export function BlackboardEditingProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<number | null>(0);
  return (
    <BlackboardEditingContext.Provider value={{ selected, select }}>
      {children}
    </BlackboardEditingContext.Provider>
  );
}
// Context providers intentionally share their module with consumer hooks.
/* eslint-disable react-refresh/only-export-components */
export function useBlackboardEditing() {
  const context = useContext(BlackboardEditingContext);
  if (!context) throw new Error("Blackboard editor requires its document provider");
  return context;
}
