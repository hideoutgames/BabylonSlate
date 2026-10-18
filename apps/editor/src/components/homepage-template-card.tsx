import type { KeyboardEvent, ReactNode } from "react";
import { PlusIcon, type LucideIcon } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { cn } from "@babylonslate/ui/lib/utils";
import { useHomepageCardTouch } from "./use-homepage-card-touch";

export function TemplateCardWell({
  imageUrl,
  children,
  className,
  testId = "template-card-well",
}: {
  imageUrl?: string;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={cn("homepage-card-well", className)}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        children
      )}
    </div>
  );
}

export function TemplatePickCard({
  title,
  description,
  selected = false,
  disabled = false,
  testId,
  imageUrl,
  icon: Icon,
  actionLabel,
  className,
  onSelect,
}: {
  title: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  testId: string;
  imageUrl?: string;
  icon: LucideIcon;
  /** Shown on the cover on hover, such as "New Project". */
  actionLabel?: string;
  className?: string;
  onSelect: () => void;
}) {
  const touch = useHomepageCardTouch(!disabled);
  const activate = () => {
    if (!disabled) onSelect();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };

  return (
    <Card
      size="sm"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={selected}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "homepage-template-card shrink-0 cursor-pointer gap-0 py-0",
        disabled && "cursor-default opacity-50",
        className,
      )}
      onPointerDown={touch.onPointerDown}
      onPointerEnter={touch.onPointerEnter}
      onClick={(event) => {
        if (touch.shouldActivate(event)) activate();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="homepage-template-cover">
        <TemplateCardWell imageUrl={imageUrl}>
          <Icon />
        </TemplateCardWell>
        {actionLabel && (
          <span className="homepage-template-action" aria-hidden="true">
            <PlusIcon />
            {actionLabel}
          </span>
        )}
      </div>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
    </Card>
  );
}
