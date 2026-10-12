import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@babylonslate/ui/components/dropdown-menu";

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
  onRunFeatureTestCheck,
}: PlayDebugMenuItemsProps) {
  return (
    <DropdownMenuContent align="center" className="w-max min-w-56 whitespace-nowrap">
      <DropdownMenuGroup>
        <DropdownMenuLabel>Play Overlay</DropdownMenuLabel>
        <DropdownMenuSeparator />
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
      <DropdownMenuGroup>
        <DropdownMenuLabel>Session</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          data-testid="pause-on-play-toggle"
          checked={pauseOnPlay}
          onCheckedChange={(checked) => onPauseOnPlayChange(checked === true)}
        >
          Pause On Play
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-testid="preview-build-toggle"
          checked={previewBuild}
          disabled={sessionLocked}
          onCheckedChange={(checked) =>
            onPreviewBuildChange(checked === true)
          }
        >
          Preview Build
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-testid="play-from-scene-toggle"
          checked={playFromScene}
          disabled={sessionLocked}
          onCheckedChange={(checked) =>
            onPlayFromSceneChange(checked === true)
          }
        >
          Play from Scene
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
      {onRunFeatureTestCheck ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Feature Test</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="feature-test-check-open"
            disabled={sessionLocked}
            onClick={onRunFeatureTestCheck}
          >
            Run Feature Test Check…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      ) : null}
    </DropdownMenuContent>
  );
}
