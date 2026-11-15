import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { AnimationPreviewClock } from "../lib/animation-preview-clock";

/** What an Animation's windows share: the Preview's clock, which the Timeline scrubs, and the selected events. */
export interface AnimationEditingContextValue {
  clock: AnimationPreviewClock;
  /** Ids of the Animation Events selected on the Timeline; the Inspector opens their cards. */
  selectedEventIds: ReadonlySet<string>;
  setSelectedEventIds: (ids: ReadonlySet<string>) => void;
}

const AnimationEditingContext = createContext<AnimationEditingContextValue | null>(null);

/** Unknown until the Preview reads the clip; the Preview sets the real length. */
const INITIAL_DURATION_MS = 1000;

export function AnimationEditingProvider({ children }: { children: ReactNode }) {
  const [clock] = useState(() => new AnimationPreviewClock(INITIAL_DURATION_MS));
  const [selectedEventIds, setSelectedEventIds] = useState<ReadonlySet<string>>(() => new Set());
  const value = useMemo(() => ({ clock, selectedEventIds, setSelectedEventIds }), [clock, selectedEventIds]);
  return <AnimationEditingContext.Provider value={value}>{children}</AnimationEditingContext.Provider>;
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useOptionalAnimationEditing(): AnimationEditingContextValue | null {
  return useContext(AnimationEditingContext);
}
/* eslint-enable react-refresh/only-export-components */
