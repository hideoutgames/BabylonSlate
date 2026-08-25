import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@babylonslate/ui/components/dropdown-menu";

export type PlayDebugMenuItemsProps = {
  overlayStats: boolean;
  overlayConsole: boolean;
  overlayInspector: boolean;
  pauseOnPlay: boolean;
  previewBuild: boolean;
  playFromScene: boolean;
  sessionLocked: boolean;
  onOverlayStatsChange: (checked: boolean) => void;
  onOverlayConsoleChange: (checked: boolean) => void;
  onOverlayInspectorChange: (checked: boolean) => void;
  onPauseOnPlayChange: (checked: boolean) => void;
  onPreviewBuildChange: (checked: boolean) => void;
  onPlayFromSceneChange: (checked: boolean) => void;
};

/** Debug-menu overlay chrome and session checkboxes next to Play. */
export function PlayDebugMenuItems({
  overlayStats,
  overlayConsole,
  overlayInspector,
  pauseOnPlay,
  previewBuild,
  playFromScene,
  sessionLocked,
  onOverlayStatsChange,
  onOverlayConsoleChange,
  onOverlayInspectorChange,
  onPauseOnPlayChange,
  onPreviewBuildChange,
  onPlayFromSceneChange,
}: PlayDebugMenuItemsProps) {
  return (
    <DropdownMenuContent align="center">
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
    </DropdownMenuContent>
  );
}
