import { StepBackIcon, StepForwardIcon } from "lucide-react";
import { Badge } from "@haptic/ui/components/badge";
import { SIMULATION_CONTROL_ATTRIBUTE } from "../context/simulation-controls-context";
import type { GraphStepping, SteppingControls } from "../lib/use-graph-stepping";
import { IconActionButton } from "./icon-action-button";

const controlProps = { [SIMULATION_CONTROL_ATTRIBUTE]: "" };

/**
 * The stepping control in the global toolbar's debugging island while the game is paused: Step Back, the
 * visit shown, Step Forward. Its buttons act without first releasing game input.
 */
export function GraphSteppingBar({ stepping, controls }: {
  stepping: GraphStepping;
  controls: SteppingControls;
}) {
  const { position, canStepBack, forwardInRecord, label, cutShort } = stepping;
  return (
    <div role="group" aria-label="Stepping" className="flex items-center" data-testid="graph-stepping-bar">
      <IconActionButton
        label="Step Back"
        variant="ghost"
        className="chrome-icon-button"
        disabled={!canStepBack}
        onClick={stepping.stepBack}
        data-testid="graph-step-back"
        {...controlProps}
      >
        <StepBackIcon />
      </IconActionButton>
      <span className="px-1 text-xs whitespace-nowrap tabular-nums" data-testid="graph-step-position">{label}</span>
      {position && !position.newest ? <Badge variant="secondary" data-testid="graph-step-past">Past</Badge> : null}
      {cutShort ? <span className="px-1 text-xs whitespace-nowrap text-muted-foreground">Later Steps Not Recorded</span> : null}
      <IconActionButton
        label={forwardInRecord ? "Step Forward" : "Step Forward Into The Next Tick"}
        variant="ghost"
        className="chrome-icon-button"
        disabled={controls.stepPending}
        onClick={stepping.stepForward}
        data-testid="graph-step-forward"
        {...controlProps}
      >
        <StepForwardIcon />
      </IconActionButton>
    </div>
  );
}
