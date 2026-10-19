import { useState } from "react";
import { newCollisionPresetId, type CollisionPreset } from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { ListRowActions } from "./list-row-actions";

export interface CollisionPresetsFieldProps {
  /** Collision layer names, bit 0 first. */
  layers: readonly string[];
  value: readonly CollisionPreset[];
  onChange: (next: CollisionPreset[]) => void;
  "data-testid"?: string;
}

const ROW_CONTROL = "h-6 text-xs pointer-coarse:h-9";

const layerIndex = (layer: number) => {
  const index = Math.clz32(layer & -layer) ^ 31;
  return layer === 0 ? -1 : index;
};

/**
 * Collision Presets as a grid: one row per preset with its name, Layer and a
 * checkbox per collision layer it collides with. Rows reorder and delete with
 * the list row actions; the last preset cannot be deleted.
 */
export function CollisionPresetsField({
  layers,
  value,
  onChange,
  "data-testid": testId = "collision-presets",
}: CollisionPresetsFieldProps) {
  const [draft, setDraft] = useState("");
  const patch = (index: number, change: Partial<CollisionPreset>) =>
    onChange(value.map((preset, row) => (row === index ? { ...preset, ...change } : preset)));
  const add = () => {
    const name = draft.trim();
    if (!name) return;
    onChange([...value, { id: newCollisionPresetId(name, value), name, layer: 1, mask: 0xffffffff }]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-x-1 border-spacing-y-0.5 text-xs" role="grid" aria-label="Collision Presets">
          <thead>
            <tr>
              <th scope="col" className="px-0 text-left align-bottom font-normal text-muted-foreground">Preset</th>
              <th scope="col" className="px-0 text-left align-bottom font-normal text-muted-foreground">Layer</th>
              {layers.map((name) => (
                <th key={name} scope="col" className="w-5 p-0 align-bottom font-normal text-muted-foreground">
                  <span className="mx-auto block max-h-24 truncate [writing-mode:vertical-rl] rotate-180 pb-1">{name}</span>
                </th>
              ))}
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {value.map((preset, row) => {
              const current = layerIndex(preset.layer);
              return (
                <tr key={preset.id}>
                  <td className="p-0">
                    <Input
                      aria-label={`Preset ${row + 1} Name`}
                      className={`${ROW_CONTROL} w-32`}
                      value={preset.name}
                      onChange={(event) => patch(row, { name: event.target.value })}
                      data-testid={`${testId}-${row}-name`}
                    />
                  </td>
                  <td className="p-0">
                    <Select
                      value={String(current)}
                      onValueChange={(next) => patch(row, { layer: (1 << Number(next)) >>> 0 })}
                    >
                      <SelectTrigger
                        aria-label={`${preset.name} Layer`}
                        className="w-28 py-0 text-xs data-[size=default]:h-6 pointer-coarse:data-[size=default]:h-9"
                        data-testid={`${testId}-${row}-layer`}
                      >
                        <SelectValue>{() => layers[current] ?? `Layer ${current + 1}`}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {layers.map((name, index) => (
                          <SelectItem key={name} value={String(index)}>{name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  {layers.map((name, index) => (
                    <td key={name} className="p-0 text-center">
                      <Checkbox
                        className="size-3.5"
                        checked={((preset.mask >>> index) & 1) === 1}
                        aria-label={`${preset.name} Collides With ${name}`}
                        data-testid={`${testId}-${row}-${index}`}
                        onCheckedChange={(checked) =>
                          patch(row, { mask: (checked === true ? preset.mask | (1 << index) : preset.mask & ~(1 << index)) >>> 0 })
                        }
                      />
                    </td>
                  ))}
                  <td className="p-0">
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex gap-1">
        <Input
          aria-label="Add Preset"
          className={`${ROW_CONTROL} w-32`}
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
  );
}
