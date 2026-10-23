import { useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import {
  ActivityIcon,
  CameraIcon,
  GaugeIcon,
  ListTreeIcon,
  PauseIcon,
  PlayIcon,
  SkipForwardIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { Separator } from "@haptic/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { useDiagnosticResultsStore } from "../context/diagnostic-results-context";
import type { DiagnosticResultsSnapshot } from "../services/diagnostic-results-store";

export type PlayOverlayChromeProps = {
  paused: boolean;
  statsOpen: boolean;
  inspectorOpen?: boolean;
  showStats?: boolean;
  showConsole?: boolean;
  showInspector?: boolean;
  showProfiler?: boolean;
  onPauseToggle: () => void;
  pausePending?: boolean;
  /** Simulation keeps Pause, input mode and Stop in the global toolbar. */
  simulating?: boolean;
  onStatsToggle: () => void;
  onConsoleOpen: () => void;
  onInspectorToggle?: () => void;
  onStep?: () => void;
  onClose: () => void;
  stats: ReactNode;
  extras?: ReactNode;
};

/** Play chrome: Pause, Stats, Console, Inspector, Profiler, Stop. Stats stay collapsed until toggled. */
export function PlayOverlayChrome({
  paused,
  statsOpen,
  inspectorOpen = false,
  showStats = true,
  showConsole = true,
  showInspector = true,
  showProfiler = false,
  onPauseToggle,
  pausePending = false,
  simulating = false,
  onStatsToggle,
  onConsoleOpen,
  onInspectorToggle,
  onStep,
  onClose,
  stats,
  extras,
}: PlayOverlayChromeProps) {
  const diagnostics = useDiagnosticResultsStore();
  return (
    <div className="safe-overlay-chrome absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div hidden={!statsOpen || !showStats} className="pointer-events-none">
          {stats}
        </div>
        {extras}
      </div>
      {simulating && !showStats && !showConsole ? null : (
        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
          {simulating ? null : <ProfilerRecordingChip testId="play-profiler-recording" />}
          <div className="toolbar-island toolbar-island-touch" role="toolbar" aria-label="Play Controls">
            {simulating ? null : <>
              <PlayChromeTool
                label={paused ? "Resume" : "Pause"}
                data-testid="play-overlay-pause"
                pressed={paused}
                disabled={pausePending}
                onClick={onPauseToggle}
              >
                {paused ? <PlayIcon fill="currentColor" /> : <PauseIcon />}
              </PlayChromeTool>
              {paused && onStep ? (
                <PlayChromeTool label="Step" data-testid="play-overlay-step" onClick={() => onStep?.()}>
                  <SkipForwardIcon />
                </PlayChromeTool>
              ) : null}
              {showStats || showConsole || showInspector ? <Separator orientation="vertical" /> : null}
            </>}
            {showStats ? (
              <PlayChromeTool label="Stats" data-testid="play-stats-toggle" pressed={statsOpen} onClick={onStatsToggle}>
                <ActivityIcon />
              </PlayChromeTool>
            ) : null}
            {showConsole ? (
              <PlayChromeTool label="Console" data-testid="play-console-open" onClick={onConsoleOpen}>
                <TerminalIcon />
              </PlayChromeTool>
            ) : null}
            {showInspector ? (
              <PlayChromeTool label="Inspector" data-testid="play-inspector-toggle" pressed={inspectorOpen} onClick={() => onInspectorToggle?.()}>
                <ListTreeIcon />
              </PlayChromeTool>
            ) : null}
            {!simulating && showProfiler && diagnostics ? <>
              <Separator orientation="vertical" />
              <PlayChromeTool label="Profiler" data-testid="play-profiler-open" onClick={() => diagnostics.open("summary")}>
                <GaugeIcon />
              </PlayChromeTool>
              <PlayChromeTool label="Capture Frame" data-testid="play-capture-frame" onClick={() => void diagnostics.captureFrame()}>
                <CameraIcon />
              </PlayChromeTool>
            </> : null}
            {simulating ? null : <>
              <Separator orientation="vertical" />
              <PlayChromeTool label="Stop" data-testid="play-overlay-close" className="play-stop" onClick={onClose}>
                <SquareIcon fill="currentColor" />
              </PlayChromeTool>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

const unsubscribed = () => () => {};
const notRecording = (): DiagnosticResultsSnapshot | null => null;

/**
 * While a performance recording runs, whether the Profiler or the console started it: **Recording**
 * and **Stop Recording**, which opens the Profiler at the recording's Summary.
 */
export function ProfilerRecordingChip({ testId }: { testId: string }) {
  const store = useDiagnosticResultsStore();
  const state = useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.getSnapshot ?? notRecording, store?.getSnapshot ?? notRecording);
  if (!store || state?.active !== "profile") return null;
  return (
    <div className="toolbar-island toolbar-island-touch" role="group" aria-label="Performance Recording" data-testid={testId}>
      <span className="flex items-center gap-1.5 px-1.5 text-xs font-medium text-destructive">
        <span className="size-2 rounded-full bg-destructive motion-safe:animate-pulse" aria-hidden="true" />
        Recording
      </span>
      <PlayChromeTool
        label="Stop Recording"
        data-testid={`${testId}-stop`}
        disabled={state.busy}
        onClick={() => {
          store.open("summary");
          void store.stopProfile();
        }}
      >
        <SquareIcon className="fill-destructive text-destructive" />
      </PlayChromeTool>
    </div>
  );
}

/** An icon tool in the Play and Preview Build islands; its label is the accessible name and tooltip. */
export function PlayChromeTool({
  label,
  pressed,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label" | "aria-pressed"> & { label: string; pressed?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={label}
            aria-pressed={pressed}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
