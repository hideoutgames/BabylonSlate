import { createContext, type ReactNode } from "react";
import type { SerializedPin } from "./graph-types";
import type { PinDefaultPreview } from "./pin-default-preview";

export interface PinDefaultEditorRequest {
  nodeId: string;
  nodeType?: string;
  nodeData: Record<string, unknown>;
  /** Connected inputs on this node; hosts must ignore their stale literal defaults. */
  connectedInputIds?: readonly string[];
  /** Includes any type resolved from connected wildcard pins. */
  pin: SerializedPin;
  /** Exact literal value, independent of the rounded display preview. */
  value: unknown;
  preview: PinDefaultPreview;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

/** Return null/undefined to keep the graph's built-in editor or value preview. */
export type PinDefaultEditorRenderer = (request: PinDefaultEditorRequest) => ReactNode;

/** Host catalogs supply reference and contextual string editors without graph/UI coupling. */
export const PinDefaultEditorContext = createContext<PinDefaultEditorRenderer | undefined>(undefined);
