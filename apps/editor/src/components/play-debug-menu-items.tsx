import { useState } from "react";
import type { TraceDocumentEntry } from "@haptic/assets";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@haptic/ui/components/dropdown-menu";
import {
  ClipboardCheckIcon,
  HistoryIcon,
  LayersIcon,
  MonitorPlayIcon,
  PackageIcon,
  PlayIcon,
} from "lucide-react";

/** What the Play button starts. */
export type PlayLaunchMode = "play" | "preview" | "simulate";

export type PlayDebugMenuItemsProps = {
  mode: PlayLaunchMode;
  onModeChange: (mode: PlayLaunchMode) => void;
  /** Why Simulate cannot start now, or null when it can. */
  simulateUnavailableReason: string | null;
  overlayStats: boolean;
  overlayConsole: boolean;
  overlayInspector: boolean;
  overlayProfiler: boolean;
  pauseOnPlay: boolean;
  playFromScene: boolean;
  sessionLocked: boolean;
  onOverlayStatsChange: (checked: boolean) => void;
  onOverlayConsoleChange: (checked: boolean) => void;
  onOverlayInspectorChange: (checked: boolean) => void;
  onOverlayProfilerChange: (checked: boolean) => void;
  onPauseOnPlayChange: (checked: boolean) => void;
  onPlayFromSceneChange: (checked: boolean) => void;
  /** Shown for Feature Test projects only. */
  onRunFeatureTestCheck?: () => void;
  /** The project's recorded traces, newest first; with `onOpenTrace`, shows Recent Traces. */
  listRecentTraces?: () => Promise<readonly TraceDocumentEntry[]>;
  onOpenTrace?: (path: string) => void;
};

/** How many recorded traces Recent Traces lists. */
const RECENT_TRACE_COUNT = 10;

const traceTime = (entry: TraceDocumentEntry) => entry.recordedAt === null ? entry.fileName : new Date(entry.recordedAt).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** The newest recorded traces, read again each time the submenu opens. */
function RecentTracesSubmenu({ list, onOpen }: { list: () => Promise<readonly TraceDocumentEntry[]>; onOpen: (path: string) => void }) {
  const [traces, setTraces] = useState<readonly TraceDocumentEntry[] | null>(null);
  return (
    <DropdownMenuSub onOpenChange={(open) => {
      if (!open) return;
      setTraces(null);
      void list().then((entries) => setTraces(entries.slice(0, RECENT_TRACE_COUNT)), () => setTraces([]));
    }}>
      <DropdownMenuSubTrigger data-testid="recent-traces-submenu">
        <HistoryIcon />
        Recent Traces
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-max min-w-48 whitespace-nowrap">
        {traces === null ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          : traces.length === 0 ? <DropdownMenuItem disabled>No Recorded Traces</DropdownMenuItem>
            : traces.map((trace) => (
              <DropdownMenuItem key={trace.path} data-testid="recent-trace" onClick={() => onOpen(trace.path)}>
                {traceTime(trace)}
              </DropdownMenuItem>
            ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The Debug menu next to Play: what Play starts, how it starts, and the in-game overlays. */
export function PlayDebugMenuItems({
  mode,
  onModeChange,
  simulateUnavailableReason,
  overlayStats,
  overlayConsole,
  overlayInspector,
  overlayProfiler,
  pauseOnPlay,
  playFromScene,
  sessionLocked,
  onOverlayStatsChange,
  onOverlayConsoleChange,
  onOverlayInspectorChange,
  onOverlayProfilerChange,
  onPauseOnPlayChange,
  onPlayFromSceneChange,
  onRunFeatureTestCheck,
  listRecentTraces,
  onOpenTrace,
}: PlayDebugMenuItemsProps) {
  return (
    <DropdownMenuContent align="center" className="w-max min-w-52 whitespace-nowrap">
      <DropdownMenuGroup>
        <DropdownMenuLabel>Play Mode</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => onModeChange(value as PlayLaunchMode)}
        >
          <DropdownMenuRadioItem value="play" disabled={sessionLocked} data-testid="play-mode-play">
            <PlayIcon />
            Play
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="preview" disabled={sessionLocked} data-testid="preview-build-toggle">
            <PackageIcon />
            Preview Build
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="simulate"
            disabled={sessionLocked || (simulateUnavailableReason !== null && mode !== "simulate")}
            title={simulateUnavailableReason ?? undefined}
            data-testid="play-mode-simulate"
          >
            <MonitorPlayIcon />
            Simulate
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuCheckboxItem
          data-testid="play-from-scene-toggle"
          checked={playFromScene}
          disabled={sessionLocked || mode === "simulate"}
          onCheckedChange={(checked) => onPlayFromSceneChange(checked === true)}
        >
          Start In Open Scene
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
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="play-overlays-submenu">
          <LayersIcon />
          Overlays
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-max min-w-40 whitespace-nowrap">
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
            onCheckedChange={(checked) => onOverlayConsoleChange(checked === true)}
          >
            Console
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            data-testid="overlay-inspector-toggle"
            checked={overlayInspector}
            onCheckedChange={(checked) => onOverlayInspectorChange(checked === true)}
          >
            Inspector
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            data-testid="overlay-profiler-toggle"
            checked={overlayProfiler}
            onCheckedChange={(checked) => onOverlayProfilerChange(checked === true)}
          >
            Profiler
          </DropdownMenuCheckboxItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {listRecentTraces && onOpenTrace ? <RecentTracesSubmenu list={listRecentTraces} onOpen={onOpenTrace} /> : null}
      {onRunFeatureTestCheck ? (
        <DropdownMenuItem
          data-testid="feature-test-check-open"
          disabled={sessionLocked}
          onClick={onRunFeatureTestCheck}
        >
          <ClipboardCheckIcon />
          Run Feature Test Check…
        </DropdownMenuItem>
      ) : null}
    </DropdownMenuContent>
  );
}
