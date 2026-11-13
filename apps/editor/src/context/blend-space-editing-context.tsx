import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/** A point on a Blend Space's axes; a one-axis space reads only `x`. */
export type BlendSpacePreviewPoint = { x: number; y: number };

interface BlendSpaceEditingValue {
  /** The sample the Grid and Inspector edit, by index; null with none selected. */
  selectedSample: number | null;
  setSelectedSample: (index: number | null) => void;
  /** Where the Preview window plays the blend, set on the Grid. Null until it is placed. */
  previewPoint: BlendSpacePreviewPoint | null;
  setPreviewPoint: (point: BlendSpacePreviewPoint) => void;
}

const BlendSpaceEditingContext = createContext<BlendSpaceEditingValue | null>(null);

/** One open Blend Space's editing state, shared by its windows. */
export function BlendSpaceEditingProvider({ children }: { children: ReactNode }) {
  const [selectedSample, setSelectedSample] = useState<number | null>(null);
  const [previewPoint, setPreviewPoint] = useState<BlendSpacePreviewPoint | null>(null);
  const value = useMemo(
    () => ({ selectedSample, setSelectedSample, previewPoint, setPreviewPoint }),
    [previewPoint, selectedSample],
  );
  return <BlendSpaceEditingContext.Provider value={value}>{children}</BlendSpaceEditingContext.Provider>;
}

/** The open Blend Space's editing state; panels outside the provider (tests) get local state. */
export function useBlendSpaceEditing(): BlendSpaceEditingValue {
  const shared = useContext(BlendSpaceEditingContext);
  const [selectedSample, setSelectedSample] = useState<number | null>(null);
  const [previewPoint, setPreviewPoint] = useState<BlendSpacePreviewPoint | null>(null);
  return shared ?? { selectedSample, setSelectedSample, previewPoint, setPreviewPoint };
}
