import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface AnimGraphEditingContextValue {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}

const AnimGraphEditingContext =
  createContext<AnimGraphEditingContextValue | null>(null);

export function AnimGraphEditingProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
  }, []);
  const value = useMemo<AnimGraphEditingContextValue>(
    () => ({ selectedId, setSelectedId }),
    [selectedId, setSelectedId],
  );
  return (
    <AnimGraphEditingContext.Provider value={value}>
      {children}
    </AnimGraphEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useAnimGraphEditing(): AnimGraphEditingContextValue {
  const context = useContext(AnimGraphEditingContext);
  if (!context) {
    throw new Error(
      "useAnimGraphEditing must be used within AnimGraphEditingProvider",
    );
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
