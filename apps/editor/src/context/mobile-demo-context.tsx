import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type MobileDemoSession = {
  active: boolean;
  start: () => void;
  end: () => void;
};

const MobileDemoContext = createContext<MobileDemoSession | null>(null);

export function MobileDemoProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const session = useMemo(
    () => ({ active, start: () => setActive(true), end: () => setActive(false) }),
    [active],
  );
  return (
    <MobileDemoContext.Provider value={session}>
      {children}
    </MobileDemoContext.Provider>
  );
}

export function useMobileDemoSession() {
  return useContext(MobileDemoContext);
}
