import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";
import type { Engine } from "@babylonjs/core";
import {
  startPlaySession,
  type PlaySession,
  type PlaySessionResult,
} from "../services/play-session";
import { attachLifecyclePause } from "../services/lifecycle-pause";

export interface PlayOverlayProps {
  sharedEngine: Engine;
  injectFixtureThrow?: boolean;
  onClose: (result: PlaySessionResult) => void;
}

function emptyPlayResult(): PlaySessionResult {
  return {
    diagnostics: [],
    droppedDiagnostics: 0,
    textureCountBefore: 0,
    textureCountAfter: 0,
    textureLeak: false,
    runtimeMode: "in-process",
  };
}

export function PlayOverlay({
  sharedEngine,
  injectFixtureThrow,
  onClose,
}: PlayOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<PlaySession | null>(null);
  const [fps, setFps] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [moveX, setMoveX] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const session = startPlaySession({
      canvas,
      sharedEngine,
      injectFixtureThrow,
      onStats: (stats) => {
        setFps(stats.fps);
        setMoveX(sessionRef.current?.lastMoveX() ?? null);
      },
      onLog: (message) =>
        setLogs((prev) => [...prev.slice(-200), message]),
    });
    sessionRef.current = session;
    const detachLifecycle = attachLifecyclePause((paused) => {
      sessionRef.current?.setPaused(paused);
    });
    const movePoll = window.setInterval(() => {
      setMoveX(sessionRef.current?.lastMoveX() ?? null);
    }, 100);
    return () => {
      window.clearInterval(movePoll);
      detachLifecycle();
      if (sessionRef.current) {
        sessionRef.current.stop();
        sessionRef.current = null;
      }
    };
  }, [sharedEngine, injectFixtureThrow]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      data-testid="play-overlay"
    >
      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground">
        <span data-testid="play-fps">
          <SelectableText>{fps} fps</SelectableText>
        </span>
        <span
          className="ml-2"
          data-testid="play-move-x"
          data-move-x={moveX === null ? "" : String(moveX)}
        >
          <SelectableText>
            move.x={moveX === null ? "—" : moveX.toFixed(2)}
          </SelectableText>
        </span>
      </div>
      <Button
        size="icon"
        variant="secondary"
        className="absolute right-3 top-3 z-10 min-h-11 min-w-11"
        data-testid="play-overlay-close"
        aria-label="Stop Play"
        onClick={() => {
          const result = sessionRef.current?.stop() ?? emptyPlayResult();
          sessionRef.current = null;
          onClose(result);
        }}
      >
        <XIcon />
      </Button>
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        data-testid="play-canvas"
      />
      <div
        className="pointer-events-none absolute bottom-3 left-3 max-h-32 max-w-md overflow-hidden rounded-md bg-background/80 p-2 text-xs"
        data-testid="play-log-tail"
      >
        {logs.slice(-5).map((line, i) => (
          <div key={`${i}-${line}`}>
            <SelectableText>{line}</SelectableText>
          </div>
        ))}
      </div>
    </div>
  );
}
