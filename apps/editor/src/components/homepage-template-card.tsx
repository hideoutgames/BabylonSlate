import type { KeyboardEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { cn } from "@babylonslate/ui/lib/utils";

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
    <div
      data-testid={testId}
      className={cn("homepage-card-well", className)}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="size-full object-cover" />
      ) : (
        <>
          <span aria-hidden="true" className="homepage-mark-diamond" />
          {children}
        </>
      )}
    </div>
  );
}

export function TemplatePickCard({
  title,
  description,
  selected = false,
  testId,
  imageUrl,
  icon: Icon,
  className,
  onSelect,
}: {
  title: string;
  description?: string;
  selected?: boolean;
  testId: string;
  imageUrl?: string;
  icon: LucideIcon;
  className?: string;
  onSelect: () => void;
}) {
  const activate = () => onSelect();
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
      tabIndex={0}
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "homepage-template-card w-52 shrink-0 cursor-pointer gap-0 py-0",
        selected ? "ring-2 ring-primary" : "",
        className,
      )}
      onClick={activate}
      onKeyDown={onKeyDown}
    >
      <TemplateCardWell imageUrl={imageUrl}>
        <Icon />
      </TemplateCardWell>
      <CardHeader className="gap-1 px-3 py-3">
        <CardTitle>{title}</CardTitle>
        {description ? (
          <CardDescription>{description}</CardDescription>
        ) : null}
      </CardHeader>
    </Card>
  );
}
