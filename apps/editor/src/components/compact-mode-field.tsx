import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Switch } from "@babylonslate/ui/components/switch";

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
      <FieldContent>
        <FieldLabel htmlFor={id}>Compact Mode</FieldLabel>
        <FieldDescription>
          Small controls and rows for a mouse or trackpad. Turn off for larger
          touch targets. On by default except on iPhone, iPad and Android.
        </FieldDescription>
      </FieldContent>
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
