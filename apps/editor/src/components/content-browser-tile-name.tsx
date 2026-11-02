import { InlineRenameInput, SelectableText } from "@haptic/editor-kit";
import { CardTitle } from "@haptic/ui/components/card";

/**
 * A grid tile's name row: the title, or its inline rename field in the same
 * 20px row on every pointer, so the type line under it stays in place.
 */
export function ContentBrowserTileName({
  name,
  renameValue = name,
  editing,
  onRenameDone,
  "aria-label": label,
  "data-testid": testId,
}: {
  name: string;
  /** The field's starting text, when it differs from the shown name. */
  renameValue?: string;
  editing: boolean;
  /** The trimmed new name, or null when cancelled or unchanged. */
  onRenameDone?: (name: string | null) => void;
  "aria-label": string;
  "data-testid": string;
}) {
  if (editing) {
    return (
      <InlineRenameInput
        value={renameValue}
        aria-label={label}
        data-testid={testId}
        // The field's border and padding sit in the header's side padding, so
        // the text stays where the title was.
        className="-mx-1 h-5 min-h-5 w-[calc(100%+0.5rem)] flex-none text-xs md:text-xs pointer-coarse:h-5"
        onDone={(next) => onRenameDone?.(next)}
      />
    );
  }
  return (
    <CardTitle className="h-5 truncate text-xs leading-5 font-medium">
      <SelectableText>{name}</SelectableText>
    </CardTitle>
  );
}
