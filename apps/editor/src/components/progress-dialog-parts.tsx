import { useRef, type ComponentProps, type ReactNode } from "react";
import { LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Progress, ProgressLabel } from "@babylonslate/ui/components/progress";
import { cn } from "@babylonslate/ui/lib/utils";

export type ProgressDialogContentProps = ComponentProps<typeof DialogContent> & {
  failed?: boolean;
};

/**
 * Compact, uncloseable dialog shell. The popup and backdrop reveal after a short
 * delay so loads that finish quickly never flash on screen.
 */
export function ProgressDialogContent({
  failed = false,
  className,
  overlayClassName,
  ...props
}: ProgressDialogContentProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <DialogContent
      ref={popupRef}
      initialFocus={failed ? true : popupRef}
      showCloseButton={false}
      overlayClassName={cn(
        "bg-popover/30 data-open:duration-250 data-open:delay-300 data-open:fill-mode-both data-closed:duration-150",
        overlayClassName,
      )}
      className={cn(
        "gap-3 p-4 data-open:duration-250 data-open:delay-300 data-open:fill-mode-both data-closed:duration-150 data-open:zoom-in-[0.98]",
        failed ? "sm:max-w-sm" : "sm:max-w-xs",
        className,
      )}
      {...props}
    />
  );
}

export type ProgressDialogStatusProps = {
  title: ReactNode;
  /** Running phase; also the progress label read by assistive technology. */
  phase: ReactNode;
  /** Percent complete, or `null` for indeterminate work. */
  value: number | null;
  /** Quiet trailing summary beside the title, such as `42%` or `2 / 5`. */
  valueLabel?: ReactNode;
  valueLabelProps?: ComponentProps<"span"> & { [data: `data-${string}`]: string };
  /** Compact action on the phase row, such as Stop or Cancel. */
  action?: ReactNode;
  /** Secondary line under the phase row. */
  detail?: ReactNode;
  progressProps?: Omit<ComponentProps<typeof Progress>, "value" | "children"> & {
    [data: `data-${string}`]: string;
  };
};

export function ProgressDialogStatus({
  title,
  phase,
  value,
  valueLabel,
  valueLabelProps,
  action,
  detail,
  progressProps,
}: ProgressDialogStatusProps) {
  return (
    <>
      <DialogHeader className="min-h-0 flex-row items-baseline gap-3 pr-0">
        <DialogTitle className="min-w-0 flex-1 truncate text-sm leading-5">
          {title}
        </DialogTitle>
        {valueLabel != null ? (
          <span
            {...valueLabelProps}
            className={cn("shrink-0 text-xs text-muted-foreground tabular-nums", valueLabelProps?.className)}
          >
            {valueLabel}
          </span>
        ) : null}
      </DialogHeader>
      <Progress
        value={value}
        {...progressProps}
        className={cn(
          "flex-col gap-2 [&>[data-slot=progress-track]]:-order-1",
          progressProps?.className,
        )}
      >
        <div className="flex min-h-6 items-center gap-2">
          <LoaderCircleIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin"
          />
          <ProgressLabel
            aria-current="step"
            className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground"
          >
            <span
              key={typeof phase === "string" ? phase : undefined}
              className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-0.5 motion-safe:duration-200"
            >
              {phase}
            </span>
          </ProgressLabel>
          {action}
        </div>
      </Progress>
      {detail}
    </>
  );
}

export type ProgressDialogFailureProps = {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
};

export function ProgressDialogFailure({
  title,
  description,
  children,
  actions,
}: ProgressDialogFailureProps) {
  return (
    <>
      <DialogHeader className="min-h-0 flex-row items-start gap-2.5 pr-0">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle className="text-sm leading-5">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </div>
      </DialogHeader>
      {children}
      <div className="flex justify-end gap-2">{actions}</div>
    </>
  );
}
