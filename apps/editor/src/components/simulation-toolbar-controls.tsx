import { ToolbarOverflowItem } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { CircleDotIcon, GamepadIcon, LocateFixedIcon, MousePointer2Icon, PauseIcon, PlayIcon, SkipForwardIcon, SquareIcon } from "lucide-react";
import { TOOLBAR_OVERFLOW_PRIORITY } from "../lib/toolbar-overflow-priority";
import {
  SIMULATION_CONTROL_ATTRIBUTE,
  type SimulationControls,
} from "../context/simulation-controls-context";

const controlProps = { [SIMULATION_CONTROL_ATTRIBUTE]: "" };

/**
 * The running Simulation in the global toolbar's Play island: Pause, Step while
 * paused, a red Stop in place of Simulate, a Game / Edit input toggle and, away
 * from its Scene, Return To Scene.
 */
export function SimulationToolbarControls({
  controls,
  stopping,
  phone,
  onStop,
  onReturnToScene,
  stoppedAt,
  onOpenStop,
}: {
  /** Null until the Simulation's overlay is ready. */
  controls: SimulationControls | null;
  /** Where a breakpoint stopped the Simulation, named, while it stays there. */
  stoppedAt?: string | null;
  /** Opens the node the Simulation stopped at again. */
  onOpenStop?: () => void;
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
      {paused && controls ? (
        <ToolbarOverflowItem
          id="simulation-step"
          priority={TOOLBAR_OVERFLOW_PRIORITY.simulationStep}
          items={[{
            id: "simulation-step",
            label: "Step",
            icon: <SkipForwardIcon />,
            disabled: controls.stepPending || controls.pausePending || stopping,
            onSelect: () => controls.step(),
          }]}
        >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="chrome-icon-button"
                aria-label="Step"
                disabled={controls.stepPending || controls.pausePending || stopping}
                onClick={() => controls.step()}
                data-testid="simulation-step"
                {...controlProps}
              />
            }
          >
            <SkipForwardIcon />
          </TooltipTrigger>
          <TooltipContent>Step One Tick</TooltipContent>
        </Tooltip>
        </ToolbarOverflowItem>
      ) : null}
      {paused && stoppedAt ? (
        <ToolbarOverflowItem
          id="breakpoint-stop"
          priority={TOOLBAR_OVERFLOW_PRIORITY.breakpointStop}
          items={[{
            id: "breakpoint-stop",
            label: `Stopped At ${stoppedAt}`,
            icon: <CircleDotIcon />,
            onSelect: () => onOpenStop?.(),
          }]}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  className="chrome-action-button min-w-0 max-w-72"
                  aria-label={`Stopped At ${stoppedAt}`}
                  onClick={() => onOpenStop?.()}
                  data-testid="simulation-breakpoint-stop"
                  {...controlProps}
                />
              }
            >
              <CircleDotIcon data-icon="inline-start" className="text-destructive" />
              <span className="truncate">{stoppedAt}</span>
            </TooltipTrigger>
            <TooltipContent>Stopped At {stoppedAt}</TooltipContent>
          </Tooltip>
        </ToolbarOverflowItem>
      ) : null}
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
