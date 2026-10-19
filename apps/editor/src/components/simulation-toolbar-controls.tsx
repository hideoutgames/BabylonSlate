import { Button } from "@babylonslate/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@babylonslate/ui/components/tooltip";
import { GamepadIcon, LocateFixedIcon, MousePointer2Icon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import {
  SIMULATION_CONTROL_ATTRIBUTE,
  type SimulationControls,
} from "../context/simulation-controls-context";

const controlProps = { [SIMULATION_CONTROL_ATTRIBUTE]: "" };

/**
 * The running Simulation in the global toolbar's Play island: Pause, a red
 * Stop in place of Simulate, Game / Edit input and, away from its Scene,
 * Return To Scene.
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
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        value={[controls?.inputMode ?? "game"]}
        className="chrome-simulation-input"
        aria-label="Simulation Input"
        disabled={!controls || controls.inputPending || stopping}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "game" || next === "edit") controls?.setInputMode(next);
        }}
        data-testid="simulation-input-mode"
        {...controlProps}
      >
        <ToggleGroupItem value="game" aria-label="Game Input" title="Game Input: the game receives keys, touch and the mouse" data-testid="simulation-input-game">
          <GamepadIcon />
          {phone ? null : "Game"}
        </ToggleGroupItem>
        <ToggleGroupItem value="edit" aria-label="Edit" title="Edit: select, inspect and move runtime objects" data-testid="simulation-input-edit">
          <MousePointer2Icon />
          {phone ? null : "Edit"}
        </ToggleGroupItem>
      </ToggleGroup>
      {onReturnToScene ? (
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
      ) : null}
    </>
  );
}
