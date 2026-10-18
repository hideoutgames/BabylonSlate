import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@babylonslate/ui/components/dropdown-menu";
import { ClipboardCheckIcon, MonitorPlayIcon } from "lucide-react";

export type PlayDebugMenuItemsProps = {
  overlayStats: boolean;
  overlayConsole: boolean;
  overlayInspector: boolean;
  overlayProfiler: boolean;
  pauseOnPlay: boolean;
  previewBuild: boolean;
  playFromScene: boolean;
  sessionLocked: boolean;
  onOverlayStatsChange: (checked: boolean) => void;
  onOverlayConsoleChange: (checked: boolean) => void;
  onOverlayInspectorChange: (checked: boolean) => void;
  onOverlayProfilerChange: (checked: boolean) => void;
  onPauseOnPlayChange: (checked: boolean) => void;
  onPreviewBuildChange: (checked: boolean) => void;
  onPlayFromSceneChange: (checked: boolean) => void;
  keepSimulationChanges: boolean;
  onKeepSimulationChangesChange: (checked: boolean) => void;
  /** Starts a Simulation session in the editor viewport. */
  onSimulate: () => void;
  /** Why Simulate cannot start now, or null when it can. */
  simulateUnavailableReason: string | null;
  /** Shown for Feature Test projects only. */
  onRunFeatureTestCheck?: () => void;
};

/** Debug-menu overlay chrome and session checkboxes next to Play. */
export function PlayDebugMenuItems({
  overlayStats,
  overlayConsole,
  overlayInspector,
  overlayProfiler,
  pauseOnPlay,
  previewBuild,
  playFromScene,
  sessionLocked,
  onOverlayStatsChange,
  onOverlayConsoleChange,
  onOverlayInspectorChange,
  onOverlayProfilerChange,
  onPauseOnPlayChange,
  onPreviewBuildChange,
  onPlayFromSceneChange,
  keepSimulationChanges,
  onKeepSimulationChangesChange,
  onSimulate,
  simulateUnavailableReason,
  onRunFeatureTestCheck,
}: PlayDebugMenuItemsProps) {
  return (
    <DropdownMenuContent align="center" className="w-max min-w-60 whitespace-nowrap">
      <DropdownMenuGroup>
        <DropdownMenuLabel>Play</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          data-testid="play-from-scene-toggle"
          checked={playFromScene}
          disabled={sessionLocked}
          onCheckedChange={(checked) =>
            onPlayFromSceneChange(checked === true)
          }
        >
          Play From Current Scene
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-testid="preview-build-toggle"
          checked={previewBuild}
          disabled={sessionLocked}
          onCheckedChange={(checked) =>
            onPreviewBuildChange(checked === true)
          }
        >
          Play As Preview Build
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-testid="pause-on-play-toggle"
          checked={pauseOnPlay}
          onCheckedChange={(checked) => onPauseOnPlayChange(checked === true)}
        >
          Start Paused
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Simulation</DropdownMenuLabel>
        <DropdownMenuItem
          data-testid="simulate-start"
          disabled={sessionLocked || simulateUnavailableReason !== null}
          title={simulateUnavailableReason ?? undefined}
          onClick={onSimulate}
        >
          <MonitorPlayIcon />
          Simulate In Viewport
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          data-testid="keep-simulation-changes-toggle"
          checked={keepSimulationChanges}
          disabled={sessionLocked}
          onCheckedChange={(checked) =>
            onKeepSimulationChangesChange(checked === true)
          }
        >
          Keep Changes On Stop
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Overlay</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          data-testid="overlay-stats-toggle"
          checked={overlayStats}
          onCheckedChange={(checked) => onOverlayStatsChange(checked === true)}
        >
          Stats
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-testid="overlay-console-toggle"
          checked={overlayConsole}
          onCheckedChange={(checked) =>
            onOverlayConsoleChange(checked === true)
          }
        >
          Console
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-testid="overlay-inspector-toggle"
          checked={overlayInspector}
          onCheckedChange={(checked) =>
            onOverlayInspectorChange(checked === true)
          }
        >
          Inspector
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-testid="overlay-profiler-toggle"
          checked={overlayProfiler}
          onCheckedChange={(checked) =>
            onOverlayProfilerChange(checked === true)
          }
        >
          Profiler
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
      {onRunFeatureTestCheck ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              data-testid="feature-test-check-open"
              disabled={sessionLocked}
              onClick={onRunFeatureTestCheck}
            >
              <ClipboardCheckIcon />
              Run Feature Test Check…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </>
      ) : null}
    </DropdownMenuContent>
  );
}
