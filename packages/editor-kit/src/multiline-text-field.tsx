import type { ReactNode } from "react";
import { PictureInPicture2Icon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { FieldLabel } from "@haptic/ui/components/field";
import { Textarea } from "@haptic/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { cn } from "@haptic/ui/lib/utils";
import { useEditorReadOnly } from "./editor-read-only";
import { LabelHint } from "./label-hint";
import { MarkupAutocompleteTextarea } from "./markup-autocomplete";
import { commitOnFocusLeave, useTextDraft } from "./text-draft";

/** The pop-out button's icon, chosen in this one place. */
const OpenInTabIcon = PictureInPicture2Icon;

export type MultilineTextFieldProps = {
  /** The property name shown above the field. */
  label: string;
  /** Optional `LabelHint` tooltip for the label. */
  hint?: string;
  value: string;
  /** Called with the committed text: when focus leaves the field, or on unmount with a pending draft. */
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Hosts `MarkupAutocompleteTextarea` inline. */
  markup?: boolean;
  /** Code styling and the taller fixed height. */
  code?: boolean;
  /** Id of the inline editor control; the label's `htmlFor`. */
  id?: string;
  className?: string;
  /** Replaces the default inline editor. Receives the draft and a draft setter. */
  renderEditor?: (value: string, onChange: (value: string) => void) => ReactNode;
  /** Present: the Open {label} in Tab button is shown beside the label. */
  onOpenInTab?: () => void;
  "data-testid"?: string;
};

/**
 * A multi-line Inspector property edited in place at a fixed height (it
 * scrolls inside itself), with a label row and, given `onOpenInTab`, a
 * button that opens the value full size in its own document tab.
 */
export function MultilineTextField({
  label,
  hint,
  value,
  onChange,
  disabled,
  markup,
  code,
  id,
  className,
  renderEditor,
  onOpenInTab,
  "data-testid": testId,
}: MultilineTextFieldProps) {
  const readOnly = useEditorReadOnly();
  const { draft, setDraft, commit } = useTextDraft(value, onChange);
  const editorTestId = testId ? `${testId}-editor` : undefined;
  const height = code ? "h-40" : "h-24";
  const fieldLabel = <FieldLabel htmlFor={id}>{label}</FieldLabel>;
  const openLabel = `Open ${label} in Tab`;

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-2", className)}
      data-testid={testId}
      onBlur={commitOnFocusLeave(commit)}
    >
      <div className="flex min-w-0 items-center gap-1" data-testid={testId ? `${testId}-label-row` : undefined}>
        {hint ? <LabelHint hint={hint}>{fieldLabel}</LabelHint> : fieldLabel}
        {onOpenInTab ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-6 min-w-6 px-0 text-muted-foreground pointer-coarse:size-[var(--touch-target)]"
                  aria-label={openLabel}
                  onClick={onOpenInTab}
                  data-testid={testId ? `${testId}-open-tab` : undefined}
                />
              }
            >
              <OpenInTabIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>{openLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {renderEditor ? (
        <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg border border-input", height)}>
          {renderEditor(draft, setDraft)}
        </div>
      ) : markup ? (
        <MarkupAutocompleteTextarea
          id={id}
          value={draft}
          onChange={setDraft}
          disabled={disabled}
          readOnly={readOnly}
          className={cn("min-h-0 resize-none font-mono text-sm field-sizing-fixed", height)}
          data-testid={editorTestId}
        />
      ) : (
        <Textarea
          id={id}
          value={draft}
          disabled={disabled}
          readOnly={readOnly}
          className={cn("min-h-0 resize-none field-sizing-fixed", code && "font-mono text-xs", height)}
          onChange={(event) => setDraft(event.target.value)}
          data-testid={editorTestId}
        />
      )}
    </div>
  );
}
