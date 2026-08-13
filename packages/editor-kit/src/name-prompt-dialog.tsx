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
import { Input } from "@babylonslate/ui/components/input";

export interface NamePromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  description?: string;
  confirmLabel?: string;
  onSubmit: (name: string) => void;
  "data-testid"?: string;
}

/** Touch-friendly name prompt that replaces `window.prompt`. */
export function NamePromptDialog({
  open,
  onOpenChange,
  title,
  label,
  description,
  confirmLabel = "Add",
  onSubmit,
  "data-testid": testId,
}: NamePromptDialogProps) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (open) setDraft("");
  }, [open]);

  const submit = () => {
    const name = draft.trim();
    if (!name) return;
    onSubmit(name);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId ?? "name-prompt-dialog"}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : (
            <AlertDialogDescription>{label}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="name-prompt-input">{label}</FieldLabel>
          <Input
            id="name-prompt-input"
            className="min-h-[var(--touch-target,44px)]"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            data-testid="name-prompt-input"
          />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="name-prompt-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="name-prompt-confirm"
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
