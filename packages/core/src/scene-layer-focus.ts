import { isInteractiveUIControl2DClass } from "./ui-controls2d";

export const FOCUS_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type FocusDirection = (typeof FOCUS_DIRECTIONS)[number];

/** Session input policy. Asset selections use the existing rebindable input catalog. */
export interface FocusNavigationSettings {
  enabled: boolean;
  navigationInputGuid: string | null;
  activateInputGuid: string | null;
  repeatDelay: number;
  repeatInterval: number;
  wrap: boolean;
}

export interface FocusTargetProperties {
  focusEnabled: boolean;
  focusInitial: boolean;
  focusUp: string | null;
  focusDown: string | null;
  focusLeft: string | null;
  focusRight: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function reference(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function seconds(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(10, value)) : fallback;
}
export function normalizeFocusNavigationSettings(value?: unknown): FocusNavigationSettings {
  const source = record(value);
  return {
    enabled: source.enabled !== false,
    navigationInputGuid: reference(source.navigationInputGuid),
    activateInputGuid: reference(source.activateInputGuid),
    repeatDelay: seconds(source.repeatDelay, 0.4, 0),
    repeatInterval: seconds(source.repeatInterval, 0.1, 0.02),
    wrap: source.wrap === true,
  };
}
export function parseFocusTargetProperties(value?: unknown): FocusTargetProperties {
  const source = record(value);
  return {
    focusEnabled: source.focusEnabled !== false,
    focusInitial: source.focusInitial === true,
    focusUp: reference(source.focusUp),
    focusDown: reference(source.focusDown),
    focusLeft: reference(source.focusLeft),
    focusRight: reference(source.focusRight),
  };
}
export function isFocusTargetClass(classId: string): boolean {
  return classId === "2DButtonComponent" || classId === "2DFocusTargetComponent" || isInteractiveUIControl2DClass(classId);
}
