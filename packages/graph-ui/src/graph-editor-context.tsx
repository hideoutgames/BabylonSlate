import { createContext, useContext } from "react";
import type { NavigateRequest } from "./graph-types";

export type GraphEditorContextValue = {
  pendingPin: { nodeId: string; pinId: string } | null;
  onPinTap: (nodeId: string, pinId: string, direction: "in" | "out") => void;
  nodeErrorCount: (nodeId: string) => number;
  pinHasError: (nodeId: string, pinId: string) => boolean;
  onNavigateRequest?: (request: NavigateRequest) => void;
};

const GraphEditorContext = createContext<GraphEditorContextValue | null>(null);

export function GraphEditorProvider({
  value,
  children,
}: {
  value: GraphEditorContextValue;
  children: React.ReactNode;
}) {
  return (
    <GraphEditorContext.Provider value={value}>
      {children}
    </GraphEditorContext.Provider>
  );
}

export function useGraphEditorContext(): GraphEditorContextValue {
  const ctx = useContext(GraphEditorContext);
  if (!ctx) {
    throw new Error("useGraphEditorContext must be used within GraphEditorProvider");
  }
  return ctx;
}
