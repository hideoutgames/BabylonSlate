import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import type { AnimBranchFilter } from "@haptic/core";
import { LabelHint, PropertyGrid, SearchDialog } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { IconActionButton } from "./icon-action-button";
import { layeredBlendBranchLists, patchLayeredBlendBranches } from "../lib/layered-blend-branches";

/**
 * A Layered Blend Per Bone's branch filters, per blend input: the bones its pose plays on, each with its Blend Depth.
 * Add Branch picks from the graph's Skeleton's bones.
 */
export function LayeredBlendBranchFilters({
  data,
  bones,
  onPatch,
}: {
  data: Record<string, unknown>;
  bones: readonly string[];
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [picking, setPicking] = useState<number | null>(null);
  const lists = layeredBlendBranchLists(data);
  const write = (index: number, branches: AnimBranchFilter[]) => onPatch(patchLayeredBlendBranches(data, index, branches));
  const pickingList = picking === null ? [] : lists[picking] ?? [];
  return (
    <div className="flex flex-col gap-3" data-testid="layered-blend-branches">
      {lists.map((branches, index) => (
        <div key={index} className="flex flex-col gap-1" data-testid={`layered-blend-branches-${index}`}>
          <LabelHint hint="Blend Depth 0 blends the bone and every bone below it fully; N ramps in over N bones; -1 leaves the branch out.">
            <div className="w-fit text-sm font-medium">{`Blend Pose ${index} Branches`}</div>
          </LabelHint>
          {branches.map((branch, row) => (
            <div key={`${branch.bone}:${row}`} className="flex min-w-0 items-center gap-1 px-1">
              <span className="min-w-0 flex-1 truncate text-sm" title={branch.bone}>{branch.bone}</span>
              <div className="w-24 shrink-0">
                <PropertyGrid
                  rows={[{
                    kind: "number",
                    id: `branch-${index}-${row}`,
                    label: `${branch.bone} Blend Depth`,
                    value: branch.blendDepth,
                    defaultValue: 0,
                    min: -1,
                    precision: 0,
                    sensitivity: 0.1,
                    onChange: (depth) =>
                      write(index, branches.map((entry, at) => (at === row ? { ...entry, blendDepth: Math.round(depth) } : entry))),
                  }]}
                  hideLabels
                  density="compact"
                  orientation="horizontal"
                />
              </div>
              <IconActionButton
                label={`Remove ${branch.bone}`}
                variant="ghost"
                data-testid={`layered-blend-branch-remove-${index}-${row}`}
                onClick={() => write(index, branches.filter((_, at) => at !== row))}
              >
                <Trash2Icon />
              </IconActionButton>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-1 w-fit"
            disabled={bones.length === 0}
            data-testid={`layered-blend-branch-add-${index}`}
            onClick={() => setPicking(index)}
          >
            Add Branch
          </Button>
        </div>
      ))}
      {bones.length === 0 ? <div className="text-muted-foreground px-1 text-sm">Set the graph's Skeleton to pick bones.</div> : null}
      <SearchDialog
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) setPicking(null);
        }}
        title="Add Branch"
        items={bones.filter((bone) => !pickingList.some((branch) => branch.bone === bone)).map((bone) => ({ id: bone, label: bone }))}
        onSelect={(bone) => {
          if (picking !== null) write(picking, [...pickingList, { bone, blendDepth: 0 }]);
          setPicking(null);
        }}
        data-testid="layered-blend-branch-picker"
      />
    </div>
  );
}
