import type { ComponentType, ReactNode } from "react";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { cn } from "@babylonslate/ui/lib/utils";

export type ProgressDialogHeaderProps = {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  description: ReactNode;
  failed?: boolean;
  aside?: ReactNode;
};

export function ProgressDialogHeader({
  icon: Icon,
  title,
  description,
  failed = false,
  aside,
}: ProgressDialogHeaderProps) {
  return (
    <DialogHeader className="flex-row items-start gap-3 pr-0">
      <span
        aria-hidden
        data-slot="progress-dialog-icon"
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1",
          failed
            ? "bg-destructive/10 text-destructive ring-destructive/20"
            : "bg-muted text-foreground ring-border",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <DialogTitle className={cn("leading-5", failed && "text-destructive")}>
          {title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </div>
      {aside}
    </DialogHeader>
  );
}

export type ProgressStep = {
  key: string;
  label: ReactNode;
  detail?: ReactNode;
};

export type ProgressStepListProps = {
  steps: readonly ProgressStep[];
  /** Index of the running step; earlier steps render complete. */
  current: number;
  className?: string;
};

export function ProgressStepList({
  steps,
  current,
  className,
}: ProgressStepListProps) {
  return (
    <ol
      data-slot="progress-step-list"
      className={cn("flex w-full flex-col gap-2", className)}
    >
      {steps.map((step, index) => {
        const state =
          index < current ? "done" : index === current ? "current" : "pending";
        return (
          <li
            key={step.key}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className="flex items-start gap-2.5"
          >
            <span
              aria-hidden
              className={cn(
                "mt-px flex size-4 shrink-0 items-center justify-center rounded-full",
                state === "done" && "bg-primary text-primary-foreground",
                state === "current" && "text-primary",
                state === "pending" && "ring-1 ring-border ring-inset",
              )}
            >
              {state === "done" ? (
                <CheckIcon className="size-3" strokeWidth={3} />
              ) : state === "current" ? (
                <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
              ) : null}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span
                className={cn(
                  "leading-4",
                  state === "current" && "font-medium text-foreground",
                  state === "done" && "text-muted-foreground",
                  state === "pending" && "text-muted-foreground/70",
                )}
              >
                {step.label}
              </span>
              {step.detail}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
