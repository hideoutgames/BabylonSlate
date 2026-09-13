import { useId, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { FieldLegend, FieldSet } from "@babylonslate/ui/components/field";

export interface DisclosureSectionProps {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  "data-testid"?: string;
}

/** Controlled compact category; callers keep disclosure state apart from data. */
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
    <FieldSet className="gap-2" data-testid={testId}>
      <FieldLegend variant="label" className="mb-0 w-full">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start pointer-coarse:min-h-11"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => onOpenChange(!open)}
        >
          <Icon data-icon="inline-start" aria-hidden="true" />
          {title}
        </Button>
      </FieldLegend>
      <div id={contentId} hidden={!open}>
        {open ? children : null}
      </div>
    </FieldSet>
  );
}
