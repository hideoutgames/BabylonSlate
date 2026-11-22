import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";

/** Opens the Project Settings dialog, on `categoryId` when given. */
export type OpenProjectSettings = (categoryId?: string) => void;

const OpenerContext = createContext<RefObject<OpenProjectSettings | null> | null>(null);

/**
 * Lets editor windows open Project Settings, whose dialog the chrome bar owns
 * (`useProvideProjectSettingsOpener`), as its menu and Packaging do.
 */
export function ProjectSettingsOpenerProvider({ children }: { children: ReactNode }) {
  const opener = useRef<OpenProjectSettings | null>(null);
  return <OpenerContext.Provider value={opener}>{children}</OpenerContext.Provider>;
}

/** The dialog's owner says how it opens; `open` should be stable. */
// The provider and its hooks belong together.
// eslint-disable-next-line react-refresh/only-export-components
export function useProvideProjectSettingsOpener(open: OpenProjectSettings): void {
  const opener = useContext(OpenerContext);
  useEffect(() => {
    if (!opener) return;
    opener.current = open;
    return () => {
      if (opener.current === open) opener.current = null;
    };
  }, [open, opener]);
}

/** Opens Project Settings; null outside the provider (a window mounted on its own). */
// eslint-disable-next-line react-refresh/only-export-components
export function useOpenProjectSettings(): OpenProjectSettings | null {
  const opener = useContext(OpenerContext);
  return useMemo(() => (opener ? (categoryId?: string) => opener.current?.(categoryId) : null), [opener]);
}
