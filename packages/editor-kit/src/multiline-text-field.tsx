import { useState, type ReactNode } from "react";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Textarea } from "@haptic/ui/components/textarea";
import { cn } from "@haptic/ui/lib/utils";
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
  code?: boolean;
  renderPreview?: (value: string) => ReactNode;
  renderEditor?: (value: string, onChange: (value: string) => void) => ReactNode;
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
  code,
  renderPreview,
  renderEditor,
  "data-testid": testId,
}: MultilineTextFieldProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  // Seed only when the editor opens; a value change while open keeps the typing.
  const openEditor = () => {
    setDraft(value);
    setOpen(true);
  };

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
        onClick={openEditor}
        data-testid={testId}
      >
        {renderPreview ? renderPreview(value) : <span className="line-clamp-4 break-words">{preview}</span>}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) finish();
          else if (!open) openEditor();
        }}
      >
        <DialogContent
          className={cn("editor-dialog-large max-w-none sm:max-w-none", code && "rounded-md")}
          bodyClassName="flex flex-col gap-0 overflow-hidden p-0"
          data-testid={testId ? `${testId}-dialog` : undefined}
        >
          <DialogHeader className={cn("shrink-0 border-b pr-14", code ? "min-h-11 px-3 py-2" : "min-h-14 px-4 py-3")}>
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className={cn("flex min-h-0 flex-1 flex-col", !code && "p-4")}>
            {renderEditor ? renderEditor(draft, setDraft) : markup ? (
              <MarkupAutocompleteTextarea
                id={id ? `${id}-editor` : undefined}
                value={draft}
                onChange={setDraft}
                disabled={disabled}
                className="min-h-0 flex-1 font-mono text-sm"
                data-testid={editorTestId}
              />
            ) : (
              <Textarea
                id={id ? `${id}-editor` : undefined}
                value={draft}
                disabled={disabled}
                className="min-h-0 flex-1"
                onChange={(event) => setDraft(event.target.value)}
                data-testid={editorTestId}
              />
            )}
          </div>
          <DialogFooter className="m-0 pt-3">
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
