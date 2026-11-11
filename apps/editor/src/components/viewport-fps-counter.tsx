import { cn } from "@haptic/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";
import { FPS_UPDATE_MS, FPS_WINDOW_MS, fpsTone, framesPerSecond, type FpsTone, type FrameSample } from "../lib/viewport-fps";

const TONE_CLASS: Record<FpsTone, string> = {
  good: "text-green-400",
  fair: "text-yellow-300",
  poor: "text-orange-500",
  bad: "text-red-500",
};

/**
 * The View menu's **Show FPS** readout: frames the viewport rendered per second, right-aligned under the toolbar
 * island. Reads the view's render scheduler, so it counts this viewport's frames only.
 */
export function ViewportFpsCounter({
  scheduler,
  className,
  testId = "viewport-fps",
}: {
  /** The viewport's render scheduler, or null while its Engine is not running. */
  scheduler: () => { stats(): { renderedFrames: number } } | null | undefined;
  className?: string;
  testId?: string;
}) {
  const { showFps } = useEditorViewportPrefs();
  const [fps, setFps] = useState<number | null>(null);
  // Hosts pass a fresh getter each render; reading it through a ref keeps the samples across renders.
  const schedulerRef = useRef(scheduler);
  schedulerRef.current = scheduler;

  useEffect(() => {
    if (!showFps) {
      setFps(null);
      return;
    }
    let samples: FrameSample[] = [];
    const sample = () => {
      const stats = schedulerRef.current()?.stats();
      if (!stats) {
        samples = [];
        setFps(null);
        return;
      }
      const at = performance.now();
      // A new Engine starts its count again; drop samples from the previous one.
      if (samples.length > 0 && stats.renderedFrames < samples[samples.length - 1]!.frames) samples = [];
      samples.push({ at, frames: stats.renderedFrames });
      while (samples.length > 2 && at - samples[1]!.at >= FPS_WINDOW_MS) samples.shift();
      setFps(framesPerSecond(samples));
    };
    sample();
    const timer = window.setInterval(sample, FPS_UPDATE_MS);
    return () => window.clearInterval(timer);
  }, [showFps]);

  if (!showFps || fps === null) return null;
  const tone = fpsTone(fps);
  return (
    <div
      className={cn(
        "pointer-events-none rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[11px] leading-4 font-semibold tabular-nums",
        TONE_CLASS[tone],
        className,
      )}
      data-testid={testId}
      data-tone={tone}
    >
      {fps} FPS
    </div>
  );
}
