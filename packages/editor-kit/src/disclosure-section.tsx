import { useId, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";

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
 *
 * A group named by its header, not a fieldset: WebKit ignores `float` on a
 * `<legend>` and keeps it in the fieldset's border, where it does not hit-test
 * a positioned header button (the touch layout's hit areas), so taps landed on
 * the legend and the section never opened.
 */
export function DisclosureSection({
  title,
  open,
  onOpenChange,
  children,
  "data-testid": testId,
}: DisclosureSectionProps) {
  const contentId = useId();
  const headerId = useId();
  const Icon = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div
      role="group"
      aria-labelledby={headerId}
      data-slot="disclosure-section"
      data-open={open ? "true" : "false"}
      className="flex flex-col overflow-hidden rounded-md border bg-card"
      data-testid={testId}
    >
      <div className="bg-panel-header text-sm">
        <Button
          id={headerId}
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start rounded-none font-semibold aria-expanded:bg-transparent aria-expanded:hover:bg-accent pointer-coarse:min-h-11"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => onOpenChange(!open)}
        >
          <Icon data-icon="inline-start" aria-hidden="true" />
          {title}
        </Button>
      </div>
      <div
        id={contentId}
        data-slot="disclosure-section-content"
        hidden={!open}
        className="border-t px-2.5 py-2"
      >
        {open ? children : null}
      </div>
    </div>
  );
}
