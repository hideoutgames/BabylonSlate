import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import { LabelHint, SearchDialog } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { IconActionButton } from "./icon-action-button";

/**
 * A list of bone names picked from a Skeleton: each row shows the name as it is, with Remove; Add picks a bone not yet
 * listed through a SearchDialog. With no bones to pick, Add is disabled.
 */
export function BoneNameList({
  title,
  hint,
  addLabel,
  value,
  bones,
  onChange,
  testId,
}: {
  title: string;
  /** The title's tooltip, when the title cannot say what the list does. */
  hint?: string;
  addLabel: string;
  value: readonly string[];
  bones: readonly string[];
  onChange: (next: string[]) => void;
  testId: string;
}) {
  const [picking, setPicking] = useState(false);
  const heading = <div className="w-fit text-sm font-medium">{title}</div>;
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      {hint ? <LabelHint hint={hint}>{heading}</LabelHint> : heading}
      {value.map((bone) => (
        <div key={bone} className="flex min-w-0 items-center gap-1 px-1">
          <span className="min-w-0 flex-1 truncate text-sm" title={bone}>{bone}</span>
          <IconActionButton
            label={`Remove ${bone}`}
            variant="ghost"
            data-testid={`${testId}-remove-${bone}`}
            onClick={() => onChange(value.filter((entry) => entry !== bone))}
          >
            <Trash2Icon />
          </IconActionButton>
        </div>
      ))}
      <Button
        type="button" variant="outline" size="sm" className="ml-1 w-fit" disabled={bones.length === 0}
        data-testid={`${testId}-add`} onClick={() => setPicking(true)}
      >
        {addLabel}
      </Button>
      <SearchDialog
        open={picking}
        onOpenChange={setPicking}
        title={addLabel}
        items={bones.filter((bone) => !value.includes(bone)).map((bone) => ({ id: bone, label: bone }))}
        onSelect={(bone) => {
          onChange([...value, bone]);
          setPicking(false);
        }}
        data-testid={`${testId}-picker`}
      />
    </div>
  );
}
