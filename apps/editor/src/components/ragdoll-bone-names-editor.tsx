import { useEffect, useMemo, useState } from "react";
import { parseRagdollProperties } from "@haptic/core";
import { LabelHint, NamedListEditor, SearchDialog } from "@haptic/editor-kit";
import { Field, FieldDescription, FieldError } from "@haptic/ui/components/field";
import { useRegistryState } from "../context/document-context";
import { actorSkeletonBoneNames } from "../lib/skeleton-attach-points";

const ALL_BONES: string[] = [];
const NO_COMPONENTS: readonly { classId: string; properties: Record<string, unknown> }[] = [];

/**
 * Optional connected skeleton subset; empty selects every bone in the Model. With the actor's Model on a Skeleton,
 * Add Bone picks from its bones; otherwise names are typed.
 */
export function RagdollBoneNamesEditor({
  boneNames = ALL_BONES,
  components = NO_COMPONENTS,
  onChange,
  "data-testid": testId = "ragdoll-bone-names",
}: {
  boneNames?: string[];
  /** The actor's (or Class's) components, whose Mesh Model's Skeleton offers the bones. */
  components?: readonly { classId: string; properties: Record<string, unknown> }[];
  onChange: (boneNames: string[]) => void;
  "data-testid"?: string;
}) {
  const [draft, setDraft] = useState(boneNames);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const { assetRegistry, registryEpoch } = useRegistryState();
  const skeletonBones = useMemo(() => {
    void registryEpoch;
    return actorSkeletonBoneNames(components, (guid) => assetRegistry?.getByGuid(guid));
  }, [assetRegistry, components, registryEpoch]);
  useEffect(() => {
    setDraft(boneNames);
    setError(null);
  }, [boneNames]);
  const commit = (names: string[]) => {
    setDraft(names);
    try {
      parseRagdollProperties({ boneNames: names });
      setError(null);
      onChange(names);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invalid bone names.");
    }
  };
  return (
    <Field data-invalid={Boolean(error)} className="p-2">
      {/* The title sits where NamedListEditor would put it, so it can carry the hint. */}
      <div className="flex flex-col gap-1">
        <LabelHint hint="For a partial ragdoll, enter exact bone names forming one connected chain or subtree, including the connecting parents.">
          <div className="w-fit text-sm font-medium">Bone Names</div>
        </LabelHint>
        <NamedListEditor
          itemLabel="Bone Name"
          addLabel="Add Bone"
          addPlaceholder="Exact Bone Name"
          values={draft}
          onChange={commit}
          onAdd={skeletonBones.length > 0 ? () => setPicking(true) : undefined}
          data-testid={testId}
        />
        <SearchDialog
          open={picking}
          onOpenChange={setPicking}
          title="Add Bone"
          items={skeletonBones.filter((name) => !draft.includes(name)).map((name) => ({ id: name, label: name }))}
          onSelect={(name) => {
            setPicking(false);
            commit([...draft, name]);
          }}
          data-testid={`${testId}-picker`}
        />
      </div>
      {draft.length === 0 ? <FieldDescription>Uses the complete skeleton.</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
