import { LabelHint } from "@haptic/editor-kit";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Switch } from "@haptic/ui/components/switch";

/** The Compact Mode switch, shared by the Account dialog and Engine Settings. */
export function CompactModeField({
  id,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="settings-field">
      <LabelHint hint="Small controls and rows for a mouse or trackpad; turn it off for larger touch targets. On by default except on iPhone, iPad and Android.">
        <FieldLabel htmlFor={id}>Compact Mode</FieldLabel>
      </LabelHint>
      <Switch
        id={id}
        data-testid={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  );
}
