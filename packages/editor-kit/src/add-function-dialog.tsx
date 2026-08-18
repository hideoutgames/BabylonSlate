import { useEffect, useState } from "react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { PickerIdentity } from "./picker-identity";

export type AddFunctionDialogItem = {
  id: string;
  name: string;
  description: string;
  overwritten: boolean;
  kind: string;
};

export interface AddFunctionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: AddFunctionDialogItem[];
  onCreateEmpty: (name: string) => void;
  onPick: (id: string) => void;
  title?: string;
  description?: string;
  emptyLabel?: string;
  nameLabel?: string;
  "data-testid"?: string;
}

function testIdPrefix(testId: string): string {
  return testId.replace(/-dialog$/, "");
}

/** Larger Add Function picker: empty function plus overridable/interface rows. */
export function AddFunctionDialog({
  open,
  onOpenChange,
  items,
  onCreateEmpty,
  onPick,
  title = "Add Function",
  description = "Create an empty function or implement an overridable one.",
  emptyLabel = "New Empty Function",
  nameLabel = "Function Name",
  "data-testid": testId = "add-function-dialog",
}: AddFunctionDialogProps) {
  const [mode, setMode] = useState<"empty" | "pick">("empty");
  const [draft, setDraft] = useState("");
  const prefix = testIdPrefix(testId);

  useEffect(() => {
    if (open) {
      setMode("empty");
      setDraft("");
    }
  }, [open]);

  const submitEmpty = () => {
    const name = draft.trim();
    if (!name) return;
    onCreateEmpty(name);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(36rem,80vh)] w-full max-w-lg flex-col gap-3 overflow-hidden sm:max-w-lg"
        data-testid={testId}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant={mode === "empty" ? "secondary" : "ghost"}
          size="touch"
          className="w-full justify-start"
          data-testid={`${prefix}-empty`}
          onClick={() => setMode("empty")}
        >
          {emptyLabel}
        </Button>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1" data-testid={`${prefix}-list`}>
            {items.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                size="touch"
                className={`w-full justify-between gap-2 text-left ${
                  item.overwritten ? "text-muted-foreground" : ""
                }`}
                disabled={item.overwritten}
                data-testid={`${prefix}-item-${item.id}`}
                data-overwritten={item.overwritten ? "true" : "false"}
                onClick={() => {
                  if (item.overwritten) return;
                  onPick(item.id);
                  onOpenChange(false);
                }}
              >
                <PickerIdentity
                  label={item.name}
                  description={
                    item.overwritten
                      ? `${item.description} · Overwritten`
                      : item.description
                  }
                />
              </Button>
            ))}
          </div>
        </ScrollArea>
        {mode === "empty" ? (
          <Field>
            <FieldLabel htmlFor={`${prefix}-name`}>{nameLabel}</FieldLabel>
            <Input
              id={`${prefix}-name`}
              className="min-h-[var(--touch-target,44px)]"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitEmpty();
                }
              }}
              data-testid={`${prefix}-name`}
            />
          </Field>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid={`${prefix}-cancel`}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {mode === "empty" ? (
            <Button
              type="button"
              data-testid={`${prefix}-confirm`}
              onClick={submitEmpty}
            >
              Add
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
