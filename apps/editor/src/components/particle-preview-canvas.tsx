import { useCallback, useEffect, useRef, useState } from "react";
import type { AbstractEngine } from "@babylonjs/core";
import {
  particleLibraryCompileKey,
  particleLibraryMaterialGuids,
  type ParticleLibrary,
} from "@babylonslate/assets";
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
import { particleLibraryChangeTier } from "../lib/play-particles";
import {
  ParticlePreviewSurface,
  type ParticlePreviewState,
} from "./particle-preview-surface";

/** Trailing pause after the last respawn/rebuild-tier edit (`IDLE_DEBOUNCE_MS` pattern). */
export const PARTICLE_PREVIEW_EDIT_DEBOUNCE_MS = 220;
const STATS_POLL_MS = 250;

type PreviewFailure = Pick<ParticleServiceDiagnostic, "code" | "message">;

function particleLibraryLook(
  library: ParticleLibrary,
): "no-emitters" | "no-material" | "ok" {
  if (library.emitters.size === 0) return "no-emitters";
  return particleLibraryMaterialGuids(library).length > 0 ? "ok" : "no-material";
}

/** A slot-level Material problem explains an empty preview better than a later failure. */
function blockingDiagnostic(
  diagnostics: readonly ParticleServiceDiagnostic[],
): PreviewFailure {
  return (
    diagnostics.find((entry) => entry.code === "particle.missing_material") ??
    diagnostics.find((entry) => entry.code === "particle.unknown_emitter") ??
    diagnostics[0] ?? {
      code: "particle.apply_failed",
      message: "The particle Preview could not start.",
    }
  );
}

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
 * only a different Material set, skybox or Retry starts a new scene.
 */
export function ParticlePreviewCanvas({
  library,
  systemGuid,
  testId,
  showSkybox = false,
  onPickMaterial,
}: {
  library: ParticleLibrary;
  systemGuid: string;
  testId: string;
  showSkybox?: boolean;
  /** Offers Pick Material on the No Material state (Basic emitter preview). */
  onPickMaterial?: () => void;
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

  const libraryRef = useRef(library);
  libraryRef.current = library;
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

  const look = particleLibraryLook(library);
  const libraryKey = particleLibraryCompileKey(library);
  // A resolver knows only the Material documents collected at boot.
  const materialKey = particleLibraryMaterialGuids(library).sort().join(",");

  /** Full-canvas state only when nothing plays; skipped slots become a notice. */
  const evaluate = useCallback(() => {
    const service = serviceRef.current;
    if (!service) return;
    const diagnostics = diagnosticsRef.current;
    if (service.stats().systems === 0) {
      setFailure(blockingDiagnostic(diagnostics));
      setNotice(null);
    } else {
      setFailure(null);
      setNotice(diagnostics[0]?.message ?? null);
    }
  }, []);

  const assign = useCallback(
    (service: ParticleService) => {
      diagnosticsRef.current = [];
      syncRef.current = true;
      try {
        service.handleCommand({
          type: "assignParticle",
          slotId: 0,
          actorGuid: "preview",
          componentId: "preview",
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
      serviceRef.current?.dispose();
      serviceRef.current = null;
      appliedRef.current = null;
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
    const applied = appliedRef.current;
    if (!serviceRef.current || !applied) return;
    const tier = particleLibraryChangeTier(applied, libraryRef.current);
    if (tier === "none") return;
    if (tier === "live" && debounceRef.current === undefined) {
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
  const state = previewState({ look, engine, booted, failure, notice, updating, onPickMaterial, retry });

  return (
    <ParticlePreviewSurface
      state={state}
      paused={paused}
      onPausedChange={onPausedChange}
      onRestart={onRestart}
      stats={stats}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none bg-background"
        data-testid={testId}
      />
    </ParticlePreviewSurface>
  );
}

function previewState(options: {
  look: ReturnType<typeof particleLibraryLook>;
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
