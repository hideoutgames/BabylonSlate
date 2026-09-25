import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import {
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import { cn } from "@babylonslate/ui/lib/utils";
import { ariaKeyShortcuts, ShortcutKeys } from "@babylonslate/editor-kit";
import type { ActionFeedback, ActionResult } from "../lib/action-feedback";
import type { EditorCommandId } from "../lib/editor-keybinds";
import { useKeybindChord, useKeybindCommand } from "../context/keybind-context";

const IDLE: ActionFeedback = { status: "idle" };

/** Key by document/project owner so a late result cannot update another tab's action. */
export function ActionFeedbackButton({
  label,
  icon: Icon,
  onAction,
  feedback: controlledFeedback,
  iconOnly = false,
  showSuccessIcon = true,
  command,
  disabled,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
  label: string;
  icon: LucideIcon;
  onAction: () => ActionResult | Promise<ActionResult>;
  feedback?: ActionFeedback;
  iconOnly?: boolean;
  showSuccessIcon?: boolean;
  /** Editor command whose chord runs this action and appears in its tooltip. */
  command?: EditorCommandId;
}) {
  const [localFeedback, setLocalFeedback] = useState<ActionFeedback>(IDLE);
  const pending = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);
  const feedback = controlledFeedback ?? localFeedback;
  const busy = feedback.status === "pending";
  const message =
    feedback.message ??
    (busy
      ? `${label} In Progress`
      : feedback.status === "success"
        ? `${label} Complete`
        : feedback.status === "error"
          ? `${label} Failed`
          : "");
  const FeedbackIcon = busy
    ? LoaderCircleIcon
    : feedback.status === "success" && showSuccessIcon
      ? CheckIcon
      : feedback.status === "error"
        ? CircleAlertIcon
        : Icon;

  const chord = useKeybindChord(command);
  const run = async () => {
    if (pending.current || disabled || busy) return;
    if (controlledFeedback) {
      onAction();
      return;
    }
    pending.current = true;
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setLocalFeedback({ status: "pending" });
    let next: ActionFeedback;
    try {
      const result = onAction();
      const completed = result instanceof Promise ? await result : result;
      // A cancelled save (for example a migration prompt) is not a successful save.
      next = completed === false ? IDLE : { status: "success" };
    } catch (error) {
      next = {
        status: "error",
        message: `${label} Failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      pending.current = false;
    }
    if (!mounted.current) return;
    setLocalFeedback(next);
    if (next.status === "success") {
      resetTimer.current = setTimeout(() => setLocalFeedback(IDLE), 900);
    }
  };

  useKeybindCommand(command, () => void run(), { enabled: !disabled && !busy });

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size={iconOnly ? "icon-sm" : "sm"}
              {...props}
              className={cn("chrome-action-feedback", className)}
              aria-label={label}
              aria-keyshortcuts={chord ? ariaKeyShortcuts(chord) : undefined}
              aria-describedby={message ? statusId : undefined}
              aria-busy={busy}
              data-action-state={feedback.status}
              disabled={disabled || busy}
              onClick={() => void run()}
            />
          }
        >
          <FeedbackIcon
            data-icon={iconOnly ? undefined : "inline-start"}
            className={busy ? "motion-safe:animate-spin" : undefined}
          />
          {children}
        </TooltipTrigger>
        <TooltipContent>
          {message || label}
          {message ? null : <ShortcutKeys chord={chord} decorative />}
        </TooltipContent>
      </Tooltip>
      <span id={statusId} className="sr-only" role="status" aria-live="polite">
        {message}
      </span>
    </>
  );
}
