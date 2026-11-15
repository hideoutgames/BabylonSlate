import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import {
  ANIM_BONE_AXES,
  ANIM_BONE_AXIS_LABELS,
  ANIM_SPRING_COLLIDER_KINDS,
  ANIM_SPRING_COLLIDER_LABELS,
  defaultAnimSpringCollider,
  normalizeAnimSpringBoneSettings,
  type AnimSpringCollider,
} from "@haptic/core";
import { PropertyGrid, SearchDialog, type PropertyRow } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { BoneNameList } from "./bone-name-list";
import { IconActionButton } from "./icon-action-button";

function boneOptions(bones: readonly string[], current: string): Array<{ value: string; label: string }> {
  const listed = current && !bones.includes(current) ? [current, ...bones] : bones;
  return listed.map((bone) => ({ value: bone, label: bone }));
}

/** One collider's rows: its shape, bone, offset and the sizes and axis its shape has. */
function colliderRows(index: number, collider: AnimSpringCollider, bones: readonly string[], change: (next: AnimSpringCollider) => void): PropertyRow[] {
  const id = `spring-collider-${index}`;
  const rows: PropertyRow[] = [
    {
      kind: "enum", id: `${id}-kind`, label: "Shape", value: collider.kind,
      options: ANIM_SPRING_COLLIDER_KINDS.map((value) => ({ value, label: ANIM_SPRING_COLLIDER_LABELS[value] })),
      onChange: (kind) => change({ ...collider, kind: kind as AnimSpringCollider["kind"] }),
    },
    {
      kind: "enum", id: `${id}-bone`, label: "Bone", value: collider.bone, options: boneOptions(bones, collider.bone), verbatim: true,
      onChange: (bone) => change({ ...collider, bone }),
    },
    {
      kind: "vector3", id: `${id}-offset`, label: "Offset", unit: "m", value: collider.offset as [number, number, number], defaultValue: [0, 0, 0],
      description: "Where the collider sits from its bone, in the bone's own axes.",
      onChange: (value) => change({ ...collider, offset: [value[0], value[1], value[2]] }),
    },
  ];
  if (collider.kind !== "plane") {
    rows.push({
      kind: "number", id: `${id}-radius`, label: "Radius", unit: "m", min: 0, value: collider.radius, defaultValue: 0.1,
      onChange: (radius) => change({ ...collider, radius: Math.max(0, radius) }),
    });
  }
  if (collider.kind === "capsule") {
    rows.push({
      kind: "number", id: `${id}-length`, label: "Length", unit: "m", min: 0, value: collider.length, defaultValue: 0.2,
      onChange: (length) => change({ ...collider, length: Math.max(0, length) }),
    });
  }
  if (collider.kind !== "sphere") {
    rows.push({
      kind: "enum", id: `${id}-axis`, label: collider.kind === "plane" ? "Normal" : "Axis", value: collider.axis, defaultValue: "y",
      options: ANIM_BONE_AXES.map((value) => ({ value, label: ANIM_BONE_AXIS_LABELS[value] })),
      ...(collider.kind === "plane" ? { description: "The bone's axis the plane faces; the chain stays on that side." } : {}),
      onChange: (axis) => change({ ...collider, axis: axis as AnimSpringCollider["axis"] }),
    });
  }
  return rows;
}

/**
 * Spring Bones' lists: the bones whose branches stay posed (Exclude Bones), and the colliders the chain stays out of,
 * each bound to a bone. Adding either picks a bone of the graph's Skeleton.
 */
export function SpringBonesLists({
  data,
  bones,
  onPatch,
}: {
  data: Record<string, unknown>;
  bones: readonly string[];
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [picking, setPicking] = useState(false);
  const settings = normalizeAnimSpringBoneSettings(data);
  const excluded = settings.excludeBones;
  const colliders = settings.colliders;
  const writeColliders = (next: AnimSpringCollider[]) => onPatch({ colliders: next });

  return (
    <div className="flex flex-col gap-3" data-testid="spring-bones-lists">
      <BoneNameList
        title="Exclude Bones"
        hint="These bones, and every bone below them, stay posed."
        addLabel="Add Bone"
        value={excluded}
        bones={bones}
        onChange={(excludeBones) => onPatch({ excludeBones })}
        testId="spring-bones-exclude"
      />
      <div className="flex flex-col gap-1" data-testid="spring-bones-colliders">
        <div className="text-sm font-medium">Colliders</div>
        {colliders.map((collider, index) => (
          <div key={index} className="flex flex-col gap-1 rounded-sm border border-border p-1" data-testid={`spring-collider-${index}`}>
            <div className="flex min-w-0 items-center gap-1 px-1">
              <span className="min-w-0 flex-1 truncate text-sm">{`${ANIM_SPRING_COLLIDER_LABELS[collider.kind]} on ${collider.bone}`}</span>
              <IconActionButton
                label={`Remove Collider ${index + 1}`}
                variant="ghost"
                data-testid={`spring-collider-remove-${index}`}
                onClick={() => writeColliders(colliders.filter((_, at) => at !== index))}
              >
                <Trash2Icon />
              </IconActionButton>
            </div>
            <PropertyGrid
              rows={colliderRows(index, collider, bones, (next) => writeColliders(colliders.map((entry, at) => (at === index ? next : entry))))}
              density="compact"
            />
          </div>
        ))}
        <Button
          type="button" variant="outline" size="sm" className="ml-1 w-fit" disabled={bones.length === 0}
          data-testid="spring-collider-add" onClick={() => setPicking(true)}
        >
          Add Collider
        </Button>
      </div>
      {bones.length === 0 ? <div className="text-muted-foreground px-1 text-sm">Set the graph's Skeleton to pick bones.</div> : null}
      <SearchDialog
        open={picking}
        onOpenChange={setPicking}
        title="Add Collider"
        items={bones.map((bone) => ({ id: bone, label: bone }))}
        onSelect={(bone) => {
          writeColliders([...colliders, defaultAnimSpringCollider(bone)]);
          setPicking(false);
        }}
        data-testid="spring-collider-picker"
      />
    </div>
  );
}
