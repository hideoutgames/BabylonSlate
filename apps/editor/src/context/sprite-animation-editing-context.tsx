import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface SpriteAnimationEditingValue {
  selectedFrameIndex: number;
  setSelectedFrameIndex: (index: number) => void;
}

const SpriteAnimationEditingContext =
  createContext<SpriteAnimationEditingValue | null>(null);

/** The frame a Sprite Animation document's Preview and Details panels share. */
export function SpriteAnimationEditingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);
  const value = useMemo(
    () => ({ selectedFrameIndex, setSelectedFrameIndex }),
    [selectedFrameIndex],
  );
  return (
    <SpriteAnimationEditingContext.Provider value={value}>
      {children}
    </SpriteAnimationEditingContext.Provider>
  );
}

/** The shared frame selection, or null outside a Sprite Animation document. */
export function useOptionalSpriteAnimationEditing(): SpriteAnimationEditingValue | null {
  return useContext(SpriteAnimationEditingContext);
}
