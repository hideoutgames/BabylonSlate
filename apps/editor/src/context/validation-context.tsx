import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Diagnostic } from "@haptic/scripting";

/**
 * How a publisher's rows join the list. Without `replaces` they replace the
 * whole list (Play, Compile); with it they replace only the rows it matches,
 * so a document's live checks leave the rows Play or Compile reported for
 * other assets in place.
 */
export type DiagnosticsUpdate = {
  replaces?: (diagnostic: Diagnostic) => boolean;
};

type ValidationContextValue = {
  diagnostics: Diagnostic[];
  setDiagnostics: (d: Diagnostic[], update?: DiagnosticsUpdate) => void;
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

/** One document's list. A new generation starts on every visit, so publishers from an earlier visit stop writing. */
type ScopeSlot = { generation: object; diagnostics: Diagnostic[] };

const slotKey = (scopeKey: string | undefined) => scopeKey ?? "";
const NO_DIAGNOSTICS: Diagnostic[] = [];

/**
 * Compiler Results state, one list per document (`scopeKey`, the active
 * document). A document keeps its list while another is active, so results
 * Play reported in a Scene are still there after Open visits their Class.
 * `retainScopeKeys` (the open documents) drops the lists of closed ones.
 */
export function ValidationProvider({
  children,
  scopeKey,
  retainScopeKeys,
}: {
  children: ReactNode;
  scopeKey?: string;
  retainScopeKeys?: readonly string[];
}) {
  const [state, setState] = useState<{
    scopeKey?: string;
    slots: ReadonlyMap<string, ScopeSlot>;
    focusDiagnostic: Diagnostic | null;
    focusScopeKey?: string;
  }>(() => ({
    scopeKey,
    slots: new Map([[slotKey(scopeKey), { generation: {}, diagnostics: [] }]]),
    focusDiagnostic: null,
  }));
  // Switch lists before rendering consumers, so an unrelated asset never shows
  // another document's rows. Setters captured on an earlier visit are ignored.
  if (state.scopeKey !== scopeKey) {
    const slots = new Map(state.slots);
    slots.set(slotKey(scopeKey), {
      generation: {},
      diagnostics: state.slots.get(slotKey(scopeKey))?.diagnostics ?? [],
    });
    const focusDiagnostic = state.focusScopeKey === scopeKey ? state.focusDiagnostic : null;
    setState({ scopeKey, slots, focusDiagnostic, focusScopeKey: scopeKey });
  }
  const key = slotKey(scopeKey);
  const slot = state.slots.get(key);
  const generation = slot?.generation;
  const diagnostics = slot?.diagnostics ?? NO_DIAGNOSTICS;
  const focusDiagnostic = state.focusScopeKey === scopeKey ? state.focusDiagnostic : null;
  const setDiagnostics = useCallback((next: Diagnostic[], update?: DiagnosticsUpdate) => {
    setState((current) => {
      const target = current.slots.get(key);
      if (!target || target.generation !== generation) return current;
      const replaces = update?.replaces;
      const merged = replaces
        ? [...target.diagnostics.filter((entry) => !replaces(entry)), ...next]
        : next;
      if (sameDiagnostics(target.diagnostics, merged)) return current;
      const slots = new Map(current.slots);
      slots.set(key, { ...target, diagnostics: merged });
      return { ...current, slots };
    });
  }, [generation, key]);
  const setFocusDiagnostic = useCallback((next: Diagnostic | null, destinationScopeKey?: string) => {
    setState((current) => {
      // Only the active document's current visit moves the focus.
      if (current.scopeKey !== scopeKey || current.slots.get(key)?.generation !== generation) return current;
      const focusScopeKey = destinationScopeKey ?? current.scopeKey;
      if (current.focusDiagnostic === next && current.focusScopeKey === focusScopeKey) return current;
      return { ...current, focusDiagnostic: next, focusScopeKey };
    });
  }, [generation, key, scopeKey]);
  // Closed documents' lists go; the active one stays even before its tab is listed.
  const retainKey = retainScopeKeys?.join("\u0000");
  useEffect(() => {
    if (retainKey === undefined) return;
    const keep = new Set(retainKey.split("\u0000"));
    setState((current) => {
      const active = slotKey(current.scopeKey);
      const stale = [...current.slots.keys()].filter((entry) => entry !== active && !keep.has(entry));
      if (stale.length === 0) return current;
      const slots = new Map(current.slots);
      for (const entry of stale) slots.delete(entry);
      return { ...current, slots };
    });
  }, [retainKey]);
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
