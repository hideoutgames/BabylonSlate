import { useEffect, useState } from "react";
import { parseRagdollProperties } from "@haptic/core";
import { LabelHint, NamedListEditor } from "@haptic/editor-kit";
import { Field, FieldDescription, FieldError } from "@haptic/ui/components/field";

const ALL_BONES: string[] = [];

/** Optional connected skeleton subset; empty selects every bone in the Model. */
export function RagdollBoneNamesEditor({
  boneNames = ALL_BONES,
  onChange,
  "data-testid": testId = "ragdoll-bone-names",
}: {
  boneNames?: string[];
  onChange: (boneNames: string[]) => void;
  "data-testid"?: string;
}) {
  const [draft, setDraft] = useState(boneNames);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(boneNames);
    setError(null);
  }, [boneNames]);
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
          onChange={(names) => {
            setDraft(names);
            try {
              parseRagdollProperties({ boneNames: names });
              setError(null);
              onChange(names);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : "Invalid bone names.");
            }
          }}
          data-testid={testId}
        />
      </div>
      {draft.length === 0 ? <FieldDescription>Uses the complete skeleton.</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
