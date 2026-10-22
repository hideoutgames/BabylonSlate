import { useMemo } from "react";
import { useToolbarOverflowEntry } from "@haptic/editor-kit";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@haptic/ui/components/select";
import { useGraphDebugSnapshot, useGraphDebugStore } from "../context/graph-debug-context";
import { SIMULATION_CONTROL_ATTRIBUTE } from "../context/simulation-controls-context";
import { debugInstanceNames } from "../lib/graph-debug-target";
import { TOOLBAR_OVERFLOW_PRIORITY } from "../lib/toolbar-overflow-priority";

const NONE = "__none__";
const controlProps = { [SIMULATION_CONTROL_ATTRIBUTE]: "" };

/**
 * Which live instance the focused Class graph shows while a Simulation runs: the objects of
 * exactly this class, the first by default, **None** when there are none. Presentational
 * state only; the runtime follows the pick (see `GraphDebugStore`).
 */
export function GraphDebugInstanceSelect() {
  const store = useGraphDebugStore();
  const snapshot = useGraphDebugSnapshot();
  const instances = snapshot?.instances;
  const names = useMemo(() => debugInstanceNames(instances ?? []), [instances]);
  const items = [
    { value: NONE, label: "None" },
    ...(instances ?? []).map((instance) => ({ value: instance.id, label: names.get(instance.id) ?? instance.label })),
  ];
  const selected = snapshot?.selectedId ?? NONE;
  const disabled = !instances || instances.length === 0;
  // Collapsed into the toolbar's More Actions menu when the bar is too narrow.
  useToolbarOverflowEntry("debug-instance", TOOLBAR_OVERFLOW_PRIORITY.debugInstance, store && snapshot?.target ? [{
    type: "submenu",
    id: "debug-instance",
    label: "Debug Instance",
    disabled,
    items: [{
      type: "radio-group",
      id: "debug-instance-options",
      value: selected,
      closeOnClick: true,
      onValueChange: (value) => store.select(value === NONE ? null : value),
      items: items.map((item) => ({ id: `debug-instance-${item.value}`, value: item.value, label: item.label })),
    }],
  }] : []);
  if (!store || !snapshot?.target) return null;
  return (
    <Select
      value={selected}
      items={items}
      disabled={disabled}
      onValueChange={(value, details) => {
        // When the followed instance despawns the Select resets itself to its first value
        // (None). Only the user's pick counts: the store has already chosen the fallback.
        if (value && details.reason !== "none") store.select(value === NONE ? null : value);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Debug Instance"
        data-testid="graph-debug-instance-select"
        className="chrome-action-button max-w-48 aria-expanded:bg-accent aria-expanded:text-accent-foreground"
        {...controlProps}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent {...controlProps}>
        <SelectGroup>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
