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
  kind: "interface" | "function";
};

export interface AddFunctionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: AddFunctionDialogItem[];
  onCreateEmpty: (name: string) => void;
  onPick: (id: string) => void;
  "data-testid"?: string;
}

/** Larger Add Function picker: empty function plus overridable/interface rows. */
export function AddFunctionDialog({
  open,
  onOpenChange,
  items,
  onCreateEmpty,
  onPick,
  "data-testid": testId = "add-function-dialog",
}: AddFunctionDialogProps) {
  const [mode, setMode] = useState<"empty" | "pick">("empty");
  const [draft, setDraft] = useState("");

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
          <DialogTitle>Add Function</DialogTitle>
          <DialogDescription>
            Create an empty function or implement an overridable one.
          </DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant={mode === "empty" ? "secondary" : "ghost"}
          size="touch"
          className="w-full justify-start"
          data-testid="add-function-empty"
          onClick={() => setMode("empty")}
        >
          New Empty Function
        </Button>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1" data-testid="add-function-list">
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
                data-testid={`add-function-item-${item.id}`}
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
            <FieldLabel htmlFor="add-function-name">Function Name</FieldLabel>
            <Input
              id="add-function-name"
              className="min-h-[var(--touch-target,44px)]"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitEmpty();
                }
              }}
              data-testid="add-function-name"
            />
          </Field>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="add-function-cancel"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {mode === "empty" ? (
            <Button
              type="button"
              data-testid="add-function-confirm"
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
