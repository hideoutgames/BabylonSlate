import { createContext, type ReactNode } from "react";
import type { SerializedPin } from "./graph-types";
import type { PinDefaultPreview } from "./pin-default-preview";

export interface PinDefaultEditorRequest {
  nodeId: string;
  nodeType?: string;
  nodeData: Record<string, unknown>;
  /** Includes any type resolved from connected wildcard pins. */
  pin: SerializedPin;
  /** Exact literal value, independent of the rounded display preview. */
  value: unknown;
  preview: PinDefaultPreview;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

/** Return null/undefined to keep the graph's preview for a catalog-backed value. */
export type PinDefaultEditorRenderer = (request: PinDefaultEditorRequest) => ReactNode;

/** Host catalogs supply enum, class, and asset editors without graph/UI coupling. */
export const PinDefaultEditorContext = createContext<PinDefaultEditorRenderer | undefined>(undefined);
