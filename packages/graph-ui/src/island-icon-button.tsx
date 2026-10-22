import type { ComponentProps, ReactNode } from "react";
import { Button } from "@haptic/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";

/** An icon-only toolbar island action whose label is its accessible name and tooltip. */
export function IslandIconButton({
  label,
  hint,
  side,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label" | "title"> & {
  label: string;
  /** Longer tooltip text; defaults to the label. */
  hint?: ReactNode;
  side?: ComponentProps<typeof TooltipContent>["side"];
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button type="button" variant="outline" size="icon-sm" aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}
