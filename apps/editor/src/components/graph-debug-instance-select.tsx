import { useMemo } from "react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@babylonslate/ui/components/select";
import { useGraphDebugSnapshot, useGraphDebugStore } from "../context/graph-debug-context";
import { SIMULATION_CONTROL_ATTRIBUTE } from "../context/simulation-controls-context";
import { debugInstanceNames } from "../lib/graph-debug-target";

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
  if (!store || !snapshot?.target) return null;
  const items = [
    { value: NONE, label: "None" },
    ...(instances ?? []).map((instance) => ({ value: instance.id, label: names.get(instance.id) ?? instance.label })),
  ];
  return (
    <Select
      value={snapshot.selectedId ?? NONE}
      items={items}
      disabled={!instances || instances.length === 0}
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
