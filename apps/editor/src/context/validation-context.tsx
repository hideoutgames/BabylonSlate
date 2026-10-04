import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Diagnostic } from "@babylonslate/scripting";

type ValidationContextValue = {
  diagnostics: Diagnostic[];
  setDiagnostics: (d: Diagnostic[]) => void;
  focusDiagnostic: Diagnostic | null;
  setFocusDiagnostic: (d: Diagnostic | null) => void;
  errorCount: number;
};

const ValidationContext = createContext<ValidationContextValue | null>(null);

/** Every Diagnostic field; the Record type fails to compile when one is added. */
const DIAGNOSTIC_FIELDS = Object.keys({
  severity: true,
  code: true,
  message: true,
  assetGuid: true,
  graphId: true,
  nodeId: true,
  pinId: true,
  relatedNodeId: true,
  bodyLine: true,
  bodyColumn: true,
  actorId: true,
  componentId: true,
} satisfies Record<keyof Diagnostic, true>) as (keyof Diagnostic)[];

function sameDiagnostics(a: readonly Diagnostic[], b: readonly Diagnostic[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) =>
      DIAGNOSTIC_FIELDS.every((field) => entry[field] === b[index]![field]),
    )
  );
}

export function ValidationProvider({ children }: { children: ReactNode }) {
  const [diagnostics, setDiagnosticsState] = useState<Diagnostic[]>([]);
  const [focusDiagnostic, setFocusDiagnostic] = useState<Diagnostic | null>(
    null,
  );
  // Panels recompute diagnostics on every document change. An equal list
  // keeps the published one, so consumers skip work and a selected row stays
  // the same object.
  const setDiagnostics = useCallback((next: Diagnostic[]) => {
    setDiagnosticsState((current) =>
      sameDiagnostics(current, next) ? current : next,
    );
  }, []);
  const value = useMemo(
    () => ({
      diagnostics,
      setDiagnostics,
      focusDiagnostic,
      setFocusDiagnostic,
      errorCount: diagnostics.filter((d) => d.severity === "error").length,
    }),
    [diagnostics, focusDiagnostic, setDiagnostics],
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
