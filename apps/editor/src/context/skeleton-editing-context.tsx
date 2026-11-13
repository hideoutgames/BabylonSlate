import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface SkeletonEditingValue {
  /** The bone selected in the Inspector's list, which the Preview highlights; null when none is. */
  selectedBone: string | null;
  setSelectedBone: (name: string | null) => void;
}

const SkeletonEditingContext = createContext<SkeletonEditingValue | null>(null);

/** The bone a Skeleton document's Inspector and Preview share. */
export function SkeletonEditingProvider({ children }: { children: ReactNode }) {
  const [selectedBone, setSelectedBone] = useState<string | null>(null);
  const value = useMemo(() => ({ selectedBone, setSelectedBone }), [selectedBone]);
  return (
    <SkeletonEditingContext.Provider value={value}>
      {children}
    </SkeletonEditingContext.Provider>
  );
}

/** The shared bone selection, or null outside a Skeleton document. */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalSkeletonEditing(): SkeletonEditingValue | null {
  return useContext(SkeletonEditingContext);
}
