import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface TypeAssetEditingContextValue {
  selectedMemberId: string | null;
  selectedPinId: string | null;
  setSelectedMemberId: (id: string | null) => void;
  setSelectedPinId: (id: string | null) => void;
}

const TypeAssetEditingContext =
  createContext<TypeAssetEditingContextValue | null>(null);

export function TypeAssetEditingProvider({ children }: { children: ReactNode }) {
  const [selectedMemberId, setSelectedMemberIdState] = useState<string | null>(
    null,
  );
  const [selectedPinId, setSelectedPinIdState] = useState<string | null>(null);

  const setSelectedMemberId = useCallback((id: string | null) => {
    setSelectedMemberIdState(id);
    setSelectedPinIdState(null);
  }, []);

  const setSelectedPinId = useCallback((id: string | null) => {
    setSelectedPinIdState(id);
  }, []);

  const value = useMemo<TypeAssetEditingContextValue>(
    () => ({
      selectedMemberId,
      selectedPinId,
      setSelectedMemberId,
      setSelectedPinId,
    }),
    [selectedMemberId, selectedPinId, setSelectedMemberId, setSelectedPinId],
  );

  return (
    <TypeAssetEditingContext.Provider value={value}>
      {children}
    </TypeAssetEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useTypeAssetEditing(): TypeAssetEditingContextValue {
  const context = useContext(TypeAssetEditingContext);
  if (!context) {
    throw new Error(
      "useTypeAssetEditing must be used within TypeAssetEditingProvider",
    );
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
