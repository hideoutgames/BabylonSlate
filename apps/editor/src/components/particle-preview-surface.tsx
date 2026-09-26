import type { ReactNode } from "react";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import type { ParticlePreviewStats } from "@babylonslate/render";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { Separator } from "@babylonslate/ui/components/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import { IconActionButton } from "./icon-action-button";

type PreviewAction = { label: string; onClick: () => void };

export type ParticlePreviewState =
  /** Nothing to preview; the canvas is not mounted. */
  | {
      status: "empty";
      title: string;
      description: string;
      action?: PreviewAction;
      /** Defaults to `particle-preview-empty`. */
      testId?: string;
    }
  /** First boot only; later edits keep the last frame with an Updating badge. */
  | { status: "loading" }
  /** Covers the mounted canvas, which the running preview keeps drawing into. */
  | {
      status: "error";
      /** Defaults to Preview Failed. */
      title?: string;
      description: string;
      action?: PreviewAction;
      onRetry?: () => void;
      /** Defaults to `particle-preview-failed`. */
      testId?: string;
    }
  /** `notice` names slots that were skipped while the others play. */
  | { status: "ready"; notice?: string; updating?: boolean };

export interface ParticlePreviewSurfaceProps {
  state: ParticlePreviewState;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onRestart: () => void;
  /** Null hides the backend and count badges (no running systems). */
  stats: ParticlePreviewStats | null;
  /**
   * Backend badge tooltip. Defaults to the Basic CPU fallback note on CPU; hosts
   * previewing Particle Graphs explain that graphs always simulate on the CPU.
   */
  backendHint?: string;
  /** The preview `<canvas>`; not mounted while the state is empty. */
  children?: ReactNode;
  "data-testid"?: string;
}

function StateActions({ action, onRetry }: { action?: PreviewAction; onRetry?: () => void }) {
  if (!action && !onRetry) return null;
  return (
    <EmptyContent className="flex-row justify-center gap-2">
      {action ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={action.onClick}
          data-testid="particle-preview-action"
        >
          {action.label}
        </Button>
      ) : null}
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </EmptyContent>
  );
}

const BACKEND_LABEL: Record<Exclude<ParticlePreviewStats["backend"], "none">, string> = {
  gpu: "GPU",
  cpu: "CPU",
  mixed: "GPU + CPU",
};

const DEFAULT_BACKEND_HINT: Partial<Record<ParticlePreviewStats["backend"], string>> = {
  cpu: "GPU particles are unavailable on this device. Capacity is limited to 512.",
  // Only Particle Graphs run on the CPU next to GPU emitters.
  mixed: "Basic Particle Emitters run on the GPU. Particle Graphs simulate on the CPU.",
};

const count = (value: number) => value.toLocaleString("en-US");

function BadgeHint({ hint, children }: { hint?: string; children: ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex rounded-4xl" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Particle Preview chrome shared by the Basic Particle Emitter, Particle Graph and
 * Particle System previews: Restart, Play/Pause, backend and active-count badges,
 * and the standard empty, loading and failure states over the canvas.
 */
export function ParticlePreviewSurface({
  state,
  paused,
  onPausedChange,
  onRestart,
  stats,
  backendHint,
  children,
  "data-testid": testId,
}: ParticlePreviewSurfaceProps) {
  if (state.status === "empty") {
    return (
      <div className="flex h-full min-h-0 w-full" data-testid={testId}>
        <Empty data-testid={state.testId ?? "particle-preview-empty"}>
          <EmptyHeader>
            <EmptyTitle>{state.title}</EmptyTitle>
            <EmptyDescription>{state.description}</EmptyDescription>
          </EmptyHeader>
          <StateActions action={state.action} />
        </Empty>
      </div>
    );
  }

  const shown = stats && stats.backend !== "none" ? stats : null;
  const activeOf = shown ? `${count(shown.active)} of ${count(shown.capacity)}` : "";
  return (
    <div className="relative h-full min-h-0 w-full" data-testid={testId}>
      {children}
      {state.status === "ready" ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
          <div
            className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-md"
            data-testid="particle-preview-controls"
          >
            <IconActionButton
              label="Restart"
              variant="ghost"
              className="pointer-coarse:size-[var(--touch-target)]"
              onClick={onRestart}
              data-testid="particle-preview-restart"
            >
              <RotateCcwIcon />
            </IconActionButton>
            <IconActionButton
              label={paused ? "Play" : "Pause"}
              variant="ghost"
              className="pointer-coarse:size-[var(--touch-target)]"
              aria-pressed={paused}
              onClick={() => onPausedChange(!paused)}
              data-testid="particle-preview-play"
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
            </IconActionButton>
            {shown ? (
              <>
                <Separator orientation="vertical" className="mx-0.5 my-1" />
                <BadgeHint hint={backendHint ?? DEFAULT_BACKEND_HINT[shown.backend]}>
                  <Badge variant="secondary" data-testid="particle-preview-backend">
                    {BACKEND_LABEL[shown.backend]}
                  </Badge>
                </BadgeHint>
                <BadgeHint
                  hint={
                    shown.approximate
                      ? "GPU counts include particle slots waiting to respawn."
                      : undefined
                  }
                >
                  <Badge
                    variant="outline"
                    className="tabular-nums"
                    aria-label={`${shown.approximate ? "About " : ""}${activeOf} particles active`}
                    data-testid="particle-preview-count"
                  >
                    {`${shown.approximate ? "~" : ""}${count(shown.active)} / ${count(shown.capacity)}`}
                  </Badge>
                </BadgeHint>
              </>
            ) : null}
            {state.updating ? (
              <Badge variant="ghost" data-testid="particle-preview-updating">
                Updating
              </Badge>
            ) : null}
          </div>
        </div>
      ) : null}
      {state.status === "ready" && state.notice ? (
        <div
          role="status"
          className="absolute inset-x-0 bottom-0 bg-background/80 px-2 py-1 text-xs text-destructive"
          data-testid="particle-preview-notice"
        >
          {state.notice}
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div className="absolute inset-0 flex bg-background">
          <Empty data-testid="particle-preview-loading">
            <EmptyHeader>
              <EmptyTitle>Loading Preview</EmptyTitle>
              <EmptyDescription>
                Starting the particle Preview on the shared Engine.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="absolute inset-0 flex bg-background">
          <Empty role="status" data-testid={state.testId ?? "particle-preview-failed"}>
            <EmptyHeader>
              <EmptyTitle>{state.title ?? "Preview Failed"}</EmptyTitle>
              <EmptyDescription>{state.description}</EmptyDescription>
            </EmptyHeader>
            <StateActions action={state.action} onRetry={state.onRetry} />
          </Empty>
        </div>
      ) : null}
    </div>
  );
}
