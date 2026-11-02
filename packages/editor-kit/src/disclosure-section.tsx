import { useId, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { FieldLegend, FieldSet } from "@haptic/ui/components/field";
import { cn } from "@haptic/ui/lib/utils";

export interface DisclosureSectionProps {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  "data-testid"?: string;
}

/**
 * Controlled framed sub-category: a shaded header bar that toggles and a body
 * inside the same border. Callers keep disclosure state apart from data.
 */
export function DisclosureSection({
  title,
  open,
  onOpenChange,
  children,
  "data-testid": testId,
}: DisclosureSectionProps) {
  const contentId = useId();
  const Icon = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <FieldSet
      data-slot="disclosure-section"
      data-open={open ? "true" : "false"}
      className="gap-0 overflow-hidden rounded-md border bg-card"
      data-testid={testId}
    >
      {/*
        Floated so the legend sits inside the frame instead of on its border.
        Its own rounding matches the frame's inner corners (top, and bottom
        while collapsed), so the shaded bar never pokes past the outline where
        a browser does not clip the legend.
      */}
      <FieldLegend
        variant="label"
        className={cn(
          "float-left mb-0 w-full rounded-t-[calc(var(--radius-md)-1px)] bg-panel-header",
          !open && "rounded-b-[calc(var(--radius-md)-1px)]",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start rounded-[inherit] font-semibold aria-expanded:bg-transparent aria-expanded:hover:bg-accent pointer-coarse:min-h-11"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => onOpenChange(!open)}
        >
          <Icon data-icon="inline-start" aria-hidden="true" />
          {title}
        </Button>
      </FieldLegend>
      <div
        id={contentId}
        data-slot="disclosure-section-content"
        hidden={!open}
        className="clear-both border-t px-2.5 py-2"
      >
        {open ? children : null}
      </div>
    </FieldSet>
  );
}
