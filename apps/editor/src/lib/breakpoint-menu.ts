import type { BreakpointLocation } from "@haptic/bridge";
import type { KeyChord, NestedMenuItem } from "@haptic/editor-kit";
import type { BreakpointEntry, BreakpointStore } from "../services/breakpoint-store";

/**
 * A node menu's breakpoint items, read when the menu opens: **Add Breakpoint**, or **Remove Breakpoint**
 * and **Disable Breakpoint** / **Enable Breakpoint** for one already set.
 */
export function breakpointMenuItems(
  store: BreakpointStore,
  location: BreakpointLocation,
  label: () => BreakpointEntry["label"],
  shortcut?: KeyChord,
): NestedMenuItem[] {
  const entry = store.get(location);
  if (!entry) {
    return [{ id: "add-breakpoint", label: "Add Breakpoint", shortcut, onSelect: () => store.toggle(location, label()) }];
  }
  return [
    { id: "remove-breakpoint", label: "Remove Breakpoint", shortcut, onSelect: () => store.remove(location) },
    {
      id: "toggle-breakpoint-enabled",
      label: entry.enabled ? "Disable Breakpoint" : "Enable Breakpoint",
      onSelect: () => store.setEnabled(location, !entry.enabled),
    },
  ];
}
