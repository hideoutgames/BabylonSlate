import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AnimGraphPreviewSession } from "../lib/anim-graph-preview-session";

const AnimGraphPreviewContext = createContext<AnimGraphPreviewSession | null>(null);

/**
 * One Preview session per open Animation Graph: the Preview window runs it, Preview Values edits its values and the
 * State Machine canvas lights what it plays.
 */
export function AnimGraphPreviewProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => new AnimGraphPreviewSession());
  useEffect(() => () => session.dispose(), [session]);
  return <AnimGraphPreviewContext.Provider value={session}>{children}</AnimGraphPreviewContext.Provider>;
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useAnimGraphPreview(): AnimGraphPreviewSession {
  const session = useContext(AnimGraphPreviewContext);
  if (!session) throw new Error("useAnimGraphPreview must be used within AnimGraphPreviewProvider");
  return session;
}

export function useOptionalAnimGraphPreview(): AnimGraphPreviewSession | null {
  return useContext(AnimGraphPreviewContext);
}
/* eslint-enable react-refresh/only-export-components */
