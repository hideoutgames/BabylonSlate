import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface MaterialRenderControl {
  disabled: boolean;
  requestRender: () => void;
}

interface RegisteredControl {
  ownerId: string;
  control: MaterialRenderControl;
}

interface MaterialRenderControlValue {
  control: MaterialRenderControl | null;
  register: (
    ownerId: string,
    control: MaterialRenderControl,
  ) => () => void;
}

const MaterialRenderControlContext =
  createContext<MaterialRenderControlValue | null>(null);

export function MaterialRenderControlProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [registered, setRegistered] = useState<RegisteredControl | null>(null);
  const register = useCallback(
    (ownerId: string, control: MaterialRenderControl) => {
      setRegistered({ ownerId, control });
      return () => {
        setRegistered((current) =>
          current?.ownerId === ownerId ? null : current,
        );
      };
    },
    [],
  );
  const value = useMemo<MaterialRenderControlValue>(
    () => ({ control: registered?.control ?? null, register }),
    [register, registered],
  );
  return (
    <MaterialRenderControlContext.Provider value={value}>
      {children}
    </MaterialRenderControlContext.Provider>
  );
}

export function useMaterialRenderControl(): MaterialRenderControlValue {
  const value = useContext(MaterialRenderControlContext);
  if (!value) {
    throw new Error(
      "useMaterialRenderControl must be used inside MaterialRenderControlProvider",
    );
  }
  return value;
}
