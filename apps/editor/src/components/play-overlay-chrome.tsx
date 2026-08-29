import type { ReactNode } from "react";
import {
  ActivityIcon,
  ListTreeIcon,
  PauseIcon,
  PlayIcon,
  SkipForwardIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Toggle } from "@babylonslate/ui/components/toggle";

export type PlayOverlayChromeProps = {
  paused: boolean;
  statsOpen: boolean;
  inspectorOpen?: boolean;
  showStats?: boolean;
  showConsole?: boolean;
  showInspector?: boolean;
  onPauseToggle: () => void;
  onStatsToggle: () => void;
  onConsoleOpen: () => void;
  onInspectorToggle?: () => void;
  onStep?: () => void;
  onClose: () => void;
  stats: ReactNode;
  extras?: ReactNode;
};

/** Labeled Play chrome: Pause, Stats, Console, Inspector, Stop. Stats dump stays collapsed. */
export function PlayOverlayChrome({
  paused,
  statsOpen,
  inspectorOpen = false,
  showStats = true,
  showConsole = true,
  showInspector = true,
  onPauseToggle,
  onStatsToggle,
  onConsoleOpen,
  onInspectorToggle,
  onStep,
  onClose,
  stats,
  extras,
}: PlayOverlayChromeProps) {
  return (
    <div className="safe-play-overlay-chrome absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div hidden={!statsOpen || !showStats} className="pointer-events-none">
          {stats}
        </div>
        {extras}
      </div>
      <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
        <Button
          size="touch"
          variant="secondary"
          data-testid="play-overlay-pause"
          aria-label={paused ? "Resume" : "Pause"}
          aria-pressed={paused}
          onClick={onPauseToggle}
        >
          {paused ? (
            <PlayIcon data-icon="inline-start" />
          ) : (
            <PauseIcon data-icon="inline-start" />
          )}
          {paused ? "Resume" : "Pause"}
        </Button>
        {paused ? (
          <Button
            size="touch"
            variant="secondary"
            data-testid="play-overlay-step"
            aria-label="Step"
            onClick={() => onStep?.()}
          >
            <SkipForwardIcon data-icon="inline-start" />
            Step
          </Button>
        ) : null}
        {showStats ? (
          <Toggle
            size="touch"
            variant="outline"
            pressed={statsOpen}
            data-testid="play-stats-toggle"
            aria-label="Stats"
            onPressedChange={() => onStatsToggle()}
          >
            <ActivityIcon data-icon="inline-start" />
            Stats
          </Toggle>
        ) : null}
        {showConsole ? (
          <Button
            size="touch"
            variant="secondary"
            data-testid="play-console-open"
            aria-label="Console"
            onClick={onConsoleOpen}
          >
            <TerminalIcon data-icon="inline-start" />
            Console
          </Button>
        ) : null}
        {showInspector ? (
          <Toggle
            size="touch"
            variant="outline"
            pressed={inspectorOpen}
            data-testid="play-inspector-toggle"
            aria-label="Inspector"
            onPressedChange={() => onInspectorToggle?.()}
          >
            <ListTreeIcon data-icon="inline-start" />
            Inspector
          </Toggle>
        ) : null}
        <Button
          size="touch"
          variant="secondary"
          data-testid="play-overlay-close"
          aria-label="Stop"
          onClick={onClose}
        >
          <XIcon data-icon="inline-start" />
          Stop
        </Button>
      </div>
    </div>
  );
}
