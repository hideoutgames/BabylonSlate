import type { ComponentProps } from "react";
import {
  ariaKeyShortcuts,
  ShortcutKeys,
  type KeyChord,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";

/** Icon-only control with aria-label plus a tooltip (hover is secondary). */
export function IconActionButton({
  label,
  shortcut,
  children,
  variant = "outline",
  size = "icon-sm",
  ...props
}: ComponentProps<typeof Button> & {
  label: string;
  /** Chord shown beside the tooltip label. */
  shortcut?: KeyChord;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            size={size}
            {...props}
            aria-label={label}
            aria-keyshortcuts={shortcut ? ariaKeyShortcuts(shortcut) : undefined}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <ShortcutKeys chord={shortcut} decorative />
      </TooltipContent>
    </Tooltip>
  );
}
