import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Diagnostic } from "@babylonslate/scripting";

type ValidationContextValue = {
  diagnostics: Diagnostic[];
  setDiagnostics: (d: Diagnostic[]) => void;
  focusDiagnostic: Diagnostic | null;
  /** A destination preserves explicit navigation across the next document switch. */
  setFocusDiagnostic: (d: Diagnostic | null, destinationScopeKey?: string) => void;
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

export function ValidationProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string }) {
  const [state, setState] = useState<{
    scopeKey?: string;
    generation: object;
    diagnostics: Diagnostic[];
    focusDiagnostic: Diagnostic | null;
    focusScopeKey?: string;
  }>({ scopeKey, generation: {}, diagnostics: [], focusDiagnostic: null });
  // Reset before rendering consumers so an unrelated asset never inherits the
  // previous graph's errors. Captured setters from old async passes are ignored.
  if (state.scopeKey !== scopeKey) {
    const focusDiagnostic = state.focusScopeKey === scopeKey ? state.focusDiagnostic : null;
    setState({ scopeKey, generation: {}, diagnostics: [], focusDiagnostic, focusScopeKey: scopeKey });
  }
  const { diagnostics, generation } = state;
  const focusDiagnostic = state.focusScopeKey === scopeKey ? state.focusDiagnostic : null;
  const setDiagnostics = useCallback((next: Diagnostic[]) => {
    setState((current) =>
      current.generation !== generation || sameDiagnostics(current.diagnostics, next)
        ? current
        : { ...current, diagnostics: next },
    );
  }, [generation]);
  const setFocusDiagnostic = useCallback((next: Diagnostic | null, destinationScopeKey?: string) => {
    setState((current) => {
      if (current.generation !== generation) return current;
      const focusScopeKey = destinationScopeKey ?? current.scopeKey;
      if (current.focusDiagnostic === next && current.focusScopeKey === focusScopeKey) return current;
      return { ...current, focusDiagnostic: next, focusScopeKey };
    });
  }, [generation]);
  const value = useMemo(
    () => ({
      diagnostics,
      setDiagnostics,
      focusDiagnostic,
      setFocusDiagnostic,
      errorCount: diagnostics.filter((d) => d.severity === "error").length,
    }),
    [diagnostics, focusDiagnostic, setDiagnostics, setFocusDiagnostic],
  );
  return <ValidationContext.Provider value={value}>{children}</ValidationContext.Provider>;
}

export function useValidation(): ValidationContextValue {
  const ctx = useContext(ValidationContext);
  if (!ctx) {
    throw new Error("useValidation requires ValidationProvider");
  }
  return ctx;
}
