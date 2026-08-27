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
import { Textarea } from "@babylonslate/ui/components/textarea";
import { cn } from "@babylonslate/ui/lib/utils";
import { MarkupAutocompleteTextarea } from "./markup-autocomplete";

export type MultilineTextFieldProps = {
  value: string;
  onChange: (value: string) => void;
  title: string;
  description?: string;
  disabled?: boolean;
  markup?: boolean;
  id?: string;
  className?: string;
  editorClassName?: string;
  "data-testid"?: string;
};

/** Read-only Details trigger that opens a large modal multiline editor. */
export function MultilineTextField({
  value,
  onChange,
  title,
  description,
  disabled,
  markup,
  id,
  className,
  editorClassName,
  "data-testid": testId,
}: MultilineTextFieldProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const finish = () => {
    if (!open) return;
    if (draft !== value) onChange(draft);
    setOpen(false);
  };

  const preview = value.trim() ? value : "Empty";
  const editorTestId = testId ? `${testId}-editor` : undefined;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        id={id}
        disabled={disabled}
        className={cn(
          "h-auto min-h-16 w-full items-start justify-start whitespace-pre-wrap py-2 text-left font-normal",
          !value.trim() && "text-muted-foreground",
          className,
        )}
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        <span className="line-clamp-4 break-words">{preview}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) finish();
          else setOpen(true);
        }}
      >
        <DialogContent
          className="flex h-[min(90vh,52rem)] w-[min(96vw,64rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
          data-testid={testId ? `${testId}-dialog` : undefined}
        >
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {description ?? "Edit in a larger field. Suggestions sit above the text."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col p-4">
            {markup ? (
              <MarkupAutocompleteTextarea
                id={id ? `${id}-editor` : undefined}
                value={draft}
                onChange={setDraft}
                disabled={disabled}
                className={cn("min-h-0 flex-1 font-mono text-sm", editorClassName)}
                data-testid={editorTestId}
              />
            ) : (
              <Textarea
                id={id ? `${id}-editor` : undefined}
                value={draft}
                disabled={disabled}
                className={cn("min-h-0 flex-1", editorClassName)}
                onChange={(event) => setDraft(event.target.value)}
                data-testid={editorTestId}
              />
            )}
          </div>
          <DialogFooter className="m-0">
            <Button
              type="button"
              variant="outline"
              onClick={finish}
              data-testid={testId ? `${testId}-done` : undefined}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
