import { useEffect, useRef, useState } from "react";
import { isTickOverBudget } from "@babylonslate/debugger";
import { SelectableText } from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { cn } from "@babylonslate/ui/lib/utils";

export type StatsHudProps = {
  fps: number;
  scriptMs: number;
  physicsMs: number;
  memoryBytes?: number;
  meshCount?: number;
  textureCount?: number;
  draws?: number;
  bridgeMessagesPerSec?: number;
};

type Sample = { scriptMs: number; physicsMs: number };

const SAMPLE_MS = 200;
const SAMPLE_COUNT = 30;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Play/export stats strip sampled at ~5 Hz, including the tick-budget flag. */
export function StatsHud({
  fps,
  scriptMs,
  physicsMs,
  memoryBytes,
  meshCount,
  textureCount,
  draws,
  bridgeMessagesPerSec,
}: StatsHudProps) {
  const latest = useRef({ scriptMs, physicsMs });
  latest.current = { scriptMs, physicsMs };
  const [samples, setSamples] = useState<Sample[]>([{ scriptMs, physicsMs }]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSamples((prev) => {
        const next = [...prev, latest.current];
        return next.length > SAMPLE_COUNT ? next.slice(-SAMPLE_COUNT) : next;
      });
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, []);

  const overBudget = isTickOverBudget(scriptMs, physicsMs);

  return (
    <div
      className="pointer-events-none flex flex-col gap-1 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground"
      data-testid="stats-hud"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="play-fps">
          <SelectableText>{fps} fps</SelectableText>
        </span>
        <span data-testid="play-script-ms">
          <SelectableText>script {scriptMs.toFixed(2)} ms</SelectableText>
        </span>
        <span data-testid="play-physics-ms">
          <SelectableText>physics {physicsMs.toFixed(2)} ms</SelectableText>
        </span>
        {overBudget ? (
          <Badge
            variant="destructive"
            data-testid="stats-hud-over-budget"
          >
            Over Budget
          </Badge>
        ) : (
          <span data-testid="stats-hud-within-budget">Tick OK</span>
        )}
        {memoryBytes != null ? (
          <span data-testid="stats-hud-memory">
            <SelectableText>mem {formatBytes(memoryBytes)}</SelectableText>
          </span>
        ) : null}
        {meshCount != null ? (
          <span data-testid="stats-hud-meshes">
            <SelectableText>meshes {meshCount}</SelectableText>
          </span>
        ) : null}
        {textureCount != null ? (
          <span data-testid="stats-hud-textures">
            <SelectableText>tex {textureCount}</SelectableText>
          </span>
        ) : null}
        {draws != null ? (
          <span data-testid="stats-hud-draws">
            <SelectableText>draws {draws}</SelectableText>
          </span>
        ) : null}
        {bridgeMessagesPerSec != null ? (
          <span data-testid="stats-hud-bridge">
            <SelectableText>bridge {bridgeMessagesPerSec}/s</SelectableText>
          </span>
        ) : null}
      </div>
      <div
        className="flex h-6 items-end gap-px"
        data-testid="stats-hud-graph"
        aria-hidden
      >
        {samples.map((sample, index) => {
          const total = sample.scriptMs + sample.physicsMs;
          const height = Math.max(2, Math.min(100, (total / 8) * 100));
          return (
            <span
              key={index}
              className={cn(
                "w-1 rounded-sm",
                total > 8 ? "bg-destructive" : "bg-muted-foreground",
              )}
              style={{ height: `${height}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}
