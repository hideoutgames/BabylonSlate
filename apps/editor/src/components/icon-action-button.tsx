import type { ComponentProps } from "react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";

/** Icon-only control with aria-label plus a tooltip (hover is secondary). */
export function IconActionButton({
  label,
  children,
  variant = "outline",
  size = "icon-sm",
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant={variant} size={size} {...props} aria-label={label} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
