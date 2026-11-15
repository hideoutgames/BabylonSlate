import { ToolbarOverflowItem } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import {
  GamepadIcon,
  LocateFixedIcon,
  MousePointer2Icon,
  OctagonPauseIcon,
  PauseIcon,
  PlayIcon,
  SkipForwardIcon,
  SquareIcon,
  StepBackIcon,
  StepForwardIcon,
} from "lucide-react";
import { breakpointStopText, type BreakpointStop } from "../lib/breakpoint-stop";
import { TOOLBAR_OVERFLOW_PRIORITY } from "../lib/toolbar-overflow-priority";
import {
  SIMULATION_CONTROL_ATTRIBUTE,
  type SimulationControls,
} from "../context/simulation-controls-context";
import type { GraphDebugStepPosition, GraphDebugStore } from "../services/graph-debug-store";
import { useGraphStepping } from "../lib/use-graph-stepping";
import { GraphSteppingBar } from "./graph-stepping-bar";

const controlProps = { [SIMULATION_CONTROL_ATTRIBUTE]: "" };

/**
 * The debugging island left of the session controls while the game is paused: the asset a breakpoint
 * stopped in, named (choosing it opens the node again), the stepping control over the followed object's
 * recorded visits, and Next Frame, which runs one frame and stays paused.
 */
export function DebugStepToolbarControls({
  controls,
  stopping,
  stop,
  onOpenStop,
  graphDebug,
  onFocusStep,
}: {
  controls: SimulationControls;
  stopping: boolean;
  /** Where a breakpoint stopped the session; it stays named until the session resumes. */
  stop?: BreakpointStop | null;
  onOpenStop?: () => void;
  /** The graph debugger, whose recorded visits the stepping control walks; absent without one. */
  graphDebug?: GraphDebugStore | null;
  /** Opens the node of the visit stepped to. */
  onFocusStep: (position: GraphDebugStepPosition) => void;
}) {
  const stepDisabled = controls.stepPending || controls.pausePending || stopping;
  return (
    <>
      {stop ? <BreakpointStopButton stop={stop} onOpenStop={onOpenStop} /> : null}
      {graphDebug ? <SteppingItem store={graphDebug} controls={controls} onFocus={onFocusStep} /> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              className="chrome-icon-button"
              aria-label="Next Frame"
              disabled={stepDisabled}
              onClick={() => controls.step()}
              data-testid="simulation-step"
              {...controlProps}
            />
          }
        >
          <SkipForwardIcon />
        </TooltipTrigger>
        <TooltipContent>Run One Frame</TooltipContent>
      </Tooltip>
    </>
  );
}

/** The asset a breakpoint stopped in, by name and cut short with an ellipsis; choosing it opens the node. */
function BreakpointStopButton({ stop, onOpenStop }: { stop: BreakpointStop; onOpenStop?: () => void }) {
  const where = `Stopped At ${breakpointStopText(stop)}`;
  return (
    <ToolbarOverflowItem
      id="breakpoint-stop"
      priority={TOOLBAR_OVERFLOW_PRIORITY.breakpointStop}
      items={[{
        id: "breakpoint-stop",
        label: `Open ${stop.className}`,
        icon: <OctagonPauseIcon />,
        onSelect: () => onOpenStop?.(),
      }]}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="chrome-action-button min-w-0 max-w-40"
              aria-label={where}
              onClick={() => onOpenStop?.()}
              data-testid="simulation-breakpoint-stop"
              {...controlProps}
            />
          }
        >
          <OctagonPauseIcon data-icon="inline-start" className="text-destructive" />
          <span className="truncate">{stop.className}</span>
        </TooltipTrigger>
        <TooltipContent>{where}</TooltipContent>
      </Tooltip>
    </ToolbarOverflowItem>
  );
}

function SteppingItem({ store, controls, onFocus }: {
  store: GraphDebugStore;
  controls: SimulationControls;
  onFocus: (position: GraphDebugStepPosition) => void;
}) {
  const stepping = useGraphStepping(store, controls, onFocus);
  return (
    <ToolbarOverflowItem
      id="graph-stepping"
      priority={TOOLBAR_OVERFLOW_PRIORITY.stepping}
      items={[
        { id: "graph-step-back", label: "Step Back", icon: <StepBackIcon />, disabled: !stepping.canStepBack, onSelect: stepping.stepBack },
        {
          id: "graph-step-forward",
          label: stepping.forwardInRecord ? "Step Forward" : "Step Forward Into The Next Tick",
          icon: <StepForwardIcon />,
          disabled: controls.stepPending,
          onSelect: stepping.stepForward,
        },
      ]}
    >
      <GraphSteppingBar stepping={stepping} controls={controls} />
    </ToolbarOverflowItem>
  );
}

/**
 * Editor Play stopped at a breakpoint or an error, its view hidden behind the editor: Resume returns
 * to the game and carries on, Stop ends Play. Stepping sits in its own island beside them
 * (`DebugStepToolbarControls`).
 */
export function PlayBreakToolbarControls({
  controls,
  stopping,
  onStop,
}: {
  controls: SimulationControls;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="chrome-action-button chrome-play-button"
              aria-label="Resume"
              disabled={controls.pausePending || stopping}
              onClick={() => controls.togglePause()}
              data-testid="play-break-resume"
              {...controlProps}
            />
          }
        >
          <PlayIcon data-icon="inline-start" fill="currentColor" />
          Resume
        </TooltipTrigger>
        <TooltipContent>Return To The Game</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="chrome-action-button chrome-stop-button"
              aria-label={stopping ? "Stopping Play" : "Stop Play"}
              disabled={stopping}
              onClick={onStop}
              data-testid="play-break-stop"
              {...controlProps}
            />
          }
        >
          <SquareIcon data-icon="inline-start" fill="currentColor" />
          {stopping ? "Stopping…" : "Stop"}
        </TooltipTrigger>
        <TooltipContent>Stop Play</TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * The running Simulation in the global toolbar's Play island: Pause, a red Stop in
 * place of Simulate, a Game / Edit input toggle and, away from its Scene, Return To
 * Scene. Stepping while paused sits in its own island (`DebugStepToolbarControls`).
 */
export function SimulationToolbarControls({
  controls,
  stopping,
  phone,
  onStop,
  onReturnToScene,
}: {
  /** Null until the Simulation's overlay is ready. */
  controls: SimulationControls | null;
  stopping: boolean;
  phone: boolean;
  onStop: () => void;
  /** Set while another document is active. */
  onReturnToScene?: () => void;
}) {
  const paused = controls?.paused ?? false;
  const inputMode = controls?.inputMode ?? "game";
  const stopLabel = controls?.keepChanges
    ? "Stop Simulation and Keep Changes"
    : "Stop Simulation and Discard Changes";
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              className="chrome-icon-button"
              aria-label={paused ? "Resume" : "Pause"}
              aria-pressed={paused}
              disabled={!controls || controls.pausePending || stopping}
              onClick={() => controls?.togglePause()}
              data-testid="simulation-pause"
              {...controlProps}
            />
          }
        >
          {paused ? <PlayIcon fill="currentColor" /> : <PauseIcon />}
        </TooltipTrigger>
        <TooltipContent>{paused ? "Resume" : "Pause"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="chrome-action-button chrome-stop-button"
              aria-label={stopping ? "Stopping Simulation" : stopLabel}
              disabled={stopping}
              onClick={onStop}
              data-testid="simulation-session-stop"
              {...controlProps}
            />
          }
        >
          <SquareIcon data-icon="inline-start" fill="currentColor" />
          {stopping ? "Stopping…" : "Stop"}
        </TooltipTrigger>
        <TooltipContent>{stopLabel}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="chrome-action-button chrome-simulation-input"
              aria-label={inputMode === "game" ? "Game Input" : "Edit Input"}
              data-input-mode={inputMode}
              disabled={!controls || controls.inputPending || stopping}
              onClick={() => controls?.setInputMode(inputMode === "game" ? "edit" : "game")}
              data-testid="simulation-input-mode"
              {...controlProps}
            />
          }
        >
          {inputMode === "game" ? <GamepadIcon data-icon={phone ? undefined : "inline-start"} /> : <MousePointer2Icon data-icon={phone ? undefined : "inline-start"} />}
          {phone ? null : inputMode === "game" ? "Game" : "Edit"}
        </TooltipTrigger>
        <TooltipContent>
          {inputMode === "game" ? "Switch To Edit" : "Switch To Game"}
        </TooltipContent>
      </Tooltip>
      {onReturnToScene ? (
        <ToolbarOverflowItem
          id="return-to-scene"
          priority={TOOLBAR_OVERFLOW_PRIORITY.returnToScene}
          items={[{
            id: "return-to-scene",
            label: "Return To Scene",
            icon: <LocateFixedIcon />,
            onSelect: onReturnToScene,
          }]}
        >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="chrome-icon-button"
                aria-label="Return To Scene"
                onClick={onReturnToScene}
                data-testid="simulation-return-to-scene"
                {...controlProps}
              />
            }
          >
            <LocateFixedIcon />
          </TooltipTrigger>
          <TooltipContent>Return To Scene</TooltipContent>
        </Tooltip>
        </ToolbarOverflowItem>
      ) : null}
    </>
  );
}
