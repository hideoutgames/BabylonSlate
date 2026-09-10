import { useEffect, useId, useState } from "react";
import { NumberField } from "@babylonslate/editor-kit";
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
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";

interface SnapValues {
  gridSize: number;
  snapRotateDeg: number;
  snapScale: number;
}

const FIELDS = [
  { key: "gridSize", label: "Grid Size", testId: "number-prompt-input" },
  {
    key: "snapRotateDeg",
    label: "Rotation Snap (Degrees)",
    testId: "rotation-snap-input",
  },
  { key: "snapScale", label: "Scale Snap", testId: "scale-snap-input" },
] as const;

export function GridSizeDialog({
  open,
  onOpenChange,
  initialValue,
  onSubmit,
  "data-testid": testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: SnapValues;
  onSubmit: (value: SnapValues) => void;
  "data-testid"?: string;
}) {
  const id = useId();
  const { gridSize, snapRotateDeg, snapScale } = initialValue;
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue({ gridSize, snapRotateDeg, snapScale });
  }, [open, gridSize, snapRotateDeg, snapScale]);

  const submit = (next = value) => {
    if (
      Object.values(next).some(
        (entry) => !Number.isFinite(entry) || entry < 0.0001,
      )
    )
      return;
    onSubmit(next);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>Grid Size</AlertDialogTitle>
          <AlertDialogDescription>
            Grid Size sets the visible cell size and move snap step. Set
            rotation and scale snap steps below.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {open ? (
          <FieldGroup>
            {FIELDS.map(({ key, label, testId: inputTestId }) => (
              <Field key={key}>
                <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
                <NumberField
                  id={`${id}-${key}`}
                  data-testid={inputTestId}
                  min={0.0001}
                  value={value[key]}
                  onChange={(next) =>
                    setValue((current) => ({ ...current, [key]: next }))
                  }
                  onEnter={(next) => submit({ ...value, [key]: next })}
                />
              </Field>
            ))}
          </FieldGroup>
        ) : null}
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
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
