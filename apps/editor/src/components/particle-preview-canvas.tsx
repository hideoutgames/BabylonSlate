import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AbstractEngine } from "@babylonjs/core";
import {
  particleEmitterMaterialGuid,
  particleLibraryCompileKey,
  particleLibraryMaterialGuids,
  type ParticleLibrary,
  type ParticleLibraryEmitter,
} from "@babylonslate/assets";
import {
  validateParticleGraphDocument,
  type ParticleGraphDocument,
} from "@babylonslate/particle-graph";
import {
  ParticleService,
  acquireMaterialTexture,
  createMaterialPreviewPresenter,
  createParticleMaterialResolver,
  createParticlePreviewScene,
  installTextureBytes,
  resourceCacheForEngine,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
  type ParticlePreviewStats,
  type ParticleServiceDiagnostic,
} from "@babylonslate/render";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import {
  ParticlePreviewSurface,
  type ParticlePreviewState,
} from "./particle-preview-surface";

/** Trailing pause after the last respawn/rebuild-tier edit (`IDLE_DEBOUNCE_MS` pattern). */
export const PARTICLE_PREVIEW_EDIT_DEBOUNCE_MS = 220;
const STATS_POLL_MS = 250;
/** The one component the preview assigns. */
const PREVIEW_ACTOR = "preview";
const PREVIEW_COMPONENT = "preview";

type PreviewFailure = Pick<ParticleServiceDiagnostic, "code" | "message">;
type PreviewLook = "no-emitters" | "no-material" | "graph-errors" | "ok";

function graphErrorCount(entry: ParticleLibraryEmitter): number {
  if (entry.kind !== "graph") return 0;
  return validateParticleGraphDocument(entry.document).filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
}

/**
 * What the preview runs. A Particle Graph with validator errors keeps its last valid
 * build (with its current Material, which only rebinds) so an edit in progress does
 * not blank the preview; a graph that never validated stays as-is and is skipped.
 */
type PreviewLibrary = {
  library: ParticleLibrary;
  look: PreviewLook;
  /** Graphs shown from their last valid build, and their current error total. */
  held: { graphs: number; errors: number };
  lastValid: Map<string, ParticleGraphDocument>;
};

function resolvePreviewLibrary(
  incoming: ParticleLibrary,
  lastValid: ReadonlyMap<string, ParticleGraphDocument>,
): PreviewLibrary {
  const emitters = new Map<string, ParticleLibraryEmitter>();
  const nextValid = new Map<string, ParticleGraphDocument>();
  const held = { graphs: 0, errors: 0 };
  let material = false;
  let playable = false;
  for (const [guid, entry] of incoming.emitters) {
    const errors = graphErrorCount(entry);
    const previous = lastValid.get(guid);
    let shown = entry;
    if (entry.kind === "graph" && errors === 0) nextValid.set(guid, entry.document);
    else if (entry.kind === "graph" && previous) {
      nextValid.set(guid, previous);
      shown = {
        kind: "graph",
        document: { ...previous, materialGuid: entry.document.materialGuid },
      };
      held.graphs += 1;
      held.errors += errors;
    }
    emitters.set(guid, shown);
    if (!particleEmitterMaterialGuid(shown)) continue;
    material = true;
    if (shown !== entry || errors === 0) playable = true;
  }
  const look: PreviewLook =
    emitters.size === 0
      ? "no-emitters"
      : playable
        ? "ok"
        : material
          ? "graph-errors"
          : "no-material";
  return {
    library: held.graphs > 0 ? { emitters, systems: incoming.systems } : incoming,
    look,
    held,
    lastValid: nextValid,
  };
}

function heldNotice(held: PreviewLibrary["held"]): string | null {
  if (held.graphs === 0) return null;
  if (held.graphs > 1) {
    return `${held.graphs} Particle Graphs have errors. Preview shows their last valid builds.`;
  }
  const errors = `${held.errors} ${held.errors === 1 ? "error" : "errors"}`;
  return `Graph has ${errors}. Preview shows the last valid build.`;
}

/** Particle Graphs always simulate on the CPU, which is not the Basic fallback's device note. */
function backendHint(
  library: ParticleLibrary,
  stats: ParticlePreviewStats | null,
): string | undefined {
  if (stats?.backend !== "cpu") return undefined;
  const kinds = new Set([...library.emitters.values()].map((entry) => entry.kind));
  if (!kinds.has("graph")) return undefined;
  return kinds.has("basic")
    ? "GPU particles are unavailable on this device, so Basic Particle Emitters are limited to 512 particles. Particle Graphs always simulate on the CPU."
    : "Particle Graphs simulate on the CPU.";
}

/** A slot-level Material problem explains an empty preview better than a later failure. */
function blockingDiagnostic(
  diagnostics: readonly ParticleServiceDiagnostic[],
): PreviewFailure {
  return (
    diagnostics.find((entry) => entry.code === "particle.missing_material") ??
    diagnostics.find((entry) => entry.code === "particle.unknown_emitter") ??
    diagnostics.find((entry) => entry.code === "particle.graph_invalid") ??
    diagnostics[0] ?? {
      code: "particle.apply_failed",
      message: "The particle Preview could not start.",
    }
  );
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

function sameStats(
  a: ParticlePreviewStats | null,
  b: ParticlePreviewStats | null,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.active === b.active &&
      a.capacity === b.capacity &&
      a.backend === b.backend &&
      a.approximate === b.approximate)
  );
}

/**
 * Particle Preview on the shared Engine. The scene, presenter and service live
 * across edits: `live` changes apply at once, heavier ones after a 220ms pause, and
 * only a different Material set, skybox or Retry starts a new scene. A Particle
 * Graph with errors keeps playing its last valid build.
 */
export function ParticlePreviewCanvas({
  library: incoming,
  systemGuid,
  testId,
  showSkybox = false,
  onPickMaterial,
  onDiagnostics,
}: {
  library: ParticleLibrary;
  systemGuid: string;
  testId: string;
  showSkybox?: boolean;
  /** Offers Pick Material on the No Material state (Basic emitter preview). */
  onPickMaterial?: () => void;
  /**
   * The current run's service diagnostics (skipped slots and node-anchored Particle
   * Graph build errors), reported whenever they change; empty when the run ends.
   * `applied` is the library that run was built from, which can trail `library`
   * while a debounced edit waits.
   */
  onDiagnostics?: (
    diagnostics: readonly ParticleServiceDiagnostic[],
    applied: ParticleLibrary,
  ) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const { collectPlayMaterialLibrary, collectPlayTextureBytes } = useDocuments();
  const [engine, setEngine] = useState<AbstractEngine | null>(null);
  const [booted, setBooted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<PreviewFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [stats, setStats] = useState<ParticlePreviewStats | null>(null);

  // Everything below reads the resolved library, so a held graph never reaches the service.
  // Stats polling re-renders with the same library, which then skips validation.
  const lastValidRef = useRef<ReadonlyMap<string, ParticleGraphDocument>>(new Map());
  const resolved = useMemo(
    () => resolvePreviewLibrary(incoming, lastValidRef.current),
    [incoming],
  );
  lastValidRef.current = resolved.lastValid;
  const { library, look } = resolved;
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const onDiagnosticsRef = useRef(onDiagnostics);
  onDiagnosticsRef.current = onDiagnostics;
  const pausedRef = useRef(paused);
  const serviceRef = useRef<ParticleService | null>(null);
  const appliedRef = useRef<ParticleLibrary | null>(null);
  const diagnosticsRef = useRef<ParticleServiceDiagnostic[]>([]);
  /** True while a service call reports synchronously; the caller evaluates after it. */
  const syncRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  const libraryKey = useMemo(() => particleLibraryCompileKey(library), [library]);
  // A resolver knows only the Material documents collected at boot.
  const materialKey = particleLibraryMaterialGuids(library).sort().join(",");

  /**
   * Full-canvas state only when the run failed; skipped slots become a notice. A
   * finished Once emitter releases its systems but stays ready for Restart.
   */
  const evaluate = useCallback(() => {
    const service = serviceRef.current;
    if (!service) return;
    const diagnostics = diagnosticsRef.current;
    const state = service.playbackState(PREVIEW_ACTOR, PREVIEW_COMPONENT);
    if (state === null || state === "failed") {
      setFailure(blockingDiagnostic(diagnostics));
      setNotice(null);
    } else {
      setFailure(null);
      setNotice(diagnostics[0]?.message ?? null);
    }
    const applied = appliedRef.current;
    if (applied) onDiagnosticsRef.current?.([...diagnostics], applied);
  }, []);

  const assign = useCallback(
    (service: ParticleService) => {
      diagnosticsRef.current = [];
      syncRef.current = true;
      try {
        service.handleCommand({
          type: "assignParticle",
          slotId: 0,
          actorGuid: PREVIEW_ACTOR,
          componentId: PREVIEW_COMPONENT,
          particleSystemGuid: systemGuid,
          play: true,
        });
      } finally {
        syncRef.current = false;
      }
      evaluate();
    },
    [evaluate, systemGuid],
  );

  const applyLibrary = useCallback(
    (next: ParticleLibrary) => {
      const service = serviceRef.current;
      if (!service) return;
      const previous = diagnosticsRef.current;
      diagnosticsRef.current = [];
      syncRef.current = true;
      let tier: ReturnType<ParticleService["updateLibrary"]>["tier"];
      try {
        tier = service.updateLibrary(next).tier;
      } finally {
        syncRef.current = false;
      }
      appliedRef.current = next;
      // Only a re-prepare reports slot problems again.
      if (tier !== "rebuild") diagnosticsRef.current = [...previous, ...diagnosticsRef.current];
      evaluate();
    },
    [evaluate],
  );

  useEffect(() => {
    if (look !== "ok") return;
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    let cancelled = false;
    let host: MaterialPreviewScene | null = null;
    let presenter: MaterialPreviewPresenter | null = null;
    let materials: ReturnType<typeof createParticleMaterialResolver> | null = null;
    let frame = 0;
    const disposePreview = () => {
      const applied = appliedRef.current;
      serviceRef.current?.dispose();
      serviceRef.current = null;
      appliedRef.current = null;
      if (diagnosticsRef.current.length > 0) {
        diagnosticsRef.current = [];
        if (applied) onDiagnosticsRef.current?.([], applied);
      }
      materials?.dispose();
      materials = null;
      presenter?.dispose();
      presenter = null;
      host?.dispose();
      host = null;
    };
    setFailure(null);
    setNotice(null);
    setUpdating(true);
    void (async () => {
      const guids = materialKey ? materialKey.split(",") : [];
      const docs = collectPlayMaterialLibrary
        ? await collectPlayMaterialLibrary(undefined, [], guids)
        : { documents: new Map(), functions: new Map(), textureGuids: [] };
      // Emitters have no Texture; Texture Sample nodes read the Material's textures.
      const bytes = collectPlayTextureBytes
        ? await collectPlayTextureBytes(new Map(), new Map(), docs.textureGuids)
        : new Map<string, Uint8Array>();
      if (cancelled) return;
      const sources = installTextureBytes(bytes) ?? new Map();
      const cache = resourceCacheForEngine(engine);
      host = createParticlePreviewScene(engine, { skybox: showSkybox });
      presenter = createMaterialPreviewPresenter(host, canvas);
      materials = createParticleMaterialResolver({
        scene: host.scene,
        documents: docs.documents,
        functions: docs.functions,
        acquireTexture: (guid) => {
          const data = sources.get(guid);
          return data ? acquireMaterialTexture(cache, guid, engine, data) : null;
        },
      });
      const service = new ParticleService({
        scene: host.scene,
        acquireMaterial: materials.acquire,
        statsScope: "local",
        onDiagnostic: (diagnostic) => {
          diagnosticsRef.current.push(diagnostic);
          // Async Material failures arrive after the assign returned.
          if (!syncRef.current && !cancelled) evaluate();
        },
      });
      service.setPaused(pausedRef.current);
      const current = libraryRef.current;
      service.setLibrary(current);
      serviceRef.current = service;
      appliedRef.current = current;
      assign(service);
      presenter.present();
      setBooted(true);
      setUpdating(false);
      const tick = () => {
        presenter?.present();
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    })().catch((error: unknown) => {
      disposePreview();
      if (!cancelled) {
        setFailure({
          code: "particle.apply_failed",
          message:
            error instanceof Error ? error.message : "The particle Preview could not load.",
        });
        setBooted(true);
        setUpdating(false);
      }
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
      disposePreview();
    };
  }, [
    assign,
    attempt,
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    engine,
    evaluate,
    look,
    materialKey,
    showSkybox,
  ]);

  useEffect(() => {
    const service = serviceRef.current;
    if (!service || !appliedRef.current) return;
    // Only the service knows skipped slots: a value edit that re-prepares one waits too.
    const tier = service.libraryChangeTier(libraryRef.current);
    if ((tier === "none" || tier === "live") && debounceRef.current === undefined) {
      // A `none` edit still reaches the service, so Restart replays a released run with it.
      applyLibrary(libraryRef.current);
      return;
    }
    clearTimeout(debounceRef.current);
    setUpdating(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      setUpdating(false);
      applyLibrary(libraryRef.current);
    }, PARTICLE_PREVIEW_EDIT_DEBOUNCE_MS);
  }, [applyLibrary, libraryKey]);

  useEffect(() => {
    if (!booted || failure) {
      setStats(null);
      return;
    }
    const poll = () => {
      const next = serviceRef.current?.previewStats() ?? null;
      setStats((previous) => (sameStats(previous, next) ? previous : next));
    };
    poll();
    const timer = window.setInterval(poll, STATS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [booted, failure]);

  const onPausedChange = (next: boolean) => {
    pausedRef.current = next;
    setPaused(next);
    serviceRef.current?.setPaused(next);
  };

  const onRestart = () => {
    const service = serviceRef.current;
    if (!service) return;
    // A pending edit joins the restart instead of rebuilding it again.
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
      setUpdating(false);
    }
    service.setLibrary(libraryRef.current);
    appliedRef.current = libraryRef.current;
    assign(service);
  };

  const retry = () => setAttempt((value) => value + 1);
  const state = previewState({
    look,
    engine,
    booted,
    failure,
    notice: heldNotice(resolved.held) ?? notice,
    updating,
    onPickMaterial,
    retry,
  });

  return (
    <ParticlePreviewSurface
      state={state}
      paused={paused}
      onPausedChange={onPausedChange}
      onRestart={onRestart}
      stats={stats}
      backendHint={backendHint(library, stats)}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none bg-background"
        data-testid={testId}
      />
    </ParticlePreviewSurface>
  );
}

const GRAPH_ERRORS_TITLE = "Graph Has Errors";
const GRAPH_ERRORS_TEST_ID = "particle-preview-graph-errors";

function previewState(options: {
  look: PreviewLook;
  engine: AbstractEngine | null;
  booted: boolean;
  failure: PreviewFailure | null;
  notice: string | null;
  updating: boolean;
  onPickMaterial?: () => void;
  retry: () => void;
}): ParticlePreviewState {
  const { look, failure, onPickMaterial, retry } = options;
  const pickMaterial = onPickMaterial
    ? { label: "Pick Material", onClick: onPickMaterial }
    : undefined;
  if (look === "no-emitters") {
    return {
      status: "empty",
      title: "Missing Emitter",
      description: "A slot references an emitter that could not be loaded.",
    };
  }
  if (look === "no-material") {
    return {
      status: "empty",
      title: "No Material",
      description: "Pick a particle Material to preview this emitter.",
      action: pickMaterial,
    };
  }
  if (look === "graph-errors") {
    // Only graphs that never validated in this preview land here; others keep their last build.
    return {
      status: "empty",
      title: GRAPH_ERRORS_TITLE,
      description: "Fix the errors in the Particle Graph's Compiler Results to preview.",
      testId: GRAPH_ERRORS_TEST_ID,
    };
  }
  if (!options.engine || !options.booted) return { status: "loading" };
  if (failure?.code === "particle.missing_material") {
    return {
      status: "error",
      title: "No Material",
      description: failure.message,
      action: pickMaterial,
      onRetry: retry,
      testId: "particle-preview-empty",
    };
  }
  if (failure?.code === "particle.unknown_emitter") {
    return {
      status: "error",
      title: "Missing Emitter",
      description: failure.message,
      onRetry: retry,
      testId: "particle-preview-empty",
    };
  }
  if (failure?.code === "particle.graph_invalid") {
    return {
      status: "error",
      title: GRAPH_ERRORS_TITLE,
      description: failure.message,
      onRetry: retry,
      testId: GRAPH_ERRORS_TEST_ID,
    };
  }
  if (failure?.code.startsWith("particle.compile.")) {
    return {
      status: "error",
      description: `${sentence(failure.message)} Check the Particle Graph's Compiler Results.`,
      onRetry: retry,
    };
  }
  if (failure) {
    return {
      status: "error",
      description: `${failure.message} Check the emitter settings in Details.`,
      onRetry: retry,
    };
  }
  return {
    status: "ready",
    notice: options.notice ?? undefined,
    updating: options.updating,
  };
}
