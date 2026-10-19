import { useState } from "react";
import { newCollisionPresetId, type CollisionPreset } from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { cn } from "@babylonslate/ui/lib/utils";
import { CollisionResponsesField } from "./collision-responses-field";
import { ListRowActions } from "./list-row-actions";

export interface CollisionPresetsFieldProps {
  /** Collision layer names, bit 0 first. */
  layers: readonly string[];
  value: readonly CollisionPreset[];
  onChange: (next: CollisionPreset[]) => void;
  "data-testid"?: string;
}

const ROW_CONTROL = "h-6 text-xs pointer-coarse:h-9";

const layerIndex = (layer: number) => (layer === 0 ? -1 : Math.clz32(layer & -layer) ^ 31);

/**
 * Collision Presets like Unreal's: a list of presets (name and Layer) and,
 * for the selected one, its Name, Layer and Collision Responses. Rows
 * reorder and delete with the list row actions; the last preset stays.
 */
export function CollisionPresetsField({
  layers,
  value,
  onChange,
  "data-testid": testId = "collision-presets",
}: CollisionPresetsFieldProps) {
  const [draft, setDraft] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = Math.max(0, value.findIndex((preset) => preset.id === selectedId));
  const selected = value[selectedIndex];
  const patch = (index: number, change: Partial<CollisionPreset>) =>
    onChange(value.map((preset, row) => (row === index ? { ...preset, ...change } : preset)));
  const add = () => {
    const name = draft.trim();
    if (!name) return;
    const id = newCollisionPresetId(name, value);
    onChange([...value, { id, name, layer: 1, mask: 0xffffffff, overlapMask: 0 }]);
    setSelectedId(id);
    setDraft("");
  };
  const layerName = (layer: number) => layers[layerIndex(layer)] ?? `Layer ${layerIndex(layer) + 1}`;

  return (
    <div className="flex flex-wrap items-start gap-3" data-testid={testId}>
      <div className="flex w-64 flex-col gap-1">
        <div role="listbox" aria-label="Collision Presets" className="flex flex-col">
          {value.map((preset, row) => (
            <div
              key={preset.id}
              role="option"
              aria-selected={row === selectedIndex}
              tabIndex={0}
              data-testid={`${testId}-${row}`}
              className={cn(
                "group/pin-row flex min-h-[var(--chrome-row,28px)] cursor-default items-center gap-2 rounded-md px-2 text-xs pointer-coarse:min-h-[var(--touch-target,44px)]",
                row === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
              onClick={() => setSelectedId(preset.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setSelectedId(preset.id);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{preset.name}</span>
              <span className="truncate text-muted-foreground">{layerName(preset.layer)}</span>
              <ListRowActions
                index={row}
                count={value.length}
                name={preset.name}
                testIdPrefix={testId}
                touchAdaptive
                removeDisabled={value.length <= 1}
                onMove={(delta) => {
                  const target = row + delta;
                  if (target < 0 || target >= value.length) return;
                  const next = [...value];
                  [next[row], next[target]] = [next[target]!, next[row]!];
                  onChange(next);
                }}
                onRemove={() => onChange(value.filter((_, index) => index !== row))}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-1">
          <Input
            aria-label="New Preset Name"
            className={`${ROW_CONTROL} min-w-0 flex-1`}
            value={draft}
            placeholder="New Preset"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
            data-testid={`${testId}-add-value`}
          />
          <Button type="button" variant="outline" size="sm" className={ROW_CONTROL} onClick={add} data-testid={`${testId}-add`}>
            Add Preset
          </Button>
        </div>
      </div>
      {selected ? (
        <div className="flex w-72 flex-col gap-1.5" data-testid={`${testId}-editor`}>
          <label className="grid grid-cols-[4rem_1fr] items-center gap-2 text-xs">
            Name
            <Input
              className={ROW_CONTROL}
              value={selected.name}
              onChange={(event) => patch(selectedIndex, { name: event.target.value })}
              data-testid={`${testId}-name`}
            />
          </label>
          <div className="grid grid-cols-[4rem_1fr] items-center gap-2 text-xs">
            <span>Layer</span>
            <Select
              value={String(layerIndex(selected.layer))}
              onValueChange={(next) => patch(selectedIndex, { layer: (1 << Number(next)) >>> 0 })}
            >
              <SelectTrigger
                aria-label={`${selected.name} Layer`}
                className="w-full py-0 text-xs data-[size=default]:h-6 pointer-coarse:data-[size=default]:h-9"
                data-testid={`${testId}-layer`}
              >
                <SelectValue>{() => layerName(selected.layer)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {layers.map((name, index) => (
                  <SelectItem key={name} value={String(index)}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <CollisionResponsesField
            layers={layers}
            value={selected}
            onChange={(responses) => patch(selectedIndex, responses)}
            data-testid={`${testId}-responses`}
          />
        </div>
      ) : null}
    </div>
  );
}
