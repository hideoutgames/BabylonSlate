import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { AbstractEngine } from "@babylonjs/core";
import type { GpuBackend } from "@haptic/core";
import { createProjectEngineController } from "../lib/project-engine";
import { RenderingRetryError, retryProjectRendering, stopGameOnDeviceLoss } from "../lib/project-rendering-recovery";
import { waitForSceneLoadingPaint } from "../lib/scene-viewport-load";
import {
  isUsableEngine,
  nextRegisteredSharedEngine,
  nextSharedEngineGeneration,
} from "../lib/shared-engine-generation";
import type { GameSessionOwner, GameSessionState } from "../services/game-session-owner";
import type { PlaySessionResult } from "../services/play-session";
import type { SimulationSession } from "../services/simulation-session";

/**
 * The open project's Engine: its controller follows the project's backend,
 * Retry replaces it after a failure or a lost device, and the shared Engine
 * the editor viewports and Play use is registered here.
 */
export function useProjectRendering({
  projectOpen,
  projectGuid,
  requestedBackend,
  sessionOwner,
  sessionState,
  appendLog,
  simulationRef,
}: {
  projectOpen: boolean;
  projectGuid: string | null;
  requestedBackend: GpuBackend;
  sessionOwner: GameSessionOwner<PlaySessionResult>;
  sessionState: GameSessionState;
  appendLog: (line: string) => void;
  simulationRef: RefObject<SimulationSession | null>;
}) {
  const engineRef = useRef<AbstractEngine | null>(null);
  const ownedEngineRef = useRef<AbstractEngine | null>(null);
  const [projectEngine] = useState(createProjectEngineController);
  const projectEngineState = useSyncExternalStore(projectEngine.subscribe, projectEngine.getSnapshot);
  const [renderingFailureDismissed, setRenderingFailureDismissed] = useState(false);
  const [renderingRetrying, setRenderingRetrying] = useState(false);
  const [renderingRetryFailure, setRenderingRetryFailure] = useState<{ error: unknown; retryable: boolean } | null>(null);
  const [sharedEngineGeneration, setSharedEngineGeneration] = useState(0);
  const projectOpenRef = useRef(projectOpen);
  projectOpenRef.current = projectOpen;

  const registerSharedEngine = useCallback((engine: AbstractEngine | null) => {
    const previous = engineRef.current;
    const next = projectOpenRef.current && projectEngine.getSnapshot().phase !== "ready" ? null : nextRegisteredSharedEngine({
      incoming: engine,
      previous,
      owned: ownedEngineRef.current,
    });
    engineRef.current = isUsableEngine(next) ? next : null;
    setSharedEngineGeneration((current) =>
      nextSharedEngineGeneration(current, engineRef.current, previous),
    );
  }, [projectEngine]);

  const renderingRequest = useMemo(() => projectOpen && projectGuid ? {
    projectGuid,
    backend: requestedBackend,
    async prepare(signal: AbortSignal) {
      await waitForSceneLoadingPaint(signal);
      signal.throwIfAborted();
      return undefined;
    },
  } : null, [projectOpen, projectGuid, requestedBackend]);

  useEffect(() => {
    // A running simulation keeps its Engine. Apply the authored change after Stop.
    if (!sessionOwner.canStart()) return;
    setRenderingFailureDismissed(false);
    void projectEngine.sync(renderingRequest);
  }, [projectEngine, renderingRequest, sessionOwner, sessionState]);

  // A lost device stops the game at once; Retry then only replaces the Engine.
  useEffect(() => stopGameOnDeviceLoss(projectEngine, sessionOwner, {
    simulation: () => simulationRef.current,
    log: appendLog,
  }), [appendLog, projectEngine, sessionOwner, simulationRef]);

  // A retry failure belongs to the controller state it was shown over, and
  // ends once the game it waited for has released.
  useEffect(() => { setRenderingRetryFailure(null); }, [projectEngineState]);
  useEffect(() => {
    if (sessionOwner.canStart()) setRenderingRetryFailure(null);
  }, [sessionOwner, sessionState]);

  const retryRendering = useCallback(async () => {
    setRenderingFailureDismissed(false);
    setRenderingRetryFailure(null);
    setRenderingRetrying(true);
    try {
      await retryProjectRendering({ projectEngine, sessionOwner, request: renderingRequest });
    } catch (error) {
      appendLog(`Rendering could not restart: ${error instanceof Error ? error.message : String(error)}`);
      setRenderingRetryFailure({ error, retryable: !(error instanceof RenderingRetryError) || error.retryable });
    } finally {
      setRenderingRetrying(false);
    }
  }, [appendLog, projectEngine, renderingRequest, sessionOwner]);

  useEffect(() => {
    const engine = projectEngineState.session?.engine ?? null;
    ownedEngineRef.current = engine;
    const previous = engineRef.current;
    const next = isUsableEngine(engine) ? engine : null;
    engineRef.current = next;
    setSharedEngineGeneration((current) =>
      nextSharedEngineGeneration(current, next, previous),
    );
  }, [projectEngineState]);

  const ensureEngine = useCallback((): AbstractEngine | null => {
    const engine = projectEngine.getSnapshot().session?.engine;
    return isUsableEngine(engine) ? engine! : null;
  }, [projectEngine]);

  return {
    engineRef,
    ownedEngineRef,
    projectEngine,
    projectEngineState,
    sharedEngineGeneration,
    registerSharedEngine,
    ensureEngine,
    retryRendering,
    renderingRetrying,
    renderingRetryFailure,
    renderingFailureDismissed,
    setRenderingFailureDismissed,
  };
}
