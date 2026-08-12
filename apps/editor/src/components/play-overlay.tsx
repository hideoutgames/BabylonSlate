import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { DEFAULT_PLAY_FRAME_CAP } from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";
import type { Engine } from "@babylonjs/core";
import {
  startPlaySession,
  type PlaySession,
  type PlaySessionResult,
} from "../services/play-session";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import { PrintOverlay, usePrintRegistry } from "./print-overlay";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { SerializedScene } from "@babylonslate/core";
import type { PlayPhysicsSettings } from "../services/play-physics";

export interface PlayOverlayProps {
  sharedEngine: Engine;
  injectFixtureThrow?: boolean;
  scripts?: readonly ScriptBundleEntry[];
  physics?: PlayPhysicsSettings;
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  /** Project `playFrameCap` applied once when the session starts. */
  frameCap?: number;
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
  scripts,
  physics,
  sceneAssetGuid,
  scene,
  frameCap = DEFAULT_PLAY_FRAME_CAP,
  onClose,
}: PlayOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<PlaySession | null>(null);
  const [fps, setFps] = useState(0);
  const [scriptMs, setScriptMs] = useState(0);
  const [physicsMs, setPhysicsMs] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [moveX, setMoveX] = useState<number | null>(null);
  const [actorGuids, setActorGuids] = useState<string[]>([]);
  const { entries: printEntries, print } = usePrintRegistry();
  const printRef = useRef(print);
  printRef.current = print;
  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  const sceneRef = useRef({ sceneAssetGuid, scene });
  sceneRef.current = { sceneAssetGuid, scene };
  const initialFrameCapRef = useRef(frameCap);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const session = startPlaySession({
      canvas,
      sharedEngine,
      injectFixtureThrow,
      scripts: scriptsRef.current,
      physics: physicsRef.current,
      sceneAssetGuid: sceneRef.current.sceneAssetGuid,
      scene: sceneRef.current.scene,
      frameCap: initialFrameCapRef.current,
      onStats: (stats) => {
        setFps(stats.fps);
        setScriptMs(stats.scriptMs);
        setPhysicsMs(stats.physicsMs);
        setMoveX(sessionRef.current?.lastMoveX() ?? null);
      },
      onLog: (message) =>
        setLogs((prev) => [...prev.slice(-200), message]),
      onPrint: (entry) => printRef.current(entry),
    });
    sessionRef.current = session;
    const detachLifecycle = attachLifecyclePause((paused) => {
      sessionRef.current?.setPaused(paused);
    });
    const movePoll = window.setInterval(() => {
      setMoveX(sessionRef.current?.lastMoveX() ?? null);
      setActorGuids([...(sessionRef.current?.spawnedActorGuids() ?? [])]);
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
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground">
        <span data-testid="play-fps">
          <SelectableText>{fps} fps</SelectableText>
        </span>
        <span data-testid="play-script-ms">
          <SelectableText>script {scriptMs.toFixed(2)} ms</SelectableText>
        </span>
        <span data-testid="play-physics-ms">
          <SelectableText>physics {physicsMs.toFixed(2)} ms</SelectableText>
        </span>
        <span
          data-testid="play-move-x"
          data-move-x={moveX === null ? "" : String(moveX)}
        >
          <SelectableText>
            move.x={moveX === null ? "—" : moveX.toFixed(2)}
          </SelectableText>
        </span>
        <span
          data-testid="play-actor-guids"
          data-guids={actorGuids.join(",")}
        />
      </div>
      <Button
        size="touch-icon"
        variant="secondary"
        className="absolute right-3 top-3 z-10"
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
      <PrintOverlay entries={printEntries} />
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
