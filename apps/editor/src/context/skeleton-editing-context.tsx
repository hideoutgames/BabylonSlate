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
  /** The socket selected in the list or the Preview, which the Preview moves; null when none is. Never both. */
  selectedSocket: string | null;
  setSelectedSocket: (name: string | null) => void;
}

const SkeletonEditingContext = createContext<SkeletonEditingValue | null>(null);

/** The bone or socket a Skeleton document's Inspector and Preview share. */
export function SkeletonEditingProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<{ bone: string | null; socket: string | null }>({ bone: null, socket: null });
  const value = useMemo(() => ({
    selectedBone: selection.bone,
    setSelectedBone: (bone: string | null) => setSelection({ bone, socket: null }),
    selectedSocket: selection.socket,
    setSelectedSocket: (socket: string | null) => setSelection({ bone: null, socket }),
  }), [selection]);
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
