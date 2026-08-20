import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { NumberField } from "./number-field";

export interface NumberPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  description?: string;
  confirmLabel?: string;
  initialValue: number;
  min?: number;
  onSubmit: (value: number) => void;
  "data-testid"?: string;
}

/** Touch-friendly number prompt seeded with a saved value. */
export function NumberPromptDialog({
  open,
  onOpenChange,
  title,
  label,
  description,
  confirmLabel = "Save",
  initialValue,
  min = 0.0001,
  onSubmit,
  "data-testid": testId,
}: NumberPromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = () => {
    if (!Number.isFinite(value) || value < min) return;
    onSubmit(value);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId ?? "number-prompt-dialog"}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : (
            <AlertDialogDescription>{label}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="number-prompt-input">{label}</FieldLabel>
          <NumberField
            id="number-prompt-input"
            min={min}
            className="min-h-[var(--touch-target,44px)]"
            data-testid="number-prompt-input"
            value={value}
            onChange={setValue}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="number-prompt-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="number-prompt-confirm"
            onClick={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
