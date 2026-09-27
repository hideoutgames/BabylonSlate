import { useEffect, useState } from "react";
import { parseRagdollProperties } from "@babylonslate/core";
import { NamedListEditor } from "@babylonslate/editor-kit";
import { Field, FieldDescription, FieldError } from "@babylonslate/ui/components/field";

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
      <NamedListEditor
        title="Bone Names"
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
      <FieldDescription>
        Empty uses the complete skeleton. For a partial ragdoll, enter exact bone names forming one connected chain or subtree, including the connecting parents.
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
