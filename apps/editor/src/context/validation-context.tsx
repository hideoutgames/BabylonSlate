import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Diagnostic } from "@babylonslate/scripting";

type ValidationContextValue = {
  diagnostics: Diagnostic[];
  setDiagnostics: (d: Diagnostic[]) => void;
  focusDiagnostic: Diagnostic | null;
  setFocusDiagnostic: (d: Diagnostic | null) => void;
  errorCount: number;
};

const ValidationContext = createContext<ValidationContextValue | null>(null);

export function ValidationProvider({ children }: { children: ReactNode }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [focusDiagnostic, setFocusDiagnostic] = useState<Diagnostic | null>(
    null,
  );
  const value = useMemo(
    () => ({
      diagnostics,
      setDiagnostics,
      focusDiagnostic,
      setFocusDiagnostic,
      errorCount: diagnostics.filter((d) => d.severity === "error").length,
    }),
    [diagnostics, focusDiagnostic],
  );
  return (
    <ValidationContext.Provider value={value}>
      {children}
    </ValidationContext.Provider>
  );
}

export function useValidation(): ValidationContextValue {
  const ctx = useContext(ValidationContext);
  if (!ctx) {
    throw new Error("useValidation requires ValidationProvider");
  }
  return ctx;
}
